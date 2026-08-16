# ADR-0011: Tauri `decorations: false` 自定义 title bar

- **状态**: Accepted
- **日期**: 2026-08-16
- **决策者**: 用户

## 背景

Windows 11 默认窗口装饰（title bar + 边框）跟 Minimalist Copy 极简风格不搭。用户希望"打包的 exe 程序不要用原生的底部 top 栏，而是用我们自己的"。

## 备选

### 保留原生 decorations
- ✅ 零开发成本
- ❌ 跟极简风格冲突
- ❌ 跨平台表现不一致（Windows / macOS / Linux 各自原生样式）

### `decorations: false` + 自实现 TitleBar.vue ✅
- ✅ 完全控制样式（跟极简风格一致）
- ✅ 跨平台一致（都是自定义）
- ✅ 不引额外插件
- ❌ macOS traffic light button 处理（关闭/最小化/最大化）
- ❌ Windows 11 圆角适配（v0.3.8.22 修过）
- ❌ 拖动区域要手动设（`data-tauri-drag-region`）

### `decorations: true` + 透明 + 自绘
- ❌ 复杂，平台兼容性差

### 用 `tauri-plugin-window-decorations`
- ✅ 跨平台统一接口
- ❌ 多一个依赖
- ❌ 仍要写自定义 title bar UI

## 决策

**`decorations: false` + TitleBar.vue 自实现**。

```json
// src-tauri/tauri.conf.json
{
  "app": {
    "windows": [{
      "decorations": false,
      "title": "Pi Agent",
      ...
    }]
  }
}
```

```vue
<!-- TitleBar.vue -->
<template>
  <div class="pad-titlebar" data-tauri-drag-region>
    <span class="pad-titlebar__title">Pi Agent</span>
    <div class="pad-titlebar__controls">
      <IconButton icon="minus" @click="minimize" />
      <IconButton icon="square" @click="toggleMaximize" />
      <IconButton icon="x" @click="close" />
    </div>
  </div>
</template>

<script setup>
import { getCurrentWindow } from '@tauri-apps/api/window';
const win = getCurrentWindow();
const minimize = () => win.minimize();
const toggleMaximize = () => win.toggleMaximize();
const close = () => win.close();
</script>
```

**Capabilities 必需**：
```json
{
  "permissions": [
    "core:window:allow-minimize",
    "core:window:allow-maximize",
    "core:window:allow-unmaximize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-close",
    "core:window:allow-start-dragging",
    "core:window:allow-is-maximized"
  ]
}
```

## 后果

- 正面:
  - 完全控制样式（跟 Minimalist Copy 风格统一）
  - 跨平台一致
  - 不引额外依赖
- 负面:
  - macOS 需要特殊处理（traffic light button 位置）
  - Windows 11 圆角要手动适配（v0.3.8.22 已修 — title bar 顶角 8px + body 10px padding）
  - 拖动区域要 `data-tauri-drag-region`（按钮区域要 `e.stopPropagation()`）
- 中性:
  - 窗口最大化 / 还原状态要手动 query (`isMaximized()`) — 图标切换
  - 系统菜单（macOS menu bar）仍走 Tauri 默认

## 何时 Revisit

- macOS 适配出现严重问题（traffic light 错位等）
- Windows 12 推出，窗口装饰规范大变
- 用户要"原生 title bar"（极小概率）
- tauri-plugin-window-decorations 成熟到值得引
