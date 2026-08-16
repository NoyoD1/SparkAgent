# Skills / Slash Command

> 状态: ❌ 0%
> 最后更新: 2026-08-16
> spec 涉及: v0.6 phase 新增

---

## 1. Spec

**Slash command = 用户在 composer 输入 `/xxx` 触发的预定义指令**。**Skill = 带 frontmatter 描述 + 触发条件的可复用 prompt 模板**。

### 1.1 必备能力（v0.6 必做）

- ❌ **内置 slash command**（至少 10 个）：
  - `/help` — 显示所有命令
  - `/clear` — 清空当前 session messages
  - `/model` — 切换模型
  - `/provider` — 切换 provider
  - `/workspace` — 切换 workspace
  - `/compact` — 压缩长 session（v0.5 memory 之后做）
  - `/commit` — 让 LLM 看 git diff 写 commit message
  - `/pr` — 让 LLM 看 diff 写 PR description
  - `/review` — 让 LLM 审查当前 diff
  - `/test` — 让 LLM 跑测试 + 看结果
- ❌ **用户自定义 slash command**（`.piagent/commands/*.md` 类似 Claude Code）
  - Markdown + YAML frontmatter
  - 支持占位符（`$ARGUMENTS` / `$SELECTION`）
- ❌ **Skill 包**（`.piagent/skills/<name>/SKILL.md`）
  - description 字段（LLM 判断何时触发）
  - when-to-use 字段
  - 跟 Claude Skills 协议兼容

### 1.2 未来能力

- ❌ Skill marketplace — v1.0
- ❌ Skill 版本管理 — v1.0
- ❌ Skill 触发统计（哪些 skill 用了多少次）— v0.7
- ❌ Skill 测试 / 预览 — v0.7

### 1.3 不做什么

- ❌ 远程 skill（用户本机的）
- ❌ Skill 自动调用（必须用户显式 `/` 触发，或 LLM 主动 mention）

---

## 2. 当前实现

**没有**。Composer 是纯文本输入。

---

## 3. 已知问题 / 限制

N/A

---

## 4. 待办（Roadmap）

### P0（v0.6 必做）
- [ ] Composer 输入 `/` 触发 command picker
- [ ] 10 个内置 command
- [ ] 自定义 command 加载（扫 `.piagent/commands/*.md`）
- [ ] Skill 包加载（扫 `.piagent/skills/*/SKILL.md`）
- [ ] Skill description 在 LLM context 里（自动 mention 触发）

### P1（v0.6 - v0.7）
- [ ] Skill marketplace UI
- [ ] Skill 触发统计
- [ ] `/help` 自动生成（从所有 skill 聚合）

### P2（v0.7+）
- [ ] Skill 版本管理
- [ ] Skill 沙箱（skill 只能访问特定 tool）

---

## 5. Changelog

N/A
