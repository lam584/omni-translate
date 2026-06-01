> 来源：`实时语音合成-千问.md`
\## Python
\### \*\*server commit模式\*\*

```
import os
import base64
import threading
import time
import dashscope
from dashscope.audio.qwen\_tts\_realtime import \*
qwen\_tts\_realtime: QwenTtsRealtime = None
text\_to\_synthesize = \[
    '对吧\~我就特别喜欢这种超市，',
    '尤其是过年的时候',
    '去逛超市',
    '就会觉得',
    '超级超级开心！',
    '想买好多好多的东西呢！'
]
DO\_VIDEO\_TEST = False
def init\_dashscope\_api\_key():
    """
        Set your DashScope API-key. More information:
        https://github.com/aliyun/alibabacloud-bailian-speech-demo/blob/master/PREREQUISITES.md
    """
    # 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
    if 'DASHSCOPE\_API\_KEY' in os.environ:
        dashscope.api\_key = os.environ\[
            'DASHSCOPE\_API\_KEY']  # load API-key from environment variable DASHSCOPE\_API\_KEY
    else:
        dashscope.api\_key = 'your-dashscope-api-key'  # set API-key manually
class MyCallback(QwenTtsRealtimeCallback):
    def \_\_init\_\_(self):
        self.complete\_event = threading.Event()
        self.file = open('result\_24k.pcm', 'wb')
    def on\_open(self) -> None:
        print('connection opened, init player')
    def on\_close(self, close\_status\_code, close\_msg) -> None:
        self.file.close()
        print('connection closed with code: {}, msg: {}, destroy player'.format(close\_status\_code, close\_msg))
    def on\_event(self, response: str) -> None:
        try:
            global qwen\_tts\_realtime
            type = response\['type']
            if 'session.created' == type:
                print('start session: {}'.format(response\['session']\['id']))
            if 'response.audio.delta' == type:
                recv\_audio\_b64 = response\['delta']
                self.file.write(base64.b64decode(recv\_audio\_b64))
            if 'response.done' == type:
                print(f'response {qwen\_tts\_realtime.get\_last\_response\_id()} done')
            if 'session.finished' == type:
                print('session finished')
                self.complete\_event.set()
        except Exception as e:
            print('\[Error] {}'.format(e))
            return
    def wait\_for\_finished(self):
        self.complete\_event.wait()
if \_\_name\_\_  == '\_\_main\_\_':
    init\_dashscope\_api\_key()
    print('Initializing ...')
    callback = MyCallback()
    qwen\_tts\_realtime = QwenTtsRealtime(
        # 如需使用指令控制功能，请将model替换为qwen3-tts-instruct-flash-realtime
        model='qwen3-tts-flash-realtime',
        callback=callback,
        # 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime
        url='wss://dashscope.aliyuncs.com/api-ws/v1/realtime'
        )
    qwen\_tts\_realtime.connect()
    qwen\_tts\_realtime.update\_session(
        voice = 'Cherry',
        response\_format = AudioFormat.PCM\_24000HZ\_MONO\_16BIT,
        # 如需使用指令控制功能，请取消下方注释，并将model替换为qwen3-tts-instruct-flash-realtime
        # instructions='语速较快，带有明显的上扬语调，适合介绍时尚产品。',
        # optimize\_instructions=True,
        mode = 'server\_commit'
    )
    for text\_chunk in text\_to\_synthesize:
        print(f'send text: {text\_chunk}')
        qwen\_tts\_realtime.append\_text(text\_chunk)
        time.sleep(0.1)
    qwen\_tts\_realtime.finish()
    callback.wait\_for\_finished()
    print('\[Metric] session: {}, first audio delay: {}'.format(
                    qwen\_tts\_realtime.get\_session\_id(),
                    qwen\_tts\_realtime.get\_first\_audio\_delay(),
                    ))
```

\### \*\*commit模式\*\*

```
import base64
import os
import threading
import dashscope
from dashscope.audio.qwen\_tts\_realtime import \*
qwen\_tts\_realtime: QwenTtsRealtime = None
text\_to\_synthesize = \[
    '这是第一句话。',
    '这是第二句话。',
    '这是第三句话。',
]
DO\_VIDEO\_TEST = False
def init\_dashscope\_api\_key():
    """
        Set your DashScope API-key. More information:
        https://github.com/aliyun/alibabacloud-bailian-speech-demo/blob/master/PREREQUISITES.md
    """
    # 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
    if 'DASHSCOPE\_API\_KEY' in os.environ:
        dashscope.api\_key = os.environ\[
            'DASHSCOPE\_API\_KEY']  # load API-key from environment variable DASHSCOPE\_API\_KEY
    else:
        dashscope.api\_key = 'your-dashscope-api-key'  # set API-key manually
class MyCallback(QwenTtsRealtimeCallback):
    def \_\_init\_\_(self):
        super().\_\_init\_\_()
        self.response\_counter = 0
        self.complete\_event = threading.Event()
        self.file = open(f'result\_{self.response\_counter}\_24k.pcm', 'wb')
    def reset\_event(self):
        self.response\_counter += 1
        self.file = open(f'result\_{self.response\_counter}\_24k.pcm', 'wb')
        self.complete\_event = threading.Event()
    def on\_open(self) -> None:
        print('connection opened, init player')
    def on\_close(self, close\_status\_code, close\_msg) -> None:
        print('connection closed with code: {}, msg: {}, destroy player'.format(close\_status\_code, close\_msg))
    def on\_event(self, response: str) -> None:
        try:
            global qwen\_tts\_realtime
            type = response\['type']
            if 'session.created' == type:
                print('start session: {}'.format(response\['session']\['id']))
            if 'response.audio.delta' == type:
                recv\_audio\_b64 = response\['delta']
                self.file.write(base64.b64decode(recv\_audio\_b64))
            if 'response.done' == type:
                print(f'response {qwen\_tts\_realtime.get\_last\_response\_id()} done')
                self.complete\_event.set()
                self.file.close()
            if 'session.finished' == type:
                print('session finished')
                self.complete\_event.set()
        except Exception as e:
            print('\[Error] {}'.format(e))
            return
    def wait\_for\_response\_done(self):
        self.complete\_event.wait()
if \_\_name\_\_  == '\_\_main\_\_':
    init\_dashscope\_api\_key()
    print('Initializing ...')
    callback = MyCallback()
    qwen\_tts\_realtime = QwenTtsRealtime(
        # 如需使用指令控制功能，请将model替换为qwen3-tts-instruct-flash-realtime
        model='qwen3-tts-flash-realtime',
        callback=callback,
        # 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime
        url='wss://dashscope.aliyuncs.com/api-ws/v1/realtime'
        )
    qwen\_tts\_realtime.connect()
    qwen\_tts\_realtime.update\_session(
        voice = 'Cherry',
        response\_format = AudioFormat.PCM\_24000HZ\_MONO\_16BIT,
        # 如需使用指令控制功能，请取消下方注释，并将model替换为qwen3-tts-instruct-flash-realtime
        # instructions='语速较快，带有明显的上扬语调，适合介绍时尚产品。',
        # optimize\_instructions=True,
        mode = 'commit'
    )
    print(f'send text: {text\_to\_synthesize\[0]}')
    qwen\_tts\_realtime.append\_text(text\_to\_synthesize\[0])
    qwen\_tts\_realtime.commit()
    callback.wait\_for\_response\_done()
    callback.reset\_event()
    print(f'send text: {text\_to\_synthesize\[1]}')
    qwen\_tts\_realtime.append\_text(text\_to\_synthesize\[1])
    qwen\_tts\_realtime.commit()
    callback.wait\_for\_response\_done()
    callback.reset\_event()
    print(f'send text: {text\_to\_synthesize\[2]}')
    qwen\_tts\_realtime.append\_text(text\_to\_synthesize\[2])
    qwen\_tts\_realtime.commit()
    callback.wait\_for\_response\_done()
    qwen\_tts\_realtime.finish()
    print('\[Metric] session: {}, first audio delay: {}'.format(
                    qwen\_tts\_realtime.get\_session\_id(),
                    qwen\_tts\_realtime.get\_first\_audio\_delay(),
                    ))
```

---
*← 返回 [README](./README.md)*
