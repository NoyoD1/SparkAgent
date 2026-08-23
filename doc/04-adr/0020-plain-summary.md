# ADR-0020 白话版 — 沙箱加固 (挡 DoS + 挡越权读)

> 配套 [0020-sandbox-hardening.md](0020-sandbox-hardening.md) 的简化说明.
> 这份只讲 "做什么 / 为什么 / 多大工作量", 不讲架构细节.

---

## 一句话总结

P0-2 的 deny list 挡了 80% 日常坑, 但挡不住 LLM 给的"用 python 跑删文件" / 无限循环 / 读 `~/.ssh` 之类的攻击. 我们要加 **操作系统层** 的两道墙: **Job Object** 挡 DoS, **AppContainer** 挡越权读.

---

## 为什么要做 (P0-2 留的洞)

| 风险 | P0-2 现状 | 加固后 |
|---|---|---|
| LLM 写个无限循环 / fork bomb | ❌ 整台机器卡死 | ✅ 进程被自动 kill |
| LLM 给个 `python -c "os.system('rm -rf /')"` | ❌ deny list 看不到 (只看命令字符串) | ✅ 操作系统层挡 (filesystem 不可见根目录) |
| LLM 读 `~/.ssh/id_rsa` | ❌ 随便读 | ✅ bash 进程根本看不到那个目录 |
| 误操作后查"谁干的" | ⚠️ 只 stderr, 关了就没 | ✅ 持久 JSONL 日志, 1-3 个月可查 |
| 跑出 1GB 内存的进程 | ❌ 不限 | ✅ 进程被 kill |
| 同事 A 看见同事 B 的项目 | ❌ 跨用户越权 | ✅ (走 WS / MCP 协议, **不归 Pi 客户端管**) |

---

## 分两阶段做 (1-2 天 + 3-5 天)

### 阶段 1: P-Sec1 — Job Object + 审计日志 (1-2 天, 最先做)

**做什么**:
1. Tauri 启动 sidecar 时, 把 sidecar 进程扔进一个 **Job Object** (Windows 内建的"笼子")
2. 笼子里设规则: 每个进程最多用 **1GB 内存**, 最多 **100 个子进程**, CPU 限速 **1 核**
3. sidecar 跑的所有 bash 进程自动继承 Job 成员身份, 限制自动生效
4. 每次 bash 调用写一行 JSON 到 `<agentDir>/audit.log` (跟 settings.json 同目录)

**为什么先做这个**:
- 1-2 天就搞定, 风险低 (改的是 Tauri 进程层, 不动 Pi SDK)
- 解决最痛的 DoS 问题 (LLM fork bomb 卡死单机)
- 审计日志后面想做"工具历史"面板直接用
- 是 P-Sec2 的基础设施 (P-Sec2 的 AppContainer 也需要类似机制)

**用户测试**:
- 跑个内存炸弹 → 进程被杀
- 跑个 fork bomb → 进程被杀
- 跑正常命令 → audit.log 多一行, 字段齐全

---

### 阶段 2: P-Sec2 — AppContainer filesystem 隔离 (3-5 天)

**做什么**:
1. 编译一个新的小 binary `sandbox-bash.exe`
2. 这个 binary **伪装成 bash**, Pi SDK 看到的是普通 bash
3. 内部走 **Windows AppContainer** API, 真 bash 跑在一个**文件系统受限**的环境里:
   - ✅ 能看: workspace 目录 (LLM 工作区) + 临时目录 + 系统必要的 DLL
   - ❌ **看不到**: `~/.ssh` / `~/.aws` / 同事的用户目录
   - ❌ **写不了**: 文档 / 桌面 / 其他用户的 AppData

**为什么用 wrapper binary 而不是 hook Pi SDK**:
- Pi SDK 0.84.2 内部自己 `child_process.spawn` 调 bash, hook 进去要改 SDK 内部实现, 风险大
- 改 `bash.path` 指向我们的 wrapper, Pi SDK 看到的还是 bash, **完全无感**

**用户测试**:
- `cat /c/Users/<你>/.ssh/id_rsa` → **读不到** (AppContainer 不可见)
- `python -c "写到 /c/Users/<你>/Documents/leak.txt"` → **写失败** (无 capability)
- `echo hi > /workspace/test.txt` → **正常**
- `echo hi > /tmp/test.txt` → **正常**

---

## 明确不做的事

| 不做 | 原因 |
|---|---|
| **网络隔离 (AppContainer 默认 deny 网络)** | 影响 `npm install` / `git clone` / `pip install`, 团队场景需要白名单维护, 投入产出比不高. 留 P1 |
| **跨用户越权** | 不是 Pi 客户端的活, 是 WS 转发 + MCP 协议的事, 另起 ADR-0021 |
| **WSL / Docker 沙箱** | 跨平台但部署复杂, 当前 Windows-only 用不上 |
| **syscall 过滤** | Windows 没对应机制, 复杂度爆炸, 价值边际递减 |

---

## 总投入

- **P-Sec1**: 1-2 天 (最先做)
- **P-Sec2**: 3-5 天 (P-Sec1 验证后再开)
- **P-Sec3** (网络, 后续 P1): 1-2 天
- **总**: 5-9 天分 2-3 次迭代, 覆盖小团队 95% 风险

---

## 跨用户安全怎么搞 (另一份 ADR)

> 多人协同的安全 (auth / 跨用户 audit / agent MCP 协议权限) **不在 Pi 客户端范围**, 走单独的 ADR-0021.
>
> 那个 ADR 涵盖: WS server 端 JWT auth / capability token ("agent A 能调 agent B 跑只读工具不能跑 bash") / 跨用户 audit / rate limit.
>
> 本 ADR 只管 "**单个 Pi 进程在自己机器上不捣乱**" 这一层.
