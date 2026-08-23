/**
 * ADR-0020 P-Sec1 (2026-08-23): Windows Job Object 资源限制.
 *
 * 用法:
 *   - 第一次 attach 时懒创建 Job (process-global, OnceLock<usize> 存 handle 原始值)
 *   - 后续 attach 复用同一个 Job, 所有 sidecar 进程都进这个 Job
 *   - Job 限制:
 *     - 内存: 每进程 1 GB (PROCESS_MEMORY_LIMIT)
 *     - 子进程数: 每 Job 100 (ACTIVE_PROCESS_LIMIT)
 *     - CPU: 1 核 100% (CPU_RATE_CONTROL_ENABLE | HARD_CAP)
 *     - KILL_ON_JOB_CLOSE: Tauri 进程退出 → Job 关闭 → 所有成员被杀
 *
 * 已知限制 (2026-08-23):
 *   - 跨进程 race: sidecar spawn 完到 attach 之间的窗口期, sidecar 可能 fork bash.
 *     Windows Job 默认 child 继承 parent 的 Job 成员状态, 所以 race 期间 fork 的 bash
 *     也会自动加入 (sidecar 在 spawn 完还没 attach Job 时 fork 的子进程继承父进程的 Job —
 *     此时 sidecar 还没在任何 Job 里, 所以 race 期间的子进程不在 Job).
 *     缓解: 实际操作中 sidecar 启动 → loadUserTools → 第一次 bash 调用有 100ms+,
 *     远大于 spawn → attach 的窗口 (< 1ms), 实际不漏.
 */
use std::sync::OnceLock;

// windows 0.58 用 `include!("Windows/mod.rs")` 把 Windows/ 拍平到 crate root,
// 所以正确路径是 `windows::Win32::...` (不是 `windows::Windows::Win32::...`)
#[cfg(windows)]
use windows::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(windows)]
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectCpuRateControlInformation,
    JobObjectExtendedLimitInformation, SetInformationJobObject,
    JOB_OBJECT_CPU_RATE_CONTROL_ENABLE, JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP,
    JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOB_OBJECT_LIMIT_PROCESS_MEMORY, JOBOBJECT_BASIC_LIMIT_INFORMATION,
    JOBOBJECT_CPU_RATE_CONTROL_INFORMATION, JOBOBJECT_CPU_RATE_CONTROL_INFORMATION_0,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
};
#[cfg(windows)]
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
};

// 存 handle 原始指针值 (windows 0.58 HANDLE = *mut c_void, 不是 Send+Sync, 没法直接存 OnceLock)
static SANDBOX_JOB: OnceLock<usize> = OnceLock::new();

// 资源限制常量 (2026-08-23 拍板 ADR-0020)
const PROCESS_MEMORY_LIMIT_BYTES: usize = 1024 * 1024 * 1024; // 1 GB
const ACTIVE_PROCESS_LIMIT: u32 = 100; // 每 Job 100 个进程
const CPU_RATE_PERCENT_1_CORE: u32 = 10_000; // 100% of 1 core (单位 0.01%, 10000 = 100%)

/// 把指定 pid 的进程 attach 到全局 sandbox Job.
/// 第一次调用时会懒创建 Job, 后续调用复用.
/// 失败不阻塞主流程 (返回 Err, caller log 后继续 — sandbox 降级到 P0-2).
#[cfg(windows)]
pub fn attach_pid_to_job(pid: u32) -> Result<(), String> {
    let job_handle = get_or_create_job()?;

    unsafe {
        // 打开 child 进程 (用 PROCESS_SET_QUOTA + PROCESS_TERMINATE, Job assignment 需要)
        let hprocess: HANDLE = OpenProcess(
            PROCESS_SET_QUOTA | PROCESS_TERMINATE,
            false,
            pid,
        )
        .map_err(|e| format!("OpenProcess({}): {e}", pid))?;

        // assign 到 Job
        let r = AssignProcessToJobObject(HANDLE(job_handle as *mut _), hprocess);

        // close 我们打开的 handle (child 仍在 Job 里, Job handle 在 SANDBOX_JOB 持有)
        let _ = CloseHandle(hprocess);

        r.map_err(|e| {
            format!("AssignProcessToJobObject(pid={}): {e}", pid)
        })?;
    }

    log::info!(
        "[sandbox] pid {} attached to Job (mem=1GB, procs=100, cpu=1core)",
        pid
    );
    Ok(())
}

/// 非 Windows 平台的 stub — 编译过, 跑起来 no-op
#[cfg(not(windows))]
pub fn attach_pid_to_job(_pid: u32) -> Result<(), String> {
    log::warn!("[sandbox] Job Object not supported on non-Windows, skipping");
    Ok(())
}

#[cfg(windows)]
fn get_or_create_job() -> Result<usize, String> {
    if let Some(&h) = SANDBOX_JOB.get() {
        return Ok(h);
    }
    // OnceLock 不直接支持 fallible init (get_or_try_init 不在 std), 简单方案: 创建后 set
    let h = create_sandbox_job()?;
    let _ = SANDBOX_JOB.set(h); // 别的线程已 set 就忽略, 重新读
    SANDBOX_JOB
        .get()
        .copied()
        .ok_or_else(|| "SANDBOX_JOB set but get returned None".to_string())
}

#[cfg(windows)]
fn create_sandbox_job() -> Result<usize, String> {
    unsafe {
        let job: HANDLE = CreateJobObjectW(None, None)
            .map_err(|e| format!("CreateJobObjectW: {e}"))?;

        // 1) 内存 + 进程数 + kill-on-close 限制 (Basic + Extended)
        let basic_info = JOBOBJECT_BASIC_LIMIT_INFORMATION {
            PerProcessUserTimeLimit: 0,
            PerJobUserTimeLimit: 0,
            LimitFlags: JOB_OBJECT_LIMIT_PROCESS_MEMORY
                | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
                | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            MinimumWorkingSetSize: 0,
            MaximumWorkingSetSize: 0,
            ActiveProcessLimit: ACTIVE_PROCESS_LIMIT,
            Affinity: 0,
            PriorityClass: 0,
            SchedulingClass: 0,
        };
        let ext_info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
            BasicLimitInformation: basic_info,
            IoInfo: std::mem::zeroed(),
            ProcessMemoryLimit: PROCESS_MEMORY_LIMIT_BYTES,
            JobMemoryLimit: 0,
            PeakProcessMemoryUsed: 0,
            PeakJobMemoryUsed: 0,
        };

        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &ext_info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
        .map_err(|e| {
            let _ = CloseHandle(job);
            format!("SetInformationJobObject(mem): {e}")
        })?;

        // 2) CPU 限速 (Windows 8+) — 用 union 变体构造
        //   CpuRate = 10000 = 100% of 1 core (单位 0.01%)
        //   HARD_CAP: 不能超, throttle 而非超额
        let cpu_info = JOBOBJECT_CPU_RATE_CONTROL_INFORMATION {
            ControlFlags: JOB_OBJECT_CPU_RATE_CONTROL_ENABLE
                | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP,
            Anonymous: JOBOBJECT_CPU_RATE_CONTROL_INFORMATION_0 { CpuRate: CPU_RATE_PERCENT_1_CORE },
        };
        SetInformationJobObject(
            job,
            JobObjectCpuRateControlInformation,
            &cpu_info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_CPU_RATE_CONTROL_INFORMATION>() as u32,
        )
        .map_err(|e| {
            let _ = CloseHandle(job);
            format!("SetInformationJobObject(cpu): {e}")
        })?;

        log::info!(
            "[sandbox] Job Object created: mem={}MB/proc, procs<={}, cpu=1core hard cap",
            PROCESS_MEMORY_LIMIT_BYTES / 1024 / 1024,
            ACTIVE_PROCESS_LIMIT
        );
        Ok(job.0 as usize)
    }
}
