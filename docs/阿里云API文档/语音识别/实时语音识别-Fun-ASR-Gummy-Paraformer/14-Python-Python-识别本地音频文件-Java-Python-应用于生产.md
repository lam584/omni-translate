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
translator = TranslationRecognizerChat(
    model="gummy-chat-v1",
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
                if translator.send\_audio\_frame(audio\_data):
                    print("send audio frame success")
                else:
                    print("sentence end, stop sending")
                    break
    else:
        raise Exception(
            'The supplied file was empty (zero bytes long)')
    f.close()
except Exception as e:
    raise e
translator.stop()
```

\## Python
运行Python示例前，需要通过`pip install pyaudio`命令安装第三方音频播放与采集套件。

```
import pyaudio
from dashscope.audio.asr import (Recognition, RecognitionCallback,
                                 RecognitionResult)
\# 若没有将API Key配置到环境变量中，需将下面这行代码注释放开，并将apiKey替换为自己的API Key
\# import dashscope
\# dashscope.api\_key = "apiKey"
mic = None
stream = None
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
    def on\_event(self, result: RecognitionResult) -> None:
        print('RecognitionCallback sentence: ', result.get\_sentence())
callback = Callback()
recognition = Recognition(model='paraformer-realtime-v2',
                          format='pcm',
                          sample\_rate=16000,
                          callback=callback)
recognition.start()
while True:
    if stream:
        data = stream.read(3200, exception\_on\_overflow=False)
        recognition.send\_audio\_frame(data)
    else:
        break
recognition.stop()
```

\## 识别本地音频文件
实时语音识别可以识别本地音频文件并输出识别结果。对于对话聊天、控制口令、语音输入法、语音搜索等较短的准实时语音识别场景可考虑采用该接口进行语音识别。
\## Java

```
import com.alibaba.dashscope.audio.asr.recognition.Recognition;
import com.alibaba.dashscope.audio.asr.recognition.RecognitionParam;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
public class Main {
    public static void main(String\[] args) {
        // 用户可忽略url下载文件部分，可以直接使用本地文件进行相关api调用进行识别
        String exampleWavUrl =
                "https://dashscope.oss-cn-beijing.aliyuncs.com/samples/audio/paraformer/hello\_world\_female2.wav";
        try {
            InputStream in = new URL(exampleWavUrl).openStream();
            Files.copy(in, Paths.get("asr\_example.wav"), StandardCopyOption.REPLACE\_EXISTING);
        } catch (IOException e) {
            System.out.println("error: " + e);
            System.exit(1);
        }
        // 创建Recognition实例
        Recognition recognizer = new Recognition();
        // 创建RecognitionParam
        RecognitionParam param =
                RecognitionParam.builder()
                        // 若没有将API Key配置到环境变量中，需将下面这行代码注释放开，并将apiKey替换为自己的API Key
                        // .apiKey("apikey")
                        .model("paraformer-realtime-v2")
                        .format("wav")
                        .sampleRate(16000)
                        // “language\_hints”只支持paraformer-v2和paraformer-realtime-v2模型
                        .parameter("language\_hints", new String\[]{"zh", "en"})
                        .build();
        try {
            System.out.println("识别结果：" + recognizer.call(param, new File("asr\_example.wav")));
        } catch (Exception e) {
            e.printStackTrace();
        }
        System.exit(0);
    }
}
```

\## Python

```
import requests
from http import HTTPStatus
from dashscope.audio.asr import Recognition
\# 若没有将API Key配置到环境变量中，需将下面这行代码注释放开，并将apiKey替换为自己的API Key
\# import dashscope
\# dashscope.api\_key = "apiKey"
\# 用户可忽略从url下载文件这部分代码，直接使用本地文件进行识别
r = requests.get(
    'https://dashscope.oss-cn-beijing.aliyuncs.com/samples/audio/paraformer/hello\_world\_female2.wav'
)
with open('asr\_example.wav', 'wb') as f:
    f.write(r.content)
recognition = Recognition(model='paraformer-realtime-v2',
                          format='wav',
                          sample\_rate=16000,
                          # “language\_hints”只支持paraformer-v2和paraformer-realtime-v2模型
                          language\_hints=\['zh', 'en'],
                          callback=None)
result = recognition.call('asr\_example.wav')
if result.status\_code == HTTPStatus.OK:
    print('识别结果：')
    print(result.get\_sentence())
else:
    print('Error: ', result.message)
```

\## 应用于生产环境
\### 提升识别效果
\-   \*\*选择正确采样率的模型\*\*：8kHz 的电话音频应直接使用 8kHz 模型，而不是升采样到 16kHz 再识别，这样可以避免信息失真，获得更佳效果。
\-   \*\*使用热词功能\*\*：针对业务中的专有名词、人名、品牌名等，配置热词可以显著提升识别准确率，详情请参见\[定制热词](https://help.aliyun.com/zh/model-studio/custom-hot-words/)。
\-   \*\*优化输入音频质量\*\*：尽量使用高质量的麦克风，并确保录音环境信噪比高、无回声。在应用层面，可以集成降噪（如RNNoise）、回声消除（AEC）等算法对音频进行预处理，以获得更纯净的音频。
\-   \*\*明确指定识别语种\*\*：对于Paraformer-v2等支持多语种的模型，如果在调用时能预先确定音频的语种（如使用\[Language\\\_hints](https://help.aliyun.com/zh/model-studio/paraformer-real-time-speech-recognition-python-sdk#1f66c2882by8w)参数指定语种为［'zh','en'］），可以帮助模型收敛，避免在相似发音的语种间混淆，提升准确性。
\-   \*\*语气词过滤\*\*：对于Paraformer模型，可以通过设置参数\[disfluency\\\_removal\\\_enabled](https://help.aliyun.com/zh/model-studio/paraformer-real-time-speech-recognition-python-sdk#1f66c2882by8w)开启语气词过滤功能，获得更书面、更易读的文本结果。
\### 设置容错策略
\-   \*\*客户端重连\*\*：客户端应实现断线自动重连机制，以应对网络抖动。以Python SDK为例，您可以参考如下建议：
    1.  捕获异常：在`Callback`类中实现`on\_error`方法。当`dashscope` SDK遇到网络错误或其他问题时，会调用该方法。
    2.  状态通知：当`on\_error`被触发时，设置重连信号。在Python中可以使用`threading.Event`，它是一种线程安全的信号标志。
    3.  重连循环：将主逻辑包裹在一个`for`循环中（例如重试3次）。当检测到重连信号后，当前轮次的识别会中断，清理资源，然后等待几秒钟，再次进入循环，创建一个全新的连接。
\-   \*\*设置心跳防止连接断开：\*\*当需要与服务端保持长连接时，可将参数\[heartbeat](https://help.aliyun.com/zh/model-studio/paraformer-real-time-speech-recognition-python-sdk)设置为`true`，即使音频中长时间没有声音，与服务端的连接也不会中断。
\-   \*\*模型限流\*\*：在调用模型接口时请注意模型的\[限流](https://help.aliyun.com/zh/model-studio/rate-limit)规则。
\## \*\*API参考\*\*
\-   \[Fun-ASR实时语音识别API参考](https://help.aliyun.com/zh/model-studio/fun-asr-real-time-speech-recognition-api-reference/)
\-   \[Gummy实时长语音识别API参考](https://help.aliyun.com/zh/model-studio/real-time-speech-recognition-and-translation-api-reference/)
\-   \[Gummy实时短语音（一句话）识别API参考](https://help.aliyun.com/zh/model-studio/sentence-recognition-and-translation-api-reference/)
\-   \[Paraformer实时语音识别API参考](https://help.aliyun.com/zh/model-studio/paraformer-real-time-speech-recognition-api-reference/)
\## \*\*模型功能特性对比\*\*

| \*\*功能/特性\*\* | \*\*Fun-ASR\*\* | \*\*Gummy\*\* | \*\*Paraformer\*\* |
| --- | --- | --- | --- |
| \*\*支持语言\*\* | 因模型而异： - fun-asr-realtime、fun-asr-realtime-2026-02-28、fun-asr-realtime-2025-11-07：中文（普通话、粤语、吴语、闽南语、客家话、赣语、湘语、晋语；并支持中原、西南、冀鲁、江淮、兰银、胶辽、东北、北京、港台等，包括河南、陕西、湖北、四川、重庆、云南、贵州、广东、广西、河北、天津、山东、安徽、南京、江苏、杭州、甘肃、宁夏等地区官话口音）、英文、日语 - fun-asr-realtime-2025-09-15：中文（普通话）、英文 - fun-asr-flash-8k-realtime、fun-asr-flash-8k-realtime-2026-01-28：中文 | 中文、英文、日语、韩语、法语、德语、西班牙语、意大利语、俄语、粤语、葡萄牙语、印尼语、阿拉伯语、泰语、印地语、丹麦语、乌尔都语、土耳其语、荷兰语、马来语、越南语 | 因模型而异： - paraformer-realtime-v2：中文（普通话、粤语、吴语、闽南语、东北话、甘肃话、贵州话、河南话、湖北话、湖南话、宁夏话、山西话、陕西话、山东话、四川话、天津话、江西话、云南话、上海话）、英文、日语、韩语、德语、法语、俄语 - paraformer-realtime-v1、paraformer-realtime-8k-v2、paraformer-realtime-8k-v1：中文（普通话） |
| \*\*支持的音频格式\*\* | pcm、wav、mp3、opus、speex、aac、amr |   |   |
| \*\*采样率\*\* | 因模型而异： - fun-asr-realtime、fun-asr-realtime-2026-02-28、fun-asr-realtime-2025-11-07、fun-asr-realtime-2025-09-15：16kHz - fun-asr-flash-8k-realtime、fun-asr-flash-8k-realtime-2026-01-28：8kHz | 因模型而异： - gummy-realtime-v1：≥ 16kHz - gummy-chat-v1：16kHz | 因模型而异： - paraformer-realtime-v2：任意采样率 - paraformer-realtime-v1：16kHz - paraformer-realtime-8k-v2、paraformer-realtime-8k-v1：8kHz |
| \*\*声道\*\* | 单声道 |   |   |
| \*\*输入形式\*\* | 二进制音频流 |   |   |
| \*\*音频大小/时长\*\* | 不限  | 因模型而异： - gummy-realtime-v1：不限 - gummy-chat-v1：1分钟以内 | 不限  |
| \*\*情感识别\*\* | 不支持 |   | 因模型而异： - paraformer-realtime-v2、paraformer-realtime-v1、paraformer-realtime-8k-v1：不支持 - paraformer-realtime-8k-v2：支持 默认开启，可关闭 |
| \*\*敏感词过滤\*\* | 不支持 |   |   |
| \*\*说话人分离\*\* | 不支持 |   |   |
| \*\*语气词过滤\*\* | 不支持 |   | 支持 默认关闭，可开启 |
| \*\*时间戳\*\* | 支持 固定开启 |   |   |
| \*\*标点符号预测\*\* | 支持 固定开启 |   | 因模型而异： - paraformer-realtime-v2、paraformer-realtime-8k-v2：支持 默认开启，可关闭 - paraformer-realtime-v1、paraformer-realtime-8k-v1：支持 固定开启 |
| \*\*热词\*\* | 支持 \*\*重要\*\* 新加坡地域的子业务空间暂不支持热词功能。 |   |   |
| \*\*ITN\*\* | 支持 固定开启 |   |   |
| \*\*VAD\*\* | 支持 固定开启 |   |   |
| \*\*限流（RPS）\*\* | 20  | 10  | 20  |
| \*\*接入方式\*\* | Java/Python/Android/iOS SDK、WebSocket API |   |   |
| \*\*价格\*\* | 因模型而异： - fun-asr-realtime、fun-asr-realtime-2026-02-28、fun-asr-realtime-2025-11-07： - 中国内地：0.00033元/秒 - 国际：0.00066元/秒 - fun-asr-realtime-2025-09-15： - 中国内地：0.00033元/秒 - fun-asr-flash-8k-realtime、fun-asr-flash-8k-realtime-2026-01-28： - 中国内地：0.00022元/秒 | 中国内地：0.00015元/秒 | 中国内地：0.00024元/秒 |

/\\\* 让引用上下间距调小，避免内容显示过于稀疏 \\\*/ .unionContainer .markdown-body blockquote { margin: 4px 0; } .aliyun-docs-content table.qwen blockquote { border-left: none; /\\\* 添加这一行来移除表格里的引用文字的左侧边框 \\\*/ padding-left: 5px; /\\\* 左侧内边距 \\\*/ margin: 4px 0; }
 span.aliyun-docs-icon { color: transparent !important; font-size: 0 !important; } span.aliyun-docs-icon:before { color: black; font-size: 16px; } span.aliyun-docs-icon.icon-size-20:before { font-size: 20px; } span.aliyun-docs-icon.icon-size-22:before { font-size: 22px; } span.aliyun-docs-icon.icon-size-24:before { font-size: 24px; } span.aliyun-docs-icon.icon-size-26:before { font-size: 26px; } span.aliyun-docs-icon.icon-size-28:before { font-size: 28px; }
---
*← 返回 [README](./README.md)*
