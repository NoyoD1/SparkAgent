#!/usr/bin/env python3
"""v0.5.0-D 第10轮 revert: 删 splitMessageContentIntoStep + stripLeadingUserEcho 函数
   + 它们在 message_start/message_end/text_delta 的调用.

   用户反馈 9 轮 filter 迭代原地打转, text-based echo filter 不可靠.
   改回 v0.5.0-PR3 简单 append.
"""
import re
import sys
from pathlib import Path

chat_path = Path("app/src/stores/chat.ts")
text = chat_path.read_text(encoding="utf-8")

# 1. 删 splitMessageContentIntoStep 函数定义 (从 /** 注释开头到 closing } )
#    用 regex 找到从 "function splitMessageContentIntoStep" 开始到 balanced closing }
pattern_split = re.compile(
    r"^/\*\*[\s\S]*?v0\.4\.6 Bug 修 \(Cursor 风格生效\)[\s\S]*?function splitMessageContentIntoStep[\s\S]*?\n\}\n\n",
    re.MULTILINE
)
text_before = text
text = pattern_split.sub("", text, count=1)
if text == text_before:
    print("WARN: splitMessageContentIntoStep 函数定义 not removed")

# 2. 删 stripLeadingUserEcho 函数定义 (从 /** 注释开头到 closing } )
pattern_strip = re.compile(
    r"^/\*\*[\s\S]*?v0\.5\.0-D 第4轮: 剥除 assistant 文本开头的 user input echo[\s\S]*?function stripLeadingUserEcho[\s\S]*?\n\}\n\n",
    re.MULTILINE
)
text_before = text
text = pattern_strip.sub("", text, count=1)
if text == text_before:
    print("WARN: stripLeadingUserEcho 函数定义 not removed")

# 3. 加注释说明为什么删 (在 export const useChatStore 前面)
marker = "export const useChatStore = defineStore('chat', () => {"
if marker in text:
    text = text.replace(
        marker,
        "// v0.5.0-D 第10轮 revert: 删 splitMessageContentIntoStep + stripLeadingUserEcho 整套函数.\n"
        "//   用户反馈 9 轮 filter 迭代原地打转 (D194 起 每轮加规则漏 case), text-based echo\n"
        "//   filter 不可靠 (model 复读有空格/标点/重复/无标点变体). 改回 v0.5.0-PR3 简单 append\n"
        "//   (在 message_update 块直接 assistant.content += ame.delta + step.stepText += ame.delta).\n"
        "//   真正 fix 在 sidecar system prompt + model 选择层, 不在 chat store 文本层.\n\n"
        + marker,
        1
    )
else:
    print(f"WARN: marker not found: {marker}")

# 写回
chat_path.write_text(text, encoding="utf-8")
print(f"OK: {chat_path} updated, {len(text)} chars")

# 验证
final = chat_path.read_text(encoding="utf-8")
assert "function splitMessageContentIntoStep" not in final, "splitMessageContentIntoStep still present"
assert "function stripLeadingUserEcho" not in final, "stripLeadingUserEcho still present"
assert "stripLeadingUserEcho(" not in final, "stripLeadingUserEcho() call still present"
assert "splitMessageContentIntoStep(" not in final, "splitMessageContentIntoStep() call still present"
print("OK: 4 assertions pass")
