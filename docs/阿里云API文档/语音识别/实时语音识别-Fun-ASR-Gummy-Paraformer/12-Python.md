> 来源：`实时语音识别-Fun-ASR-Gummy-Paraformer.md`
\## Python
运行Python示例前，需要通过`pip install pyaudio`命令安装第三方音频播放与采集套件。

```
import pyaudio
import dashscope
from dashscope.audio.asr import \*
\# 若没有将API Key配置到环境变量中，需将下面这行代码注释放开， 并将your-api-key替换为自己的API Key
\# dashscope.api\_key = "your-api-key"
mic = None
stream = None
class Callback(TranslationRecognizerCallback):
    def on\_open(self) -> None:
        global mic
        global stream
        print("TranslationRecognizerCallback open.")
        mic = pyaudio.PyAudio()
        stream = mic.open(
            format=pyaudio.paInt16, channels=1, rate=16000, input=True
        )
    def on\_close(self) -> None:
        global mic
        global stream
        print("TranslationRecognizerCallback close.")
        stream.stop\_stream()
        stream.close()
        mic.terminate()
        stream = None
        mic = None
    def on\_event(
        self,
        request\_id,
        transcription\_result: TranscriptionResult,
        translation\_result: TranslationResult,
        usage,
    ) -> None:
        print("request id: ", request\_id)
        print("usage: ", usage)
        if translation\_result is not None:
            print(
                "translation\_languages: ",
                translation\_result.get\_language\_list(),
            )
            english\_translation = translation\_result.get\_translation("en")
            print("sentence id: ", english\_translation.sentence\_id)
            print("translate to english: ", english\_translation.text)
            if english\_translation.vad\_pre\_end:
                print("vad pre end {}, {}, {}".format(transcription\_result.pre\_end\_start\_time, transcription\_result.pre\_end\_end\_time, transcription\_result.pre\_end\_timemillis))
        if transcription\_result is not None:
            print("sentence id: ", transcription\_result.sentence\_id)
            print("transcription: ", transcription\_result.text)
callback = Callback()
translator = TranslationRecognizerChat(
    model="gummy-chat-v1",
    format="pcm",
    sample\_rate=16000,
    transcription\_enabled=True,
    translation\_enabled=True,
    translation\_target\_languages=\["en"],
    callback=callback,
)
translator.start()
print("请您通过麦克风讲话体验一句话语音识别和翻译功能")
while True:
    if stream:
        data = stream.read(3200, exception\_on\_overflow=False)
        if not translator.send\_audio\_frame(data):
            print("sentence end, stop sending")
            break
    else:
        break
translator.stop()
```

---
*← 返回 [README](./README.md)*
