> 来源：`非实时(Qwen-Omni).md`
\## OpenAI 兼容
Python

```
\# 运行前的准备工作:
\# pip install openai
import os
from openai import OpenAI
\# 初始化客户端
client = OpenAI(
    api\_key=os.getenv("DASHSCOPE\_API\_KEY"),
    base\_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
)
\# 发起请求（开启联网搜索）
try:
    completion = client.chat.completions.create(
        model="qwen3.5-omni-plus",
        messages=\[{
            "role": "user",
            "content": "请查询今天的日期和星期，并告诉我今天有哪些重要节日"
        }],
        stream=True,
        stream\_options={"include\_usage": True},
        # 开启联网搜索
        extra\_body={
            "enable\_search": True
        }
    )
    print("模型回复（包含实时信息）：")
    for chunk in completion:
        if chunk.choices and chunk.choices\[0].delta.content:
            print(chunk.choices\[0].delta.content, end="")
    print()
except Exception as e:
    print(f"请求失败: {e}")
```

Node.js

```
// 运行前的准备工作:
// npm install openai
import OpenAI from "openai";
// 初始化客户端
const openai = new OpenAI({
    apiKey: process.env.DASHSCOPE\_API\_KEY,
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1"
});
// 发起请求（开启联网搜索）
const completion = await openai.chat.completions.create({
    model: "qwen3.5-omni-plus",
    messages: \[{
        "role": "user",
        "content": "请查询今天的日期和星期，并告诉我今天有哪些重要节日"
    }],
    stream: true,
    stream\_options: {
        include\_usage: true
    },
    // 开启联网搜索
    extra\_body: {
        enable\_search: true
    }
});
console.log("模型回复（包含实时信息）：");
for await (const chunk of completion) {
    if (Array.isArray(chunk.choices) \&\& chunk.choices.length > 0) {
        if (chunk.choices\[0].delta.content) {
            process.stdout.write(chunk.choices\[0].delta.content);
        }
    }
}
console.log();
```

curl

```
curl -X POST https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions \\
\-H "Authorization: Bearer $DASHSCOPE\_API\_KEY" \\
\-H "Content-Type: application/json" \\
\-d '{
    "model": "qwen3.5-omni-plus",
    "messages": \[
        {
            "role": "user",
            "content": "请查询今天的日期和星期，并告诉我今天有哪些重要节日"
        }
    ],
    "stream": true,
    "stream\_options": {
        "include\_usage": true
    },
    "enable\_search": true
}'
```

\## \*\*多轮对话\*\*
您在使用 Qwen-Omni 模型的多轮对话功能时，需要注意：
\-   Assistant Message
    添加到 messages 数组中的 Assistant Message 只可以包含文本数据。
\-   User Message
    一条 User Message 只可以包含文本和一种模态的数据，在多轮对话中您可以在不同的 User Message 中输入不同模态的数据。
---
*← 返回 [README](./README.md)*
