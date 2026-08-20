# ADR-0012: Provider / Model / BYOK 模块

- **状态**: Accepted
- **日期**: 2026-08-19 (initial) / 2026-08-20 (P0/P1/P2 全面修 + D213 自动填充 + Phase 8 暗色)
- **Type**: Functional
- **Module**: Provider
- **决策者**: user
- **Relates to**: [0002-data-local-byok](0002-data-local-byok.md) (BYOK + keychain)

## 功能定义 (应该做什么)

- ✅ 8 内置 provider 支持: anthropic / openai / deepseek / moonshotai / google / groq / minimax / openai-compatible
- ✅ 任意 openai-compatible 自定义 (商汤 / 自建 / OpenRouter / Together / etc)
- ✅ Provider 增删改
- ✅ Active provider 切换
- ✅ Active model 切换 (在 provider 内)
- ✅ API key 走 OS keychain (Windows Credential Manager / macOS Keychain / Linux libsecret)
- ✅ Provider config 持久化 (Rust `config_store.rs` `config.json`)
- ✅ Model metadata 6 字段: type / vision / contextWindow / maxOutput / maxRounds / reasoning
- ✅ **Model metadata 自动填充** (v0.5.0-D D213) — 内置走静态 catalog, openai-compatible 启发式 parse
- ✅ Thinking level 切换: off / low / medium / high (运行时同步走 `set_thinking_level` RpcCommand)
- ✅ Provider 增删二次确认 + 删 active fallback 保护 (ConfirmDialog + fallback 校验)
- ✅ 测试连接按钮 (verify_provider_connection: openai-compatible 真打 /models, 内置验 keychain)
- ❌ Provider 分享 / 导出
- ❌ Team 共享 config
- ❌ Cloud 同步
- ❌ Provider marketplace

## 已实现 (v0.5.0+)

| 功能 | 状态 | 实现位置 | 核验方法 |
|---|---|---|---|
| 8 内置 provider | ✅ | `app/src/stores/config.ts` 内置工厂 | 列表里看到 8 个 |
| 自定义 openai-compatible | ✅ | `Settings → Provider → + Add` 填 baseUrl | 加商汤 / OpenRouter / 自建, 跑通 |
| Provider CRUD | ✅ | `configStore.addProvider` / `removeProvider` / `updateProvider` | 增删改都 work |
| Active 切换 | ✅ | `configStore.activeProviderId` | 切换, 跑 1 轮对话 |
| Model metadata 6 字段 | ✅ (v0.4.4.6) | `ProviderTab.vue` ⚙️ inline form | 改字段, 跑端到端 |
| **Model metadata 自动填充** (v0.5.0-D D213) | ✅ | `src-tauri/src/model_catalog.rs` 静态 catalog (44 个 model) + `parse_openai_compatible_meta` 启发式 parse (`context_length` / `max_completion_tokens` / `input_modalities`) | 加内置 provider 自动填 4 字段, UI 加 ✨ 角标 |
| API key 走 keychain | ✅ | `keyring` crate | `ls %APPDATA%\com.piagent.desktop\` 看不到 key |
| config.json 持久化 | ✅ | `config_store.rs` atomic write (`.tmp` + rename) | 改 config, kill app, 重开, config 还在 |
| Thinking level 实时同步 | ✅ (P0 #2) | `ProviderTab.vue` `setThinking` + `sendRpcCommand({ type: 'set_thinking_level', level })` | 切 low/medium/high, 正在 streaming 的对话也立即用新值 |
| **测试连接按钮** | ✅ (P0 #1) | Tauri `verify_provider_connection` (openai-compatible 真实 HTTP /models) + `AddProviderForm` / `ProviderTab` 按钮 | 加 provider 后点一下, 立即知道 baseUrl + key 是否配对 |
| **删 active provider fallback 保护** | ✅ (P0 #4) | `ProviderTab.removeProvider` 删前算 fallback, 不可用阻止 | 配 2 个 provider, 删 active 时 fallback 不可用 → 弹"无法删除" |
| **Provider 增删 confirmDialog 升级** | ✅ (P1 #1) | `ProviderTab.vue` 用 `ConfirmDialog.vue` 替换 `window.confirm/alert` | 跟 Session 二次确认风格统一 |
| **Model metadata 校验** | ✅ (P1 #2) | `ProviderTab.vue` `validateMetadataForm` (contextWindow > 0, ≥ maxOutput, maxRounds 1-100, 范围 sanity) | 填错值时红字提示, 不让保存 |
| **debounce saveAppConfig 500ms** | ✅ (P1 #4) | `config.ts` `schedulePersist` | 改 metadata form 不再狂写盘 |
| **maxRounds 真正 enforce** | ✅ (P1 #5) | `sidecar/src/index.mjs` `createMaxRoundsExtension` (turn_start 重置 + tool_call 计数 + 超限 block) | 设 maxRounds=2, 第三次 tool call 被拦 |
| **删 keychain 失败 rollback** | ✅ (P1 #6) | `ProviderTab.removeProvider` 先 keychain 再 config, 失败回滚 | keychain 删失败弹错, config 不动 |
| **`apiKeyEnv` dead code 清理** | ✅ (P2 #1) | `config.ts` / `tauri.ts` / `api-types.ts` / `config_store.rs` 全删 | grep 不到 `apiKeyEnv` 引用 |
| **重复 type provider 拒绝** | ✅ (P2 #2) | `config.ts` `addProvider` 内置 type 配过就抛错 | 加第 2 个 anthropic 报错 |
| **`addCustomModel` 重复 id 提示** | ✅ (P2 #3) | `ProviderTab.vue` 重复 id 给错误提示 | 不再静默吞 |
| **`genId()` 强约束** | ✅ (P2 #4) | `config.ts` 无 `crypto.randomUUID` 直接抛错 | 移除 fallback 弱熵方案 |
| **FE/Sidecar contextWindow 默认值统一 200K** | ✅ (P2 #5) | `sidecar/src/index.mjs` 改 128K → 200K, `chat.ts` 加注释对齐 | Composer 显示的 ctx 跟 Pi SDK 内部用的一致 |

## 已实现 (v0.6 Phase 8 暗色模式适配 — 2026-08-20)

| 改动 | 状态 | 涉及文件 | 核验方法 |
|---|---|---|---|
| ProviderTab 卡片 / 输入框 / 边框 / 列表项 dark 适配 | ✅ | `ProviderTab.vue` (12 处 CSS) | 切深色模式, 卡片/输入框/边框深色, 不再透白 |
| ProviderTab primary 按钮 dark 撞色修复 | ✅ (Phase 8b) | `ProviderTab.vue` | "测试连接"/"保存" 等按钮在 light 模式深色文字 + dark 模式浅色文字, 都清晰可见 |
| ProviderTab primary 按钮风格统一 (跟 Skills tab 对齐) | ✅ (Phase 8c) | `ProviderTab.vue` | 改成 secondary outline 风格 (card bg + border + secondary text), hover 升级到 accent border |
| tokens.css `--pad-accent-foreground` light 模式值修 | ✅ (Phase 8c) | `tokens.css` | light 模式从 `var(--pad-fg-900)` (#0a0a0a) 改成 `var(--pad-fg-50)` (#fafafa), 跟 dark 模式 (#0a0a0a) 互补 |
| 全局滚动条 dark 适配 | ✅ (Phase 8) | `main.css` | ProviderTab 右侧滚动条 dark 模式深色 thumb |

## 核验方法 (端到端)

### 基础 CRUD
1. 进 Settings → Provider, 加一个新 provider (随便 baseUrl, 假 key)
2. 删一个 provider
3. 改 provider label
4. 切换 active provider, 跑 1 轮对话

### BYOK + Keychain
1. 配商汤 (或任一 openai-compatible), 填真 key
2. 看 `%APPDATA%\com.piagent.desktop\config.json` 不包含 key
3. Windows 凭据管理器找 `pi-agent:apiKey:<providerId>`, 看到 key
4. kill app, 重开, 配置还在, key 仍能调通

### Model metadata (手动 + 自动)
1. 加一个 **anthropic** provider → 7 个 model 全部带 ✨ contextWindow=200K + maxOutput=8K + vision ✓
2. 加一个 **openai-compatible** (OpenRouter 风格, 返 `context_length`) → 拉到的 model 也会带 ✨ 自动填字段
3. 进 Provider tab ⚙️, 改某 model 的 contextWindow (e.g. 200K → 8K), 保存 → ✨ 消失 (改了就视为手动覆盖)
4. 跑长对话, 看 Composer context indicator 用新值 (8K)
5. 改 maxOutput, 跑长生成, 看是否被截断

### 测试连接 (P0 #1)
1. 加 provider, 填 baseUrl + key, 点 "测试连接"
2. openai-compatible: 实际 ping `/v1/models`, 返回 "✓ 通了, 拿到 N 个 model (HTTP 200, Xms)" 或 "✗ 401 Unauthorized"
3. 内置 provider: 验 keychain 里有 key, 返回 "Key 已存 (N 字符), 首次对话时验证"

### Thinking level 实时同步 (P0 #2)
1. 发条消息让 LLM 正在 streaming
2. 切 low → high (中途切)
3. 看 sidecar stderr 应该有 4 段 system prompt log 包含新 level, **当前那条**也要照新 level 走

### 删 active provider fallback 保护 (P0 #4)
1. 配 2 个 provider, 把第二个设成 active
2. 删第一个 → 走漂亮 ConfirmDialog, 确认后 fallback 成功
3. 反过来: active 的 provider 删, **fallback 不可用** (没 key 或没 model) → 弹"无法删除"阻止你

### maxRounds enforce (P1 #5)
1. 配一个 model 设 `maxRounds: 2`
2. 发"列一下当前 workspace 所有文件然后总结" → 第 3 次 tool call 应该被拦, sidecar stderr 看到 `[maxRounds] BLOCK tool call #3`

### 暗色模式 (Phase 8 验证)
1. 切到深色模式 (Settings → 外观 → 深色)
2. Provider tab: 左侧 provider 列表 / 右侧详情面板 / 模型列表 / 输入框 / 模型 metadata form, 全部深色适配
3. "测试连接" / "保存" 等 primary 按钮: 浅色 bg + 深色文字, 清晰可见
4. hover 按钮: 边框变 accent (紫色), 文字变 primary (深色)
5. 右侧滚动条: 深色 thumb (跟其他 dark 滚动条一致)

## 已知问题 / 技术债

- 🟡 **Provider 详情面板**: v0.5.0-PR2 改完, current 标识走 input box, 但 enable/disable UI 还有边角
- ✅ **Model metadata form 校验不严**: 修 (P1 #2)
- ✅ **Provider 增删没确认**: 修 (P0 #4) + 升级到 ConfirmDialog (P1 #1)
- ✅ **没有 provider 测试按钮**: 修 (P0 #1)
- 🟡 **ProviderTab 大量 `var(--pad-bg-muted)` 等未定义变量**: Phase 8 已修, 但还有个别 hardcoded `rgba(0,0,0,0.04)` 等, 需复查
- 🟡 **静态 catalog 维护**: 厂商出新 model 时需要手动加进 `model_catalog.rs`. 后续可加 community-shared catalog / 自动从厂商文档爬 (D213 phase 2)

## 后续规划

### ✅ P0 (v0.6) — 全部完成
- ✅ Thinking level 运行时同步 (P0 #2)
- ✅ Provider 增删 confirm + fallback 保护 (P0 #4)
- ✅ 测试连接按钮 (P0 #1)
- ✅ Phase 8 暗色模式适配

### ✅ P1 (v0.6 - v0.6.x) — 全部完成
- ✅ Provider 增删 confirmDialog 升级 (P1 #1)
- ✅ Model metadata 校验加严 (P1 #2)
- ✅ debounce saveAppConfig (P1 #4)
- ✅ maxRounds 真正 enforce (P1 #5)
- ✅ 删 keychain 失败 rollback (P1 #6)

### ✅ P2 (v0.7+) — 全部完成
- ✅ `apiKeyEnv` dead code 清理 (P2 #1)
- ✅ 重复 type provider 拒绝 (P2 #2)
- ✅ `addCustomModel` 重复 id 提示 (P2 #3)
- ✅ `genId()` 强约束 (P2 #4)
- ✅ FE/Sidecar contextWindow 默认值统一 200K (P2 #5)

### ✅ 额外 (D213) — 已完成
- ✅ Model metadata 自动填充 (静态 catalog 44 个 model + openai-compatible 启发式 parse)

### ❌ 暂缓 / 后续版本
- ~~Provider 导出 / 导入 (用户备份)~~ — 暂缓
- ~~迁移备份 (config.json migrateFromLocalStorage 备份)~~ — 暂缓

### ❌ P3 / 长期 (v0.7+)
- Team 共享 (云端 sync config.json)
- Provider marketplace
- Provider 分享 / 导出 (单条 provider 配置导出给其他用户导入)
- Gemini live API 解析 (`/v1beta/models` 真 metadata) — 当前 google 走静态 catalog
- 静态 catalog 自动更新机制 (从厂商 changelog 拉)
- Community-shared catalog (用户共享自己维护的 catalog)
- 全量扫 hardcoded `rgba(0,0,0,0.0X)` 改 token
- `migrateFromLocalStorage` 加备份 (防旧数据脏了污染新 config)

## 后续计划 (Roadmap)

> 排序原则: **高 ROI 优先 (低投入高回报) → 战略级最后 (高投入但定义产品未来)**. 工作量按单个开发者全职估算.

### Phase 1: 1-2 周内能推完, 高 ROI

| # | 项 | 工作量 | 价值 | 依赖 | 验收 |
|---|---|---|---|---|---|
| 1.1 | **Provider 导出 / 导入** (JSON, 不含 keychain 里的 key) | 2-3 天 | 🟢 高 — 跨机器同步 + 备份最实在的需求 | 无 | 导出 → 改 baseUrl → 导入能跑 |
| 1.2 | **migrateFromLocalStorage 加备份** (迁移前 `.bak` 副本) | 1-2 小时 | 🟡 中 — 防旧数据脏污染 | 无 | 故意灌一个非法 JSON, 看是否保留 .bak |
| 1.3 | **Gemini live API 解析** (`/v1beta/models` 走通, 跟 catalog merge) | 0.5 天 | 🟢 高 — google model 更新零延迟, 顺带干掉 catalog 里 google 那 8 个 | 已有 `parse_openai_compatible_meta`, google 协议类似 | 跑一次 `/v1beta/models`, 字段全填 |
| 1.4 | **全量扫 hardcoded rgba → token** | 1-2 天 | 🟡 中 — 修剩下 ~5-10 个深色模式透白问题 | 已知大部分在 `ProviderTab.vue` / `ChatHeader.vue` | 切深色模式全 app 走一遍, 无透白 |

**总投入**: ~1 周. **风险**: 低 (都是局部改动).

### Phase 2: 中期, 1-2 月内

| # | 项 | 工作量 | 价值 | 依赖 | 验收 |
|---|---|---|---|---|---|
| 2.1 | **静态 catalog 自动更新** (CI 跑脚本: 拉厂商 changelog → diff → auto PR) | 1-2 周 | 🟡 中 — 减少手动维护, 但厂商 changelog 格式杂 | GitHub Actions | 每周自动出 "catalog 待更新" PR, merge 后下次 build 自动应用 |
| 2.2 | **i18n 框架** (vue-i18n, 中英双语起步) | 1 周 | 🟡 中 — 真出海 / 给国外用户用之前必备 | 无 | 切到英文 locale 全部 UI 翻译 |
| 2.3 | **FE bundle 拆分** (vite manualChunks, 当前 1.6 MB 单 chunk) | 1-2 天 | 🟡 中 — 启动速度 + 2G 内存用户体验 | 已有 `vite build` 配置 | 首屏 JS < 500 KB |
| 2.4 | **错误监控** (前端 window.onerror / Rust tauri-plugin-log → 远端 sink) | 3-5 天 | 🟡 中 — 出问题能收到信号, 不靠 user 截图 | 决定用 Sentry / 自己写 | 控制台 1 个错 → 远端 1 条记录 |

**总投入**: ~3-4 周. **风险**: 中 (i18n 一旦接后面每条文案都要走 key, 改动散).

### Phase 3: 战略级, 决定产品形态, 3+ 月

| # | 项 | 工作量 | 价值 | 依赖 | 验收 |
|---|---|---|---|---|---|
| 3.1 | **Provider 分享 / 导入** (单条 provider 配置 JSON, **不**含 key, 走"分享链接") | 1 周 | 🟢 高 — 用户之间互推 provider 配置, viral 增长基础 | 1.1 导出导入能力 | 一条 provider 配置发到群里, 别人点开能装 |
| 3.2 | **Community-shared catalog** (用户把自己维护的 catalog 上传到 Pi 中心仓, 别人订阅) | 2-3 周 | 🟡 中 — 静态 catalog 的多源扩展, 但需要"中心"基建 | 3.1 分享机制 | 一个用户提交 5 个 model 的 catalog, 别人能订阅 |
| 3.3 | **Team 共享 config** (云端 sync config.json, 多设备 / 团队成员) | 4-6 周 | 🟢 高 — 切换设备无缝, 团队 onboarding 提速 | 决定 auth (自建 / OAuth) + 后端 (Postgres / Cloudflare D1) | 两台电脑登录同一账号, provider 配置实时同步 |
| 3.4 | **Provider marketplace** (Pi Agent 官方维护 + community 提交流程) | 6-8 周 | 🟢 高 — 形成生态护城河 | 3.2 + 3.3 | 第三方提交 provider 配置, 走审核, 上架后一键安装 |

**总投入**: 3-4 月. **风险**: 高 (每项都涉及产品决策 + 后端基建, 不是纯前端能搞定的).

### 决策时考虑的因素

- **Q1 推 1.x**: 用户基数还小时推 Team / Marketplace 是自嗨. 先把单设备体验打透.
- **Q2 看数据**: 如果 NPS / 留存 OK, 推分享 / 社区 catalog (1.x → 2.0).
- **Q3 决定后端**: Team 共享必然要后端 + auth, 是"自建 Pi Cloud" 还是"接现成 auth (GitHub/Google)" 是个大决策.
- **持续维护成本**: catalog 自动更新是"低投入高回报"但要排个 bot 维护, 别让它变僵尸.

### 暂不做 / 永久搁置

- **Provider marketplace (第三方可上传 provider 插件)**: 安全风险太大, 不是 Pi Agent 这种桌面 app 该承担的, 跟 VSCode marketplace 的审核成本比, 我们玩不起
- **云端备份 session 历史**: 跟 team 共享合并考虑, 别单独做

## 提交历史

## 提交历史

- `585c23a` — feat(provider): ADR-0012 P0+P1+P2 全面修复 (测试连接/实时同步/校验/二次确认/maxRounds/debounce/清理)
- `10428e2` — feat(provider): D213 model metadata 自动填充 (静态 catalog + openai-compatible 启发式 parse)
