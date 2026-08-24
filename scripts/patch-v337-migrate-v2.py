#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v3.37 patch (Part 3 v2): 用 line-based 删 migrate_from_env + struct."""
path = "src-tauri/src/lib.rs"
with open(path, "r", encoding="utf-8") as f:
    lines = f.readlines()

# 1. 删 MigrationEntry + MigrationResult struct + comment
#    line 3461-3479 (0-indexed 3460-3478)
del lines[3460:3479]

# 2. 删 migrate_from_env fn
#    现在 line 3461 之后, 行号会变. migrate_from_env fn 大约在 3753-3813 (原 3813-3873)
#    找 #[tauri::command] 后面紧跟 migrate_from_env
migrate_start = None
migrate_end = None
for i, line in enumerate(lines):
    if migrate_start is None and "async fn migrate_from_env" in line:
        # 往前找 #[tauri::command]
        for j in range(i - 3, i + 1):
            if j >= 0 and lines[j].strip().startswith("#[tauri::command]"):
                migrate_start = j
                break
    if migrate_start is not None and migrate_end is None:
        if line.strip() == "}":
            # 检查是不是 fn 的 close (看缩进)
            if line.startswith("}"):
                migrate_end = i + 1
                break
print(f"migrate_start={migrate_start}, migrate_end={migrate_end}")
if migrate_start is None or migrate_end is None:
    raise SystemExit("migrate_from_env not found")

# 删 migrate_from_env + 紧跟的空行
del lines[migrate_start:migrate_end + 1]

# 3. 删 generate_handler! 里 migrate_from_env 引用
for i, line in enumerate(lines):
    if "migrate_from_env," in line:
        del lines[i]
        # 同时删上面那行注释 (如果有)
        if i > 0 and lines[i - 1].strip().startswith("// v3.37"):
            # 这是我刚加的注释, 保留
            pass
        break

with open(path, "w", encoding="utf-8") as f:
    f.writelines(lines)
print("done")
