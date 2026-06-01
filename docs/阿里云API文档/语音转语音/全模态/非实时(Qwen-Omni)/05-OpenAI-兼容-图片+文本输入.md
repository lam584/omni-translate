> 来源：`非实时(Qwen-Omni).md`
\## OpenAI 兼容
Python

```
import os
from openai import OpenAI
\# 初始化OpenAI客户端
client = OpenAI(
    # 若没有配置环境变量，请用阿里云百炼API Key将下行替换为：api\_key="sk-xxx",
    # 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
    api\_key=os.getenv("DASHSCOPE\_API\_KEY"),
    # 以下是北京地域base\_url，如果使用新加坡地域的模型，需要将base\_url替换为：https://dashscope-intl.aliyuncs.com/compatible-mode/v1
    base\_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
)
completion = client.chat.completions.create(
    model="qwen3.5-omni-plus", # 模型为Qwen3-Omni-Flash时，请在非思考模式下运行
    messages=\[
        {
            "role": "user",
            "content": \[
                {
                    "type": "video",
                    "video": \[
                        "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20241108/xzsgiz/football1.jpg",
                        "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20241108/tdescd/football2.jpg",
                        "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20241108/zefdja/football3.jpg",
                        "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20241108/aedbqh/football4.jpg",
                    ],
                },
                {"type": "text", "text": "描述这个视频的具体过程"},
            ],
        }
    ],
    # 设置输出数据的模态，当前支持两种：\["text","audio"]、\["text"]
    modalities=\["text", "audio"],
    audio={"voice": "Tina", "format": "wav"},
    # stream 必须设置为 True，否则会报错
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
const openai = new OpenAI({
     // 若没有配置环境变量，请用阿里云百炼API Key将下行替换为：apiKey: "sk-xxx",
    // 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
    apiKey: process.env.DASHSCOPE\_API\_KEY,
    // 以下是北京地域base\_url，如果使用新加坡地域的模型，需要将base\_url替换为：https://dashscope-intl.aliyuncs.com/compatible-mode/v1
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
});
const completion = await openai.chat.completions.create({
    model: "qwen3.5-omni-plus",  // 模型为Qwen3-Omni-Flash时，请在非思考模式下运行
    messages: \[{
        role: "user",
        content: \[
            {
                type: "video",
                video: \[
                    "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20241108/xzsgiz/football1.jpg",
                    "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20241108/tdescd/football2.jpg",
                    "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20241108/zefdja/football3.jpg",
                    "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20241108/aedbqh/football4.jpg"
                ]
            },
            {
                type: "text",
                text: "描述这个视频的具体过程"
            }
        ]
    }],
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
\# ======= 重要提示 =======
\# 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
\# 以下是北京地域base\_url，如果使用新加坡地域的模型，需要将base\_url替换为：https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions
\# === 执行时请删除该注释 ===
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
                    "type": "video",
                    "video": \[
                        "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20241108/xzsgiz/football1.jpg",
                        "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20241108/tdescd/football2.jpg",
                        "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20241108/zefdja/football3.jpg",
                        "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20241108/aedbqh/football4.jpg"
                    ]
                },
                {
                    "type": "text",
                    "text": "描述这个视频的具体过程"
                }
            ]
        }
    ],
    "stream": true,
    "stream\_options": {
        "include\_usage": true
    },
    "modalities": \["text", "audio"],
    "audio": {
        "voice": "Tina",
        "format": "wav"
    }
}'
```

\## \*\*图片+文本输入\*\*
Qwen-Omni 模型支持传入多张图片。对输入图片的要求如下：
\-   图片数量：
    -   公网URL传入：最多可传入 2048 张
    -   Base64 编码：最多可传入 250 张
\-   图像大小：
    -   使用公网 URL 方式：
        -   Qwen3.5-Omni系列：单个图片文件的大小不超过 20MB
        -   Qwen3-Omni-Flash系列、Qwen-Omni-Turbo系列：单个图片文件的大小不超过 10MB
    -   使用 Base64 编码方式：编码后的 Base64 字符串大小必须小于 10MB；
\-   图片的宽度和高度均应大于 10 像素，宽高比不应超过 200:1 或 1:200
\-   支持的图片类型请参见\[图像与视频理解](https://help.aliyun.com/zh/model-studio/vision#afa499b5b1rl5)
以下示例代码以传入图片公网 URL 为例，传入本地图片请参见：\[输入 Base64 编码的本地文件](#c516d1e824x03)。当前只支持以流式输出的方式进行调用。
---
*← 返回 [README](./README.md)*
