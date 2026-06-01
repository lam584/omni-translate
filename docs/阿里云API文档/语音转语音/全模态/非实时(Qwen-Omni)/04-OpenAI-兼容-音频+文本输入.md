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
                    "type": "video\_url",
                    "video\_url": {
                        "url": "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20241115/cqqkru/1.mp4"
                    },
                },
                {"type": "text", "text": "视频的内容是什么?"},
            ],
        },
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
          "type": "video\_url",
          "video\_url": {
            "url": "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20241115/cqqkru/1.mp4"
          }
        },
        {
          "type": "text",
          "text": "视频的内容是什么"
        }
      ]
    }
  ],
    "stream":true,
    "stream\_options": {
        "include\_usage": true
    },
    "modalities":\["text","audio"],
    "audio":{"voice":"Tina","format":"wav"}
}'
```

\#### \*\*图片列表形式\*\*
\*\*图片数量\*\*
\-   Qwen3.5-Omni系列：最少传入 2 张图片，最多可传入 2048 张图片
\-   Qwen3-Omni-Flash：最少传入 2 张图片，最多可传入 128 张图片
\-   Qwen-Omni-Turbo：最少传入 4 张图片，最多可传入 80 张图片
\## \*\*音频+文本输入\*\*
\-   文件数量：
    -   Qwen3.5-Omni系列：使用公网URL方式，最多可传入 2048 个；使用Base64编码方式，最多可传入 250 个；
    -   Qwen3-Omni-Flash系列、Qwen-Omni-Turbo系列：仅支持输入一个；
\-   文件大小：
    -   使用公网 URL 方式：
        -   Qwen3.5-Omni系列：不超过 2GB
        -   Qwen3-Omni-Flash：不超过 100MB
        -   Qwen-Omni-Turbo：不超过 10MB
    -   使用 Base64 编码方式：编码后的 Base64 字符串大小必须小于 10MB
\-   时长限制：
    -   Qwen3.5-Omni系列：最长 3 小时
    -   Qwen3-Omni-Flash：最长 20 分钟
    -   Qwen-Omni-Turbo：最长 3 分钟
\-   文件格式：支持AMR、 WAV、 3GP、 3GPP、 AAC、 MP3等主流格式
以下示例代码以传入音频公网 URL 为例，传入本地音频请参见：\[输入 Base64 编码的本地文件](#c516d1e824x03)。当前只支持以流式输出的方式进行调用。
---
*← 返回 [README](./README.md)*
