> 来源：`语音合成-千问.md`
\## Python

```
\# coding=utf-8
\#
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
import dashscope
import pyaudio
import time
import base64
import numpy as np
\# 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：https://dashscope-intl.aliyuncs.com/api/v1
dashscope.base\_http\_api\_url = 'https://dashscope.aliyuncs.com/api/v1'
p = pyaudio.PyAudio()
\# 创建音频流
stream = p.open(format=pyaudio.paInt16,
                channels=1,
                rate=24000,
                output=True)
text = "你好啊，我是千问"
response = dashscope.MultiModalConversation.call(
    # 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
    # 若没有配置环境变量，请用百炼API Key将下行替换为：api\_key = "sk-xxx"
    api\_key=os.getenv("DASHSCOPE\_API\_KEY"),
    # 如需使用指令控制功能，请将model替换为qwen3-tts-instruct-flash
    model="qwen3-tts-flash",
    text=text,
    voice="Cherry",
    language\_type="Chinese",  # 建议与文本语种一致，以获得正确的发音和自然的语调。
    # 如需使用指令控制功能，请取消下方注释，并将model替换为qwen3-tts-instruct-flash
    # instructions='语速较快，带有明显的上扬语调，适合介绍时尚产品。',
    # optimize\_instructions=True,
    stream=True
)
for chunk in response:
    if chunk.output is not None:
      audio = chunk.output.audio
      if audio.data is not None:
          wav\_bytes = base64.b64decode(audio.data)
          audio\_np = np.frombuffer(wav\_bytes, dtype=np.int16)
          # 直接播放音频数据
          stream.write(audio\_np.tobytes())
      if chunk.output.finish\_reason == "stop":
          print("finish at: {} ", chunk.output.audio.expires\_at)
time.sleep(0.8)
\# 清理资源
stream.stop\_stream()
stream.close()
p.terminate()
```

\## cURL

```
\# ======= 重要提示 =======
\# 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
\# 新加坡地域和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
\# === 执行时请删除该注释 ===
curl -X POST 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation' \\
\-H "Authorization: Bearer $DASHSCOPE\_API\_KEY" \\
\-H 'Content-Type: application/json' \\
\-H 'X-DashScope-SSE: enable' \\
\-d '{
    "model": "qwen3-tts-flash",
    "input": {
        "text": "那我来给大家推荐一款T恤，这款呢真的是超级好看，这个颜色呢很显气质，而且呢也是搭配的绝佳单品，大家可以闭眼入，真的是非常好看，对身材的包容性也很好，不管啥身材的宝宝呢，穿上去都是很好看的。推荐宝宝们下单哦。",
        "voice": "Cherry",
        "language\_type": "Chinese"
    }
}'
```

---
*← 返回 [README](./README.md)*
