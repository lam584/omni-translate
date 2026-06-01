> 来源：`非实时(Qwen-Omni).md`
\## OpenAI 兼容
Python

```
import os
from openai import OpenAI
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
                    "type": "image\_url",
                    "image\_url": {
                        "url": "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20241022/emyrja/dog\_and\_girl.jpeg"
                    },
                },
                {"type": "text", "text": "图中描绘的是什么景象？"},
            ],
        },
    ],
    # 设置输出数据的模态，当前支持两种：\["text","audio"]、\["text"]
    modalities=\["text", "audio"],
    audio={"voice": "Tina", "format": "wav"},
    # stream 必须设置为 True，否则会报错
    stream=True,
    stream\_options={
        "include\_usage": True
    }
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
        // 若没有配置环境变量，请用阿里云百炼API Key将下行替换为：apiKey: "sk-xxx",
        // 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
        apiKey: process.env.DASHSCOPE\_API\_KEY,
        // 以下是北京地域base\_url，如果使用新加坡地域的模型，需要将base\_url替换为：https://dashscope-intl.aliyuncs.com/compatible-mode/v1
        baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1"
    }
);
const completion = await openai.chat.completions.create({
    // 模型为Qwen3-Omni-Flash时，请在非思考模式下运行
    model: "qwen3.5-omni-plus",
    messages: \[
        {
            "role": "user",
            "content": \[{
                "type": "image\_url",
                "image\_url": { "url": "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20241022/emyrja/dog\_and\_girl.jpeg" },
            },
            { "type": "text", "text": "图中描绘的是什么景象？" }]
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
          "type": "image\_url",
          "image\_url": {
            "url": "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20241022/emyrja/dog\_and\_girl.jpeg"
          }
        },
        {
          "type": "text",
          "text": "图中描绘的是什么景象？"
        }
      ]
    }
  ],
    "stream":true,
    "stream\_options":{
        "include\_usage":true
    },
    "modalities":\["text","audio"],
    "audio":{"voice":"Tina","format":"wav"}
}'
```

\## \*\*开启/关闭思考模式\*\*
Qwen-Omni系列模型中，仅Qwen3-Omni-Flash 模型属于混合思考模型，通过`enable\_thinking`参数控制是否开启思考模式：
\-   `true`：开启思考模式
\-   `false`（默认）：关闭思考模式
> 在思考模式下，\*\*不支持输出音频。\*\*
---
*← 返回 [README](./README.md)*
