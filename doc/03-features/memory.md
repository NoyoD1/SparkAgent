# Memory（记忆系统）

> 状态: ❌ 0%
> 最后更新: 2026-08-16
> spec 涉及: v0.5 phase 新增

---

## 1. Spec

**Memory = 跨会话持久的事实**。让 LLM 在新会话也能记住：用户偏好 / 项目约定 / 之前讨论的结论。

### 1.1 必备能力（v0.5 必做）

- ❌ **项目级 memory**（`./AGENTS.md` 类似 Pi Agent 机制）
  - 每个 workspace 一个 memory 文件
  - 自动随 workspace 切换
  - 用户在项目根 commit 进 git
- ❌ **用户级 memory**（`%APPDATA%\com.piagent.desktop\memory.md`）
  - 跨项目生效
  - 用户的全局偏好（如"代码注释用中文"）
- ❌ **自动提取**
  - 用户说"记住：以后不要在 TS 项目用 default export"
  - LLM 检测到记忆意图 → 写入对应 memory 文件
- ❌ **Memory 编辑器**（Settings → Memory）
  - 列表展示所有 memory 条目
  - 手动增删改
  - 按 scope（project / user）分类
- ❌ **注入到 system prompt**
  - 已有 workspace prompt 机制扩展
  - LLM 知道 user preferences + project context

### 1.2 未来能力

- ❌ Memory 智能合并（去重 / 冲突解决）— v0.5+
- ❌ Memory 搜索（快速找到"我之前说过什么"）— v0.5+
- ❌ Memory 版本控制（项目级可走 git）— v0.5+
- ❌ Memory 过期策略（"这条记忆 30 天没用自动隐藏"）— v0.6
- ❌ 长期记忆（per-user embedding 检索）— v0.6

### 1.3 不做什么

- ❌ 记忆跨设备同步（数据本机）
- ❌ 记忆可视化时间线（不是 timeline app）
- ❌ 记忆分享（跟 [sharing.md](sharing.md) 冲突）

---

## 2. 当前实现

**没有**。`chat.ts` 没有任何 memory 概念。

---

## 3. 已知问题 / 限制

N/A（未实现）

---

## 4. 待办（Roadmap）

### P0（v0.5 必做）

- [ ] 数据结构：Memory item = `{ scope: 'project' | 'user', content: string, tags: string[], createdAt, updatedAt }`
- [ ] 存储：项目级 `./AGENTS.md` (YAML frontmatter + Markdown body)，用户级 `%APPDATA%\...\memory.md`
- [ ] 加载：sidecar 启动时读 → 注入 system prompt
- [ ] 写入：LLM 通过 tool_call 调 `save_memory(item)` / `delete_memory(id)`
- [ ] 提取意图识别：用户消息触发"记住 X" / "以后别 Y" → 调 save_memory
- [ ] 编辑器：Settings tab，按 scope 分类展示

### P1（v0.5 - v0.6）
- [ ] Memory 搜索（ripgrep 集成）
- [ ] 项目级 memory 可走 git 提交
- [ ] Memory 智能合并（user 显式 trigger "整理 memory"）

### P2（v0.6+）
- [ ] Memory 过期策略
- [ ] 长期记忆 embedding 检索
- [ ] Memory 模板（"复制 coder memory 模板"）

---

## 5. Changelog

N/A
