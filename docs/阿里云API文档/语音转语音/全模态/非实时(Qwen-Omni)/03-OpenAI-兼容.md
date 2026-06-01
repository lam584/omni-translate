> 来源：`非实时(Qwen-Omni).md`
\## OpenAI 兼容
Python

```
import os
from openai import OpenAI
client = OpenAI(
    api\_key=os.getenv("DASHSCOPE\_API\_KEY"),
    base\_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
)
completion = client.chat.completions.create(
    model="qwen3.5-omni-plus",
    messages=\[
        {
            "role": "user",
            "content": \[
                {
                    "type": "image\_url",
                    "image\_url": {
                        "url": "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20241022/emyrja/dog\_and\_girl.jpeg"
                    },
                },
                {
                    "type": "input\_audio",
                    "input\_audio": {
                        "data": "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20250211/tixcef/cherry.wav",
                        "format": "wav"
                    },
                },
                {"type": "text", "text": "请描述图片内容，并告诉我音频在说什么。"},
            ],
        },
    ],
    modalities=\["text", "audio"],
    audio={"voice": "Tina", "format": "wav"},
    stream=True,
    stream\_options={"include\_usage": True},
)
for chunk in completion:
    if chunk.choices:
        print(chunk.choices\[0].delta)
    else:
        print(chunk.usage)
```

Node.js

```
import OpenAI from "openai";
const openai = new OpenAI(
    {
        apiKey: process.env.DASHSCOPE\_API\_KEY,
        baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1"
    }
);
const completion = await openai.chat.completions.create({
    model: "qwen3.5-omni-plus",
    messages: \[
        {
            "role": "user",
            "content": \[
                {
                    "type": "image\_url",
                    "image\_url": { "url": "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20241022/emyrja/dog\_and\_girl.jpeg" },
                },
                {
                    "type": "input\_audio",
                    "input\_audio": {
                        "data": "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20250211/tixcef/cherry.wav",
                        "format": "wav"
                    },
                },
                { "type": "text", "text": "请描述图片内容，并告诉我音频在说什么。" }
            ]
        }
    ],
    stream: true,
    stream\_options: {
        include\_usage: true
    },
    modalities: \["text", "audio"],
    audio: { voice: "Tina", format: "wav" }
});
for await (const chunk of completion) {
    if (Array.isArray(chunk.choices) \&\& chunk.choices.length > 0) {
        console.log(chunk.choices\[0].delta);
    } else {
        console.log(chunk.usage);
    }
}
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
            "content": \[
                {
                    "type": "image\_url",
                    "image\_url": {
                        "url": "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20241022/emyrja/dog\_and\_girl.jpeg"
                    }
                },
                {
                    "type": "input\_audio",
                    "input\_audio": {
                        "data": "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20250211/tixcef/cherry.wav",
                        "format": "wav"
                    }
                },
                {
                    "type": "text",
                    "text": "请描述图片内容，并告诉我音频在说什么。"
                }
            ]
        }
    ],
    "stream": true,
    "stream\_options": {
        "include\_usage": true
    },
    "modalities": \["text", "audio"],
    "audio": {"voice": "Tina", "format": "wav"}
}'
```

---
*← 返回 [README](./README.md)*
