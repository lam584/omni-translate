> 来源：`实时语音识别-Fun-ASR-Gummy-Paraformer.md`
\## Python
运行Python示例前，需要通过`pip install pyaudio`命令安装第三方音频播放与采集套件。

```
import os
import signal  # for keyboard events handling (press "Ctrl+c" to terminate recording)
import sys
import dashscope
import pyaudio
from dashscope.audio.asr import \*
mic = None
stream = None
\# Set recording parameters
sample\_rate = 16000  # sampling rate (Hz)
channels = 1  # mono channel
dtype = 'int16'  # data type
format\_pcm = 'pcm'  # the format of the audio data
block\_size = 3200  # number of frames per buffer
\# Real-time speech recognition callback
class Callback(RecognitionCallback):
    def on\_open(self) -> None:
        global mic
        global stream
        print('RecognitionCallback open.')
        mic = pyaudio.PyAudio()
        stream = mic.open(format=pyaudio.paInt16,
                          channels=1,
                          rate=16000,
                          input=True)
    def on\_close(self) -> None:
        global mic
        global stream
        print('RecognitionCallback close.')
        stream.stop\_stream()
        stream.close()
        mic.terminate()
        stream = None
        mic = None
    def on\_complete(self) -> None:
        print('RecognitionCallback completed.')  # recognition completed
    def on\_error(self, message) -> None:
        print('RecognitionCallback task\_id: ', message.request\_id)
        print('RecognitionCallback error: ', message.message)
        # Stop and close the audio stream if it is running
        if 'stream' in globals() and stream.active:
            stream.stop()
            stream.close()
        # Forcefully exit the program
        sys.exit(1)
    def on\_event(self, result: RecognitionResult) -> None:
        sentence = result.get\_sentence()
        if 'text' in sentence:
            print('RecognitionCallback text: ', sentence\['text'])
            if RecognitionResult.is\_sentence\_end(sentence):
                print(
                    'RecognitionCallback sentence end, request\_id:%s, usage:%s'
                    % (result.get\_request\_id(), result.get\_usage(sentence)))
def signal\_handler(sig, frame):
    print('Ctrl+c pressed, stop recognition ...')
    # Stop recognition
    recognition.stop()
    print('Recognition stopped.')
    print(
        '\[Metric] requestId: {}, first package delay ms: {}, last package delay ms: {}'
        .format(
            recognition.get\_last\_request\_id(),
            recognition.get\_first\_package\_delay(),
            recognition.get\_last\_package\_delay(),
        ))
    # Forcefully exit the program
    sys.exit(0)
\# main function
if \_\_name\_\_ == '\_\_main\_\_':
    # 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
    # 若没有配置环境变量，请用百炼API Key将下行替换为：dashscope.api\_key = "sk-xxx"
    dashscope.api\_key = os.environ.get('DASHSCOPE\_API\_KEY')
    # 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference
    dashscope.base\_websocket\_api\_url='wss://dashscope.aliyuncs.com/api-ws/v1/inference'
    # Create the recognition callback
    callback = Callback()
    # Call recognition service by async mode, you can customize the recognition parameters, like model, format,
    # sample\_rate
    recognition = Recognition(
        model='fun-asr-realtime',
        format=format\_pcm,
        # 'pcm'、'wav'、'opus'、'speex'、'aac'、'amr', you can check the supported formats in the document
        sample\_rate=sample\_rate,
        # support 8000, 16000
        semantic\_punctuation\_enabled=False,
        callback=callback)
    # Start recognition
    recognition.start()
    signal.signal(signal.SIGINT, signal\_handler)
    print("Press 'Ctrl+c' to stop recording and recognition...")
    # Create a keyboard listener until "Ctrl+c" is pressed
    while True:
        if stream:
            data = stream.read(3200, exception\_on\_overflow=False)
            recognition.send\_audio\_frame(data)
        else:
            break
    recognition.stop()
```

---
*← 返回 [README](./README.md)*
