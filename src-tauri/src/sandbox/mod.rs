/**
 * ADR-0020 P-Sec1 (2026-08-23): 沙箱加固 — Windows OS 层.
 *
 * 当前阶段只做 P-Sec1 (Job Object 资源限制 + 审计日志).
 * P-Sec2 (AppContainer filesystem) 见 ADR-0020, 后续阶段实施.
 *
 * Job Object 关键设计 (为啥 Tauri sidecar 启动时 attach 一个全局 Job 就够):
 *   - Job Object 是 Windows 内核对象, 一个进程一旦 assign, 它的所有后代进程自动属于这个 Job
 *   - Job 设的 PROCESS_MEMORY_LIMIT / ACTIVE_PROCESS_LIMIT 对所有成员生效 (per-process, 不是 per-Job)
 *   - KILL_ON_JOB_CLOSE: Job handle 关闭时, 所有成员自动被杀 (Tauri 退 → sidecar 自动退)
 *   - 我们的策略: Tauri 进程持有一个全局 Job, 每次 sidecar spawn 完就 `attach_pid_to_job(pid)`
 *   - 即使 sidecar 立即 fork bash (e.g. createBashToolDefinition), bash 自动继承 Job 成员
 *
 * 跟 Pi SDK 的集成:
 *   - 零侵入 — 不改 `createBashToolDefinition`, 不改 sidecar JS
 *   - 限制在 OS 进程层, LLM / Pi SDK 完全感知不到
 */
pub mod job_object;

// P-Sec2 后续启用
// pub mod app_container;

pub use job_object::attach_pid_to_job;
