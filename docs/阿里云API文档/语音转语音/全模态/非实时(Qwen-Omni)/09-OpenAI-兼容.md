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
    model="qwen3-omni-flash",
    messages=\[{"role": "user", "content": "你是谁"}],
    # 开启/关闭思考模式，在思考模式下不支持输出音频；qwen-omni-turbo不支持设置enable\_thinking。
    extra\_body={'enable\_thinking': True},
    # 设置输出数据的模态，非思考模式下当前支持两种：\["text","audio"]、\["text"]，思考模式仅支持：\["text"]
    modalities=\["text"],
    # 设置音色，思考模式下不支持设置audio参数
    # audio={"voice": "Tina", "format": "wav"},
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
     // 若没有配置环境变量，请用阿里云百炼API Key将下行替换为：apiKey:"sk-xxx",
    // 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
    apiKey: process.env.DASHSCOPE\_API\_KEY,
    // 以下是北京地域base\_url，如果使用新加坡地域的模型，需要将base\_url替换为：https://dashscope-intl.aliyuncs.com/compatible-mode/v1
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
});
const completion = await openai.chat.completions.create({
    model: "qwen3-omni-flash",
    messages: \[
        { role: "user", content: "你是谁？" }
    ],
    // stream 必须设置为 True，否则会报错
    stream: true,
    stream\_options: {
        include\_usage: true
    },
    // 开启/关闭思考模式，在思考模式下不支持输出音频；qwen-omni-turbo不支持设置enable\_thinking。
    extra\_body:{'enable\_thinking': true},
    //  设置输出数据的模态，非思考模式下当前支持两种：\["text","audio"]、\["text"]，思考模式仅支持：\["text"]
    modalities: \["text"],
    // 设置音色，思考模式下不支持设置audio参数
    //audio: { voice: "Tina", format: "wav" }
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
    "model": "qwen3-omni-flash",
    "messages": \[
        {
            "role": "user",
            "content": "你是谁？"
        }
    ],
    "stream":true,
    "stream\_options":{
        "include\_usage":true
    },
    "modalities":\["text"],
    "enable\_thinking": true
}'
```

\*\*返回结果\*\*

```
data: {"choices":\[{"delta":{"content":null,"role":"assistant","reasoning\_content":""},"index":0,"logprobs":null,"finish\_reason":null}],"object":"chat.completion.chunk","usage":null,"created":1757937336,"system\_fingerprint":null,"model":"qwen3-omni-flash","id":"chatcmpl-ce3d6fe5-e717-4b7e-8b40-3aef12288d4c"}
data: {"choices":\[{"finish\_reason":null,"logprobs":null,"delta":{"content":null,"reasoning\_content":"嗯"},"index":0}],"object":"chat.completion.chunk","usage":null,"reated":1757937336,"system\_fingerprint":null,"model":"qwen3-omni-flash","id":"chatcmpl-ce3d6fe5-e717-4b7e-8b40-3aef12288d4c"}
data: {"choices":\[{"delta":{"content":null,"reasoning\_content":"，"},"finish\_reason":null,"index":0,"logprobs":null}],"object":"chat.completion.chunk","usage":null,"reated":1757937336,"system\_fingerprint":null,"model":"qwen3-omni-flash","id":"chatcmpl-ce3d6fe5-e717-4b7e-8b40-3aef12288d4c"}
......
data: {"choices":\[{"delta":{"content":"告诉我"},"finish\_reason":null,"index":0,"logprobs":null}],"object":"chat.completion.chunk","usage":null,"created":1757937336,"tem\_fingerprint":null,"model":"qwen3-omni-flash","id":"chatcmpl-ce3d6fe5-e717-4b7e-8b40-3aef12288d4c"}
data: {"choices":\[{"delta":{"content":"！"},"finish\_reason":null,"index":0,"logprobs":null}],"object":"chat.completion.chunk","usage":null,"created":1757937336,"systm\_fingerprint":null,"model":"qwen3-omni-flash","id":"chatcmpl-ce3d6fe5-e717-4b7e-8b40-3aef12288d4c"}
data: {"choices":\[{"finish\_reason":"stop","delta":{"content":"","reasoning\_content":null},"index":0,"logprobs":null}],"object":"chat.completion.chunk","usage":null,"created":1757937336,"system\_fingerprint":null,"model":"qwen3-omni-flash","id":"chatcmpl-ce3d6fe5-e717-4b7e-8b40-3aef12288d4c"}
data: {"choices":\[],"object":"chat.completion.chunk","usage":{"prompt\_tokens":11,"completion\_tokens":363,"total\_tokens":374,"completion\_tokens\_details":{"reasoning\_tokens":195,"text\_tokens":168},"prompt\_tokens\_details":{"text\_tokens":11}},"created":1757937336,"system\_fingerprint":null,"model":"qwen3-omni-flash","id":"chatcmpl-ce3d6fe5-e717-4b7e-8b40-3aef12288d4c"}
```

---
*← 返回 [README](./README.md)*
