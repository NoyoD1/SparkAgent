# ADR-0012: Provider / Model / BYOK 模块

- **状态**: Accepted
- **日期**: 2026-08-19
- **Type**: Functional
- **Module**: Provider
- **决策者**: user
- **Relates to**: [0002-data-local-byok](0002-data-local-byok.md) (BYOK + keychain)

## 功能定义 (应该做什么)

- ✅ 7 内置 provider 支持: anthropic / openai / deepseek / moonshotai / google / groq / openai-compatible
- ✅ 任意 openai-compatible 自定义 (商汤 / 自建 / etc)
- ✅ Provider 增删改
- ✅ Active provider 切换
- ✅ Active model 切换 (在 provider 内)
- ✅ API key 走 OS keychain (Windows Credential Manager / macOS Keychain / Linux libsecret)
- ✅ Provider config 持久化 (Rust `config_store.rs` `config.json`)
- ✅ Model metadata 5 字段: type / vision / contextWindow / maxOutput / maxRounds / reasoning
- ✅ Thinking level 切换: off / low / medium / high
- ❌ Provider 分享 / 导出
- ❌ Team 共享 config
- ❌ Cloud 同步

## 已实现 (v0.5.9+)

| 功能 | 状态 | 实现位置 | 核验方法 |
|---|---|---|---|
| 7 内置 provider | ✅ | `app/src/stores/config.ts` 内置工厂 | 列表里看到 7 个 |
| 自定义 openai-compatible | ✅ | `Settings → Provider → + Add` 填 baseUrl | 加商汤 (e.g. `https://api.sensenova.cn/v1`), 跑通 |
| Provider CRUD | ✅ | `configStore.addProvider` / `removeProvider` / `updateProvider` | 增删改都 work |
| Active 切换 | ✅ | `configStore.activeProviderId` | 切换, 跑 1 轮对话 |
| Model metadata 5 字段 | ✅ (v0.4.4.6) | `ProviderTab.vue` ⚙️ inline form | 改字段, 跑端到端 |
| API key 走 keychain | ✅ | `keyring` crate | `ls %APPDATA%\com.piagent.desktop\` 看不到 key |
| config.json 持久化 | ✅ | `config_store.rs` atomic write | 改 config, kill app, 重开, config 还在 |
| Thinking level | ✅ | `set_thinking_level` RpcCommand | 切 low/medium/high, 看 LLM 行为 |

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

## 已知问题 / 技术债

- 🟡 **Provider 详情面板**: v0.5.0-PR2 改完, current 标识走 input box, 但 enable/disable UI 还有边角
- 🟡 **Model metadata form**: 5 字段 inline edit, 校验不严
- 🟡 **Provider 增删没确认**: 删直接消失 (不像 session 有 confirm)
- 🟡 **没有 provider 测试按钮**: 加完不知道配对不对, 要跑去对话才知道

## 后续规划

### P0 (v0.6)
- Provider 增删 confirm
- "测试连接" 按钮 (加 provider 时点一下, 直接验证)

### P1 (v0.6 - v0.7)
- Provider 导出 / 导入 (用户备份)
- Model metadata 校验加严

### P2 (v0.7+)
- Team 共享 (云端 sync config.json)
- Provider marketplace
