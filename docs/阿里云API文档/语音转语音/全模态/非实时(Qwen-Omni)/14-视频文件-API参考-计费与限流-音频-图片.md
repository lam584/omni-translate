> 来源：`非实时(Qwen-Omni).md`
\## 视频文件
以保存在本地的\[spring\\\_mountain.mp4](https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20250326/fqojlv/spring\_mountain.mp4)为例。
Python

```
import os
from openai import OpenAI
import base64
import numpy as np
import soundfile as sf
client = OpenAI(
    # 若没有配置环境变量，请用阿里云百炼API Key将下行替换为：api\_key="sk-xxx",
    api\_key=os.getenv("DASHSCOPE\_API\_KEY"),
    base\_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
)
\#  Base64 编码格式
def encode\_video(video\_path):
    with open(video\_path, "rb") as video\_file:
        return base64.b64encode(video\_file.read()).decode("utf-8")
base64\_video = encode\_video("spring\_mountain.mp4")
completion = client.chat.completions.create(
    model="qwen3.5-omni-plus", # 模型为Qwen3-Omni-Flash时，请在非思考模式下运行
    messages=\[
        {
            "role": "user",
            "content": \[
                {
                    "type": "video\_url",
                    "video\_url": {"url": f"data:;base64,{base64\_video}"},
                },
                {"type": "text", "text": "她在唱什么"},
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

```
import OpenAI from "openai";
import { readFileSync } from 'fs';
const openai = new OpenAI(
    {
        // 若没有配置环境变量，请用阿里云百炼API Key将下行替换为：apiKey: "sk-xxx",
        apiKey: process.env.DASHSCOPE\_API\_KEY,
        baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1"
    }
);
const encodeVideo = (videoPath) => {
    const videoFile = readFileSync(videoPath);
    return videoFile.toString('base64');
};
const base64Video = encodeVideo("spring\_mountain.mp4")
const completion = await openai.chat.completions.create({
    model: "qwen3.5-omni-plus",  // 模型为Qwen3-Omni-Flash时，请在非思考模式下运行
    messages: \[
        {
            "role": "user",
            "content": \[{
                "type": "video\_url",
                "video\_url": { "url": `data:;base64,${base64Video}` },
            },
            { "type": "text", "text": "她在唱什么" }]
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

\## API参考
关于千问Omni 模型的输入输出参数，请参见\[OpenAI Chat](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)。
\## 计费与限流
\*\*计费规则\*\*
Qwen-Omni模型根据不同模态（音频、图像、视频）对应的Token数计费。计费详情请参见百炼控制台。
\*\*音频、图片与视频转换为Token数的规则\*\*
\## 音频
\-   `Qwen3.5-Omni系列`：
    -   输入音频计算公式：`总 Tokens 数 = 音频时长（单位：秒）\* 7`
    -   输出音频计算公式：`总 Tokens 数 = 音频时长（单位：秒）\* 12.5`
\-   `Qwen3-Omni-Flash：输入与输出音频的计算公式均为总 Tokens 数 = 音频时长（单位：秒）\* 12.5`
\-   `Qwen-Omni-Turbo：输入与输出音频的计算公式均为总 Tokens 数 = 音频时长（单位：秒）\* 25`
若音频时长不足1秒，则按 1 秒计算。
\## 图片
\-   `Qwen3.5-Omni系列`、`Qwen3-Omni-Flash`模型\*\*：\*\*每`32x32`像素对应 1 个 Token
\-   `Qwen-Omni-Turbo`模型：每`28x28`像素对应 1 个 Token
Qwen3.5-Omni 系列一张图最少需要 24 个 Token，其他模型最少需要 4 个 Token；默认最多支持 1280 个 Token。Qwen3.5-Omni 系列支持通过 `vl\_high\_resolution\_images` 参数提升图片分辨率上限至 16384 个 Token（Qwen-Omni-Turbo、Qwen3-Omni-Flash 不支持该参数）。可使用以下代码，传入图像路径即可估算单张图片消耗的 Token 总量：

```
import math
from PIL import Image  # pip install Pillow
\# ============ 模型参数配置（按需修改） ============
\# 图像因子：Qwen3.5-Omni系列、Qwen3-Omni-Flash 为 32；Qwen-Omni-Turbo 为 28
IMAGE\_FACTOR = 32
\# Token 下限：Qwen3.5-Omni系列为 24；Qwen-Omni-Turbo、Qwen3-Omni-Flash 为 4
MIN\_TOKENS = 24
\# 高分辨率模式（仅 Qwen3.5-Omni 系列支持，Qwen-Omni-Turbo 和 Qwen3-Omni-Flash 不支持）
\# True  → Token 上限 16384
\# False → Token 上限 1280（默认）
VL\_HIGH\_RESOLUTION\_IMAGES = False
\# ============ 像素范围（由上方参数自动计算） ============
MIN\_PIXELS = MIN\_TOKENS \* IMAGE\_FACTOR \* IMAGE\_FACTOR
MAX\_PIXELS = (16384 if VL\_HIGH\_RESOLUTION\_IMAGES else 1280) \* IMAGE\_FACTOR \* IMAGE\_FACTOR
def smart\_resize(height, width, factor=IMAGE\_FACTOR,
                 min\_pixels=MIN\_PIXELS, max\_pixels=MAX\_PIXELS):
    """将图像宽高对齐到 factor 整数倍，并缩放到 \[min\_pixels, max\_pixels] 范围内。"""
    h\_bar = max(factor, round(height / factor) \* factor)
    w\_bar = max(factor, round(width / factor) \* factor)
    if h\_bar \* w\_bar > max\_pixels:
        beta = math.sqrt((height \* width) / max\_pixels)
        h\_bar = math.floor(height / beta / factor) \* factor
        w\_bar = math.floor(width / beta / factor) \* factor
    elif h\_bar \* w\_bar < min\_pixels:
        beta = math.sqrt(min\_pixels / (height \* width))
        h\_bar = math.ceil(height \* beta / factor) \* factor
        w\_bar = math.ceil(width \* beta / factor) \* factor
    return h\_bar, w\_bar
if \_\_name\_\_ == "\_\_main\_\_":
    image = Image.open("xxx/test.jpg")
    print(f"原始尺寸：{image.width}x{image.height}")
    resized\_h, resized\_w = smart\_resize(image.height, image.width)
    token = int(resized\_h \* resized\_w / (IMAGE\_FACTOR \* IMAGE\_FACTOR)) + 2
    print(f"缩放后尺寸：{resized\_w}x{resized\_h}，Token 数：{token}")
```

---
*← 返回 [README](./README.md)*
