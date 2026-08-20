# ADR-0012: Provider / Model / BYOK 模块

- **状态**: Accepted (v0.6 Phase 8 暗色模式适配完成, 2026-08-20)
- **日期**: 2026-08-19 (initial) / 2026-08-20 (Phase 8 暗色 + 按钮配色修)
- **Type**: Functional
- **Module**: Provider
- **决策者**: user
- **Relates to**: [0002-data-local-byok](0002-data-local-byok.md) (BYOK + keychain)

## 功能定义 (应该做什么)

- ✅ 8 内置 provider 支持: anthropic / openai / deepseek / moonshotai / google / groq / minimax / openai-compatible
- ✅ 任意 openai-compatible 自定义 (商汤 / 自建 / etc)
- ✅ Provider 增删改
- ✅ Active provider 切换
- ✅ Active model 切换 (在 provider 内)
- ✅ API key 走 OS keychain (Windows Credential Manager / macOS Keychain / Linux libsecret)
- ✅ Provider config 持久化 (Rust `config_store.rs` `config.json`)
- ✅ Model metadata 6 字段: type / vision / contextWindow / maxOutput / maxRounds / reasoning
- ✅ Thinking level 切换: off / low / medium / high (运行时同步走 `set_thinking_level` RpcCommand, v0.5.0+ 修)
- ❌ Provider 分享 / 导出
- ❌ Team 共享 config
- ❌ Cloud 同步

## 已实现 (v0.5.9+)

| 功能 | 状态 | 实现位置 | 核验方法 |
|---|---|---|---|
| 8 内置 provider | ✅ | `app/src/stores/config.ts` 内置工厂 | 列表里看到 8 个 |
| 自定义 openai-compatible | ✅ | `Settings → Provider → + Add` 填 baseUrl | 加商汤 (e.g. `https://api.sensenova.cn/v1`), 跑通 |
| Provider CRUD | ✅ | `configStore.addProvider` / `removeProvider` / `updateProvider` | 增删改都 work |
| Active 切换 | ✅ | `configStore.activeProviderId` | 切换, 跑 1 轮对话 |
| Model metadata 6 字段 | ✅ (v0.4.4.6) | `ProviderTab.vue` ⚙️ inline form | 改字段, 跑端到端 |
| **Model metadata 自动填充** (v0.5.0-D D213) | ✅ | `src-tauri/src/model_catalog.rs` 静态 catalog + `parse_openai_compatible_meta` 启发式 parse | 加内置 provider 自动填 4 个字段 (contextWindow/maxOutput/vision/reasoning); UI 加 ✨ 角标 |
| API key 走 keychain | ✅ | `keyring` crate | `ls %APPDATA%\com.piagent.desktop\` 看不到 key |
| config.json 持久化 | ✅ | `config_store.rs` atomic write | 改 config, kill app, 重开, config 还在 |
| Thinking level 实时同步 | ✅ (v0.5.0+ P0 #2) | `ProviderTab.vue` `setThinking` + `sendRpcCommand({ type: 'set_thinking_level', level })` | 切 low/medium/high, 正在 streaming 的对话也立即用新值 |

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

### Model metadata
1. 进 Provider tab ⚙️, 改某 model 的 contextWindow (e.g. 200K → 8K)
2. 跑长对话, 看 Composer context indicator 用新值 (8K)
3. 改 maxOutput, 跑长生成, 看是否被截断

### Thinking level
1. 切 low → medium → high → off
2. 看 sidecar stderr 4 段 system prompt log 包含新 thinking level
3. 跑同 prompt, 看 token 消耗差异

### 暗色模式 (Phase 8 验证)
1. 切到深色模式 (Settings → 外观 → 深色)
2. Provider tab: 左侧 provider 列表 / 右侧详情面板 / 模型列表 / 输入框 / 模型 metadata form, 全部深色适配
3. "测试连接" / "保存" 等 primary 按钮: 浅色 bg + 深色文字, 清晰可见
4. hover 按钮: 边框变 accent (紫色), 文字变 primary (深色)
5. 右侧滚动条: 深色 thumb (跟其他 dark 滚动条一致)

## 已知问题 / 技术债

- 🟡 **Provider 详情面板**: v0.5.0-PR2 改完, current 标识走 input box, 但 enable/disable UI 还有边角
- 🟡 **Model metadata form**: 6 字段 inline edit, 校验不严 (P1 #2 修)
- ✅ **Provider 增删没确认**: 修 (v0.5.0+ P0 #4) — 用 confirm/alert 弹窗 + fallback 不可用阻止; 后续 P1 #1 升级到 `ConfirmDialog.vue` 统一风格
- 🟡 **没有 provider 测试按钮**: 加完不知道配对不对, 要跑去对话才知道 (P0 #1 修)
- 🟡 **ProviderTab 大量 `var(--pad-bg-muted)` 等未定义变量**: Phase 8 已修, 但还有个别 hardcoded `rgba(0,0,0,0.04)` 等, 需复查

## 后续规划

### ✅ P0 (v0.6) — 已完成
- ✅ Thinking level 运行时同步 (v0.5.0+ 修, `set_thinking_level` RpcCommand)
- ✅ Provider 增删 confirm (v0.5.0+ 修, fallback 不可用时阻止)
- ✅ Phase 8: 暗色模式按钮撞色 (ProviderTab primary 按钮 + tokens.css light 模式 `--pad-accent-foreground`)
- ✅ Phase 8: 全局滚动条 dark 适配

### 二阶段 P0 (下个 sprint, 必做)
- **"测试连接" 按钮**: 加 provider 时点一下, 走轻量 `/models` 拉取验证, 立即反馈 baseUrl + key 是否配对
  - 实现: FE 调一个 LLM 客户端最小调用 (e.g. `GET /v1/models`), Rust 端 `test_provider` Tauri command 调 sidecar 转发
  - 场景: 用户加商汤 / 自建 provider, 不用跑去对话才知道
- **Provider 增删 confirmDialog 升级**: 跟 Session 8 features 同步, 用通用 `ConfirmDialog.vue` 替换 native `confirm/alert` (统一风格, 支持 danger 标识)
- **Model metadata 校验加严**: 6 字段 inline edit 加类型校验 (contextWindow 必须是正整数, maxOutput ≤ contextWindow, type 必须在 enum 里, maxRounds ≥ 0 等), 错误状态红框 + tooltip

### 二阶段 P1
- **debounce saveAppConfig**: 改 metadata form 频繁写盘, 加 500ms debounce 合并连续输入
- **maxRounds 真正 enforce**: sidecar Extension 层拦截, 超过 maxRounds 强制 stop (目前只统计, 没拦)
- **删 keychain 失败时 rollback config**: 删 provider 时如果 keychain 删失败 (e.g. Windows 凭据管理器锁), config 已删但 key 残留 → 下次同 id provider 复用旧 key 风险
- **Provider 详情面板 enable/disable UI polish**: v0.5.0-PR2 改完的边角, enable toggle 加 disable fallback 提示
- **复查 hardcoded rgba**: Phase 8 扫过一批 `--pad-bg-muted` 等未定义变量, 但还有 `rgba(0,0,0,0.04)` `rgba(0,0,0,0.06)` 等 hardcoded 浅色值, 切到 dark 模式可能不可见. 全量扫一遍

### 二阶段 P2 (后续)
- 清理 `apiKeyEnv` dead code (要么 UI 暴露要么删字段)
- 重复 type provider 拒绝 (addProvider 防重复)
- `addCustomModel` 重复 id 提示 (不再静默吞)
- `genId()` 强约束 (无 crypto.randomUUID 就抛错)
- FE/Sidecar contextWindow 默认值统一 (200K vs 128K)
- Team 共享 (云端 sync config.json)
- Provider marketplace
- Provider 分享 / 导出 (单条 provider 配置导出给其他用户导入)
