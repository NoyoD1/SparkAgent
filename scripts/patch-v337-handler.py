#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v3.37 patch (Part 2): 删 lib.rs generate_handler! 里的 8 个 keychain commands.
"""
import os

lib_path = "src-tauri/src/lib.rs"
with open(lib_path, "r", encoding="utf-8") as f:
    lib = f.read()

old_handler = '''        .invoke_handler(tauri::generate_handler![
            save_api_key,
            delete_api_key,
            list_api_keys,
            has_api_key,
            send_prompt,
            // ADR-0022 v3.5 (2026-08-23): user 上传 (粘贴图片 / 拖文件) — Tauri 存盘后返绝对路径
            save_uploaded_file,
            // ADR-0022 v3.8: 文件预览 (读 text 前 N 行, 给 useAttachmentPreview 用)
            read_text_file_preview,
            // ADR-0022 v3.9: 从 savedPath 重读图片 base64 (reload 后 image 预览)
            read_image_as_data_url,
            compact_session,  // Bug #2 修 (2026-08-18): 独立 compact invoke
            kill_sidecar,  // v0.4.6 修 (2026-08-18): abort 兜底时 force kill 旧 sidecar
            // ADR-0023 (2026-08-23): 静默重启机制 — 改了"需要重启"的配置 (MCP server /
            //   external tool / dangerousWhitelist / bash.path) 后, FE 触发, Tauri
            //   kill 所有 active sidecar, 下次 send_prompt lazy spawn 走新 config.
            restart_all_sidecars,
            // ADR-0023 P3-C (2026-08-24): 通用 secret 管理 (MCP env / external tool env
            //   走 keychain, 不再明文存盘)
            save_secret,
            delete_secret,
            list_secrets,
            resolve_secrets,
            // ADR-0023 P3-D: 列出 external tool 文件夹, 给 FE Tools tab 展示 + 导入导出用
            list_external_tools,'''

new_handler = '''        .invoke_handler(tauri::generate_handler![
            send_prompt,
            // ADR-0022 v3.5 (2026-08-23): user 上传 (粘贴图片 / 拖文件) — Tauri 存盘后返绝对路径
            save_uploaded_file,
            // ADR-0022 v3.8: 文件预览 (读 text 前 N 行, 给 useAttachmentPreview 用)
            read_text_file_preview,
            // ADR-0022 v3.9: 从 savedPath 重读图片 base64 (reload 后 image 预览)
            read_image_as_data_url,
            compact_session,  // Bug #2 修 (2026-08-18): 独立 compact invoke
            kill_sidecar,  // v0.4.6 修 (2026-08-18): abort 兜底时 force kill 旧 sidecar
            // ADR-0023 (2026-08-23): 静默重启机制 — 改了"需要重启"的配置 (MCP server /
            //   external tool / dangerousWhitelist / bash.path) 后, FE 触发, Tauri
            //   kill 所有 active sidecar, 下次 send_prompt lazy spawn 走新 config.
            restart_all_sidecars,
            // v3.37 (2026-08-24): 删 8 个 keychain commands (save_api_key / delete_api_key /
            //   list_api_keys / has_api_key / save_secret / delete_secret / list_secrets /
            //   resolve_secrets). apiKey 改存 settings.json 明文, secret 改 user 直填配置.
            // ADR-0023 P3-D: 列出 external tool 文件夹, 给 FE Tools tab 展示 + 导入导出用
            list_external_tools,'''

if old_handler not in lib:
    print("ERROR: old_handler not found, manual fix needed")
    raise SystemExit(1)
lib = lib.replace(old_handler, new_handler)
with open(lib_path, "w", encoding="utf-8") as f:
    f.write(lib)
print(f"updated {lib_path} - removed 8 keychain commands from generate_handler")
