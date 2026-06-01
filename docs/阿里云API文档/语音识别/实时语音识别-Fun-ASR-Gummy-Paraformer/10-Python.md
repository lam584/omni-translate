> 来源：`实时语音识别-Fun-ASR-Gummy-Paraformer.md`
\## Python

```
import os
import requests
from http import HTTPStatus
import dashscope
from dashscope.audio.asr import \*
\# 若没有将API Key配置到环境变量中，需将your-api-key替换为自己的API Key
\# dashscope.api\_key = "your-api-key"
r = requests.get(
    "https://dashscope.oss-cn-beijing.aliyuncs.com/samples/audio/paraformer/hello\_world\_female2.wav"
)
with open("asr\_example.wav", "wb") as f:
    f.write(r.content)
class Callback(TranslationRecognizerCallback):
    def on\_open(self) -> None:
        print("TranslationRecognizerCallback open.")
    def on\_close(self) -> None:
        print("TranslationRecognizerCallback close.")
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
        if transcription\_result is not None:
            print("sentence id: ", transcription\_result.sentence\_id)
            print("transcription: ", transcription\_result.text)
    def on\_error(self, message) -> None:
        print('error: {}'.format(message))
    def on\_complete(self) -> None:
        print('TranslationRecognizerCallback complete')
callback = Callback()
translator = TranslationRecognizerRealtime(
    model="gummy-realtime-v1",
    format="wav",
    sample\_rate=16000,
    callback=callback,
)
translator.start()
try:
    audio\_data: bytes = None
    f = open("asr\_example.wav", 'rb')
    if os.path.getsize("asr\_example.wav"):
        while True:
            audio\_data = f.read(12800)
            if not audio\_data:
                break
            else:
                translator.send\_audio\_frame(audio\_data)
    else:
        raise Exception(
            'The supplied file was empty (zero bytes long)')
    f.close()
except Exception as e:
    raise e
translator.stop()
```

---
*← 返回 [README](./README.md)*
