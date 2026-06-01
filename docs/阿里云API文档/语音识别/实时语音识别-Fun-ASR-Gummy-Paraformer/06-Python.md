> 来源：`实时语音识别-Fun-ASR-Gummy-Paraformer.md`
\## Python
示例中用到的音频为：\[asr\\\_example.wav](https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20250210/acoict/asr\_example.wav)。

```
import os
import time
import dashscope
from dashscope.audio.asr import \*
\# 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
\# 若没有配置环境变量，请用百炼API Key将下行替换为：dashscope.api\_key = "sk-xxx"
dashscope.api\_key = os.environ.get('DASHSCOPE\_API\_KEY')
\# 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference
dashscope.base\_websocket\_api\_url = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference'
from datetime import datetime
def get\_timestamp():
    now = datetime.now()
    formatted\_timestamp = now.strftime("\[%Y-%m-%d %H:%M:%S.%f]")
    return formatted\_timestamp
class Callback(RecognitionCallback):
    def on\_complete(self) -> None:
        print(get\_timestamp() + ' Recognition completed')  # recognition complete
    def on\_error(self, result: RecognitionResult) -> None:
        print('Recognition task\_id: ', result.request\_id)
        print('Recognition error: ', result.message)
        exit(0)
    def on\_event(self, result: RecognitionResult) -> None:
        sentence = result.get\_sentence()
        if 'text' in sentence:
            print(get\_timestamp() + ' RecognitionCallback text: ', sentence\['text'])
        if RecognitionResult.is\_sentence\_end(sentence):
            print(get\_timestamp() +
                  'RecognitionCallback sentence end, request\_id:%s, usage:%s'
                  % (result.get\_request\_id(), result.get\_usage(sentence)))
callback = Callback()
recognition = Recognition(model='fun-asr-realtime',
                          format='wav',
                          sample\_rate=16000,
                          callback=callback)
try:
    audio\_data: bytes = None
    f = open("asr\_example.wav", 'rb')
    if os.path.getsize("asr\_example.wav"):
        # 一次性将文件数据全部读入buffer
        file\_buffer = f.read()
        f.close()
        print("Start Recognition")
        recognition.start()
        # 从buffer中间隔3200字节发送一次
        buffer\_size = len(file\_buffer)
        offset = 0
        chunk\_size = 3200
        while offset < buffer\_size:
            # 计算本次要发送的数据块大小
            remaining\_bytes = buffer\_size - offset
            current\_chunk\_size = min(chunk\_size, remaining\_bytes)
            # 从buffer中提取当前数据块
            audio\_data = file\_buffer\[offset:offset + current\_chunk\_size]
            # 发送音频数据帧
            recognition.send\_audio\_frame(audio\_data)
            # 更新偏移量
            offset += current\_chunk\_size
            # 添加延迟模拟实时传输
            time.sleep(0.1)
        recognition.stop()
    else:
        raise Exception(
            'The supplied file was empty (zero bytes long)')
except Exception as e:
    raise e
print(
    '\[Metric] requestId: {}, first package delay ms: {}, last package delay ms: {}'
    .format(
        recognition.get\_last\_request\_id(),
        recognition.get\_first\_package\_delay(),
        recognition.get\_last\_package\_delay(),
    ))
```

---
*← 返回 [README](./README.md)*
