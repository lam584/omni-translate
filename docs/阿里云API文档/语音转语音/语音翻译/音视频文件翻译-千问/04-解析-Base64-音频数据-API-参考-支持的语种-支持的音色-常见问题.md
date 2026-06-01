> 来源：`音视频文件翻译-千问.md`
\## \*\*解析 Base64 音频数据\*\*
模型以流式 Base64 编码格式输出音频。可采用以下两种方式处理数据：
\-   \*\*拼接解码：\*\*拼接所有返回的 Base64 片段，待生成结束后统一解码，保存为音频文件。
\-   \*\*实时播放：\*\*实时解码每个 Base64 片段并直接播放。
Python

```
\# Installation instructions for pyaudio:
\# APPLE Mac OS X
\#   brew install portaudio
\#   pip install pyaudio
\# Debian/Ubuntu
\#   sudo apt-get install python-pyaudio python3-pyaudio
\#   or
\#   pip install pyaudio
\# CentOS
\#   sudo yum install -y portaudio portaudio-devel \&\& pip install pyaudio
\# Microsoft Windows
\#   python -m pip install pyaudio
import os
from openai import OpenAI
import base64
import numpy as np
import soundfile as sf
\# 初始化OpenAI客户端
client = OpenAI(
    # 若没有配置环境变量，请用阿里云百炼API Key将下行替换为：api\_key="sk-xxx",
    api\_key=os.getenv("DASHSCOPE\_API\_KEY"),
    # 以下是北京地域base\_url，如果使用新加坡地域的模型，需要将base\_url替换为：https://dashscope-intl.aliyuncs.com/compatible-mode/v1
    base\_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
)
messages = \[
    {
        "role": "user",
        "content": \[
            {
                "type": "input\_audio",
                "input\_audio": {
                    "data": "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20250211/tixcef/cherry.wav",
                    "format": "wav",
                },
            }
        ],
    }
]
completion = client.chat.completions.create(
    model="qwen3-livetranslate-flash",
    messages=messages,
    modalities=\["text", "audio"],
    audio={"voice": "Cherry", "format": "wav"},
    stream=True,
    stream\_options={"include\_usage": True},
    extra\_body={"translation\_options": {"source\_lang": "zh", "target\_lang": "en"}},
)
\# 方式1: 待生成结束后再进行解码
audio\_string = ""
for chunk in completion:
    if chunk.choices:
        if hasattr(chunk.choices\[0].delta, "audio"):
            try:
                audio\_string += chunk.choices\[0].delta.audio\["data"]
            except Exception as e:
                print(chunk.choices\[0].delta.audio\["transcript"])
    else:
        print(chunk.usage)
wav\_bytes = base64.b64decode(audio\_string)
audio\_np = np.frombuffer(wav\_bytes, dtype=np.int16)
sf.write("audio\_assistant\_py.wav", audio\_np, samplerate=24000)
\# 方式2: 边生成边解码(使用方式2请将方式1的代码进行注释)
\# # 初始化 PyAudio
\# import pyaudio
\# import time
\# p = pyaudio.PyAudio()
\# # 创建音频流
\# stream = p.open(format=pyaudio.paInt16,
\#                 channels=1,
\#                 rate=24000,
\#                 output=True)
\# for chunk in completion:
\#     if chunk.choices:
\#         if hasattr(chunk.choices\[0].delta, "audio"):
\#             try:
\#                 audio\_string = chunk.choices\[0].delta.audio\["data"]
\#                 wav\_bytes = base64.b64decode(audio\_string)
\#                 audio\_np = np.frombuffer(wav\_bytes, dtype=np.int16)
\#                 # 直接播放音频数据
\#                 stream.write(audio\_np.tobytes())
\#             except Exception as e:
\#                 print(chunk.choices\[0].delta.audio\["transcript"])
\# time.sleep(0.8)
\# # 清理资源
\# stream.stop\_stream()
\# stream.close()
\# p.terminate()
```

Node.js

```
// 运行前的准备工作:
// Windows/Mac/Linux 通用:
// 1. 确保已安装 Node.js (建议版本 >= 14)
// 2. 运行以下命令安装必要的依赖:
//    npm install openai wav
//
// 如果要使用实时播放功能 (方式2), 还需要:
// Windows:
//    npm install speaker
// Mac:
//    brew install portaudio
//    npm install speaker
// Linux (Ubuntu/Debian):
//    sudo apt-get install libasound2-dev
//    npm install speaker
import OpenAI from "openai";
const client = new OpenAI({
    // 若没有配置环境变量，请用阿里云百炼API Key将下行替换为：apiKey: "sk-xxx",
    apiKey: process.env.DASHSCOPE\_API\_KEY,
    // 以下是北京地域base\_url，如果使用新加坡地域的模型，需要将base\_url替换为：https://dashscope-intl.aliyuncs.com/compatible-mode/v1
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
});
// ---------------- 音频输入 ----------------
const messages = \[
    {
        role: "user",
        content: \[
            {
                type: "input\_audio",
                input\_audio: {
                    data: "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20250211/tixcef/cherry.wav",
                    format: "wav",
                },
            },
        ],
    },
];
const completion = await client.chat.completions.create({
    model: "qwen3-livetranslate-flash",
    messages: messages,
    modalities: \["text", "audio"],
    audio: { voice: "Cherry", format: "wav" },
    stream: true,
    stream\_options: { include\_usage: true },
    translation\_options: { source\_lang: "zh", target\_lang: "en" },
});
// 方式1: 待生成结束后再进行解码
// 需要安装: npm install wav
import { createWriteStream } from 'node:fs';  // node:fs 是 Node.js 内置模块，无需安装
import { Writer } from 'wav';
async function convertAudio(audioString, audioPath) {
    try {
        // 解码Base64字符串为Buffer
        const wavBuffer = Buffer.from(audioString, 'base64');
        // 创建WAV文件写入流
        const writer = new Writer({
            sampleRate: 24000,  // 采样率
            channels: 1,        // 单声道
            bitDepth: 16        // 16位深度
        });
        // 创建输出文件流并建立管道连接
        const outputStream = createWriteStream(audioPath);
        writer.pipe(outputStream);
        // 写入PCM数据并结束写入
        writer.write(wavBuffer);
        writer.end();
        // 使用Promise等待文件写入完成
        await new Promise((resolve, reject) => {
            outputStream.on('finish', resolve);
            outputStream.on('error', reject);
        });
        // 添加额外等待时间确保音频完整
        await new Promise(resolve => setTimeout(resolve, 800));
        console.log(`音频文件已成功保存为 ${audioPath}`);
    } catch (error) {
        console.error('处理过程中发生错误:', error);
    }
}
let audioString = "";
for await (const chunk of completion) {
    if (Array.isArray(chunk.choices) \&\& chunk.choices.length > 0) {
        if (chunk.choices\[0].delta.audio) {
            if (chunk.choices\[0].delta.audio\["data"]) {
                audioString += chunk.choices\[0].delta.audio\["data"];
            }
        }
    } else {
        console.log(chunk.usage);
    }
}
// 执行转换
convertAudio(audioString, "audio\_assistant\_mjs.wav");
// 方式2: 边生成边实时播放
// 需要先按照上方系统对应的说明安装必要组件
// import Speaker from 'speaker'; // 引入音频播放库
// // 创建扬声器实例（配置与 WAV 文件参数一致）
// const speaker = new Speaker({
//     sampleRate: 24000,  // 采样率
//     channels: 1,        // 声道数
//     bitDepth: 16,       // 位深
//     signed: true        // 有符号 PCM
// });
// for await (const chunk of completion) {
//     if (Array.isArray(chunk.choices) \&\& chunk.choices.length > 0) {
//         if (chunk.choices\[0].delta.audio) {
//             if (chunk.choices\[0].delta.audio\["data"]) {
//                 const pcmBuffer = Buffer.from(chunk.choices\[0].delta.audio.data, 'base64');
//                 // 直接写入扬声器播放
//                 speaker.write(pcmBuffer);
//             }
//         }
//     } else {
//         console.log(chunk.usage);
//     }
// }
// speaker.on('finish', () => console.log('播放完成'));
// speaker.end(); // 根据实际 API 流结束情况调用
```

\## \*\*API 参考\*\*
qwen3-livetranslate-flash 模型的输入输出参数请参见\[音视频翻译-通义千问](https://help.aliyun.com/zh/model-studio/qwen3-livetranslate-flash-api)。
\## \*\*支持的语种\*\*
下表中的语种代码可用于指定源语种与目标语种。
> 部分目标语种仅支持输出文本，不支持输出音频。

| \*\*语种代码\*\* | \*\*语种\*\* | \*\*支持的输出模态\*\* |
| --- | --- | --- |
| en  | 英语  | 音频、文本 |
| zh  | 中文  | 音频、文本 |
| ru  | 俄语  | 音频、文本 |
| fr  | 法语  | 音频、文本 |
| de  | 德语  | 音频、文本 |
| pt  | 葡萄牙语 | 音频、文本 |
| es  | 西班牙语 | 音频、文本 |
| it  | 意大利语 | 音频、文本 |
| id  | 印尼语 | 文本  |
| ko  | 韩语  | 音频、文本 |
| ja  | 日语  | 音频、文本 |
| vi  | 越南语 | 文本  |
| th  | 泰语  | 文本  |
| ar  | 阿拉伯语 | 文本  |
| yue | 粤语  | 音频、文本 |
| hi  | 印地语 | 文本  |
| el  | 希腊语 | 文本  |
| tr  | 土耳其语 | 文本  |

\## \*\*支持的音色\*\*

| \*\*音色名\*\* | `\*\*voice\*\*`\*\*参数\*\* | \*\*音色效果\*\* | \*\*描述\*\* | \*\*支持的语种\*\* |
| --- | --- | --- | --- | --- |
| 芊悦  | Cherry |     | 阳光积极、亲切自然小姐姐。 | 中文、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 |
| 不吃鱼 | Nofish |     | 不会翘舌音的设计师。 | 中文、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 |
| 上海-阿珍 | Jada |     | 风风火火的沪上阿姐。 | 中文  |
| 北京-晓东 | Dylan |     | 北京胡同里长大的少年。 | 中文  |
| 四川-晴儿 | Sunny |     | 甜到你心里的川妹子。 | 中文  |
| 天津-李彼得 | Peter |     | 天津相声，专业捧人。 | 中文  |
| 粤语-阿清 | Kiki |     | 甜美的港妹闺蜜。 | 粤语  |
| 四川-程川 | Eric |     | 一个跳脱市井的四川成都男子。 | 中文  |

\## \*\*常见问题\*\*
\### \*\*Q：传入视频文件时，翻译的是什么内容？\*\*
A：翻译视频中的音频内容，视觉信息用于辅助上下文理解，以提升准确率。
\*\*示例\*\*：
当音频内容为`This is a mask`时：
\-   若画面显示口罩，会翻译为“这是一个口罩”；
\-   若画面显示面具，会翻译为“这是一个面具”。
---
*← 返回 [README](./README.md)*
