> 来源：`实时语音合成-千问.md`
\## Python

```
\# coding=utf-8
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
import pyaudio
import os
import requests
import base64
import pathlib
import threading
import time
import dashscope
from dashscope.audio.qwen\_tts\_realtime import QwenTtsRealtime, QwenTtsRealtimeCallback, AudioFormat
\# ======= 常量配置 =======
DEFAULT\_TARGET\_MODEL = "qwen3-tts-vc-realtime-2026-01-15"  # 声音复刻、语音合成要使用相同的模型
DEFAULT\_PREFERRED\_NAME = "guanyu"
DEFAULT\_AUDIO\_MIME\_TYPE = "audio/mpeg"
VOICE\_FILE\_PATH = "voice.mp3"  # 用于声音复刻的本地音频文件的相对路径
TEXT\_TO\_SYNTHESIZE = \[
    '对吧\~我就特别喜欢这种超市，',
    '尤其是过年的时候',
    '去逛超市',
    '就会觉得',
    '超级超级开心！',
    '想买好多好多的东西呢！'
]
def create\_voice(file\_path: str,
                 target\_model: str = DEFAULT\_TARGET\_MODEL,
                 preferred\_name: str = DEFAULT\_PREFERRED\_NAME,
                 audio\_mime\_type: str = DEFAULT\_AUDIO\_MIME\_TYPE) -> str:
    """
    创建音色，并返回 voice 参数
    """
    # 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
    # 若没有配置环境变量，请用百炼API Key将下行替换为：api\_key = "sk-xxx"
    api\_key = os.getenv("DASHSCOPE\_API\_KEY")
    file\_path\_obj = pathlib.Path(file\_path)
    if not file\_path\_obj.exists():
        raise FileNotFoundError(f"音频文件不存在: {file\_path}")
    base64\_str = base64.b64encode(file\_path\_obj.read\_bytes()).decode()
    data\_uri = f"data:{audio\_mime\_type};base64,{base64\_str}"
    # 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：https://dashscope-intl.aliyuncs.com/api/v1/services/audio/tts/customization
    url = "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization"
    payload = {
        "model": "qwen-voice-enrollment", # 不要修改该值
        "input": {
            "action": "create",
            "target\_model": target\_model,
            "preferred\_name": preferred\_name,
            "audio": {"data": data\_uri}
        }
    }
    headers = {
        "Authorization": f"Bearer {api\_key}",
        "Content-Type": "application/json"
    }
    resp = requests.post(url, json=payload, headers=headers)
    if resp.status\_code != 200:
        raise RuntimeError(f"创建 voice 失败: {resp.status\_code}, {resp.text}")
    try:
        return resp.json()\["output"]\["voice"]
    except (KeyError, ValueError) as e:
        raise RuntimeError(f"解析 voice 响应失败: {e}")
def init\_dashscope\_api\_key():
    """
    初始化 dashscope SDK 的 API key
    """
    # 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
    # 若没有配置环境变量，请用百炼API Key将下行替换为：dashscope.api\_key = "sk-xxx"
    dashscope.api\_key = os.getenv("DASHSCOPE\_API\_KEY")
\# ======= 回调类 =======
class MyCallback(QwenTtsRealtimeCallback):
    """
    自定义 TTS 流式回调
    """
    def \_\_init\_\_(self):
        self.complete\_event = threading.Event()
        self.\_player = pyaudio.PyAudio()
        self.\_stream = self.\_player.open(
            format=pyaudio.paInt16, channels=1, rate=24000, output=True
        )
    def on\_open(self) -> None:
        print('\[TTS] 连接已建立')
    def on\_close(self, close\_status\_code, close\_msg) -> None:
        self.\_stream.stop\_stream()
        self.\_stream.close()
        self.\_player.terminate()
        print(f'\[TTS] 连接关闭 code={close\_status\_code}, msg={close\_msg}')
    def on\_event(self, response: dict) -> None:
        try:
            event\_type = response.get('type', '')
            if event\_type == 'session.created':
                print(f'\[TTS] 会话开始: {response\["session"]\["id"]}')
            elif event\_type == 'response.audio.delta':
                audio\_data = base64.b64decode(response\['delta'])
                self.\_stream.write(audio\_data)
            elif event\_type == 'response.done':
                print(f'\[TTS] 响应完成, Response ID: {qwen\_tts\_realtime.get\_last\_response\_id()}')
            elif event\_type == 'session.finished':
                print('\[TTS] 会话结束')
                self.complete\_event.set()
        except Exception as e:
            print(f'\[Error] 处理回调事件异常: {e}')
    def wait\_for\_finished(self):
        self.complete\_event.wait()
\# ======= 主执行逻辑 =======
if \_\_name\_\_ == '\_\_main\_\_':
    init\_dashscope\_api\_key()
    print('\[系统] 初始化 Qwen TTS Realtime ...')
    callback = MyCallback()
    qwen\_tts\_realtime = QwenTtsRealtime(
        model=DEFAULT\_TARGET\_MODEL,
        callback=callback,
        # 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime
        url='wss://dashscope.aliyuncs.com/api-ws/v1/realtime'
    )
    qwen\_tts\_realtime.connect()
    qwen\_tts\_realtime.update\_session(
        voice=create\_voice(VOICE\_FILE\_PATH), # 将voice参数替换为复刻生成的专属音色
        response\_format=AudioFormat.PCM\_24000HZ\_MONO\_16BIT,
        mode='server\_commit'
    )
    for text\_chunk in TEXT\_TO\_SYNTHESIZE:
        print(f'\[发送文本]: {text\_chunk}')
        qwen\_tts\_realtime.append\_text(text\_chunk)
        time.sleep(0.1)
    qwen\_tts\_realtime.finish()
    callback.wait\_for\_finished()
    print(f'\[Metric] session\_id={qwen\_tts\_realtime.get\_session\_id()}, '
          f'first\_audio\_delay={qwen\_tts\_realtime.get\_first\_audio\_delay()}s')
```

---
*← 返回 [README](./README.md)*
