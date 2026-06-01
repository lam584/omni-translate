> 来源：`实时(Qwen-Omni-Realtime).md`
\## Manual 模式
OmniWithoutServerVad.java

```
// DashScope Java SDK 版本不低于2.20.9
import com.alibaba.dashscope.audio.omni.\*;
import com.alibaba.dashscope.exception.NoApiKeyException;
import com.google.gson.JsonObject;
import javax.sound.sampled.\*;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashMap;
import java.util.Queue;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
public class OmniWithoutServerVad {
    // RealtimePcmPlayer 类定义开始
    public static class RealtimePcmPlayer {
        private int sampleRate;
        private SourceDataLine line;
        private AudioFormat audioFormat;
        private Thread decoderThread;
        private Thread playerThread;
        private AtomicBoolean stopped = new AtomicBoolean(false);
        private Queue<String> b64AudioBuffer = new ConcurrentLinkedQueue<>();
        private Queue<byte\[]> RawAudioBuffer = new ConcurrentLinkedQueue<>();
        // 构造函数初始化音频格式和音频线路
        public RealtimePcmPlayer(int sampleRate) throws LineUnavailableException {
            this.sampleRate = sampleRate;
            this.audioFormat = new AudioFormat(this.sampleRate, 16, 1, true, false);
            DataLine.Info info = new DataLine.Info(SourceDataLine.class, audioFormat);
            line = (SourceDataLine) AudioSystem.getLine(info);
            line.open(audioFormat);
            line.start();
            decoderThread = new Thread(new Runnable() {
                @Override
                public void run() {
                    while (!stopped.get()) {
                        String b64Audio = b64AudioBuffer.poll();
                        if (b64Audio != null) {
                            byte\[] rawAudio = Base64.getDecoder().decode(b64Audio);
                            RawAudioBuffer.add(rawAudio);
                        } else {
                            try {
                                Thread.sleep(100);
                            } catch (InterruptedException e) {
                                throw new RuntimeException(e);
                            }
                        }
                    }
                }
            });
            playerThread = new Thread(new Runnable() {
                @Override
                public void run() {
                    while (!stopped.get()) {
                        byte\[] rawAudio = RawAudioBuffer.poll();
                        if (rawAudio != null) {
                            try {
                                playChunk(rawAudio);
                            } catch (IOException e) {
                                throw new RuntimeException(e);
                            } catch (InterruptedException e) {
                                throw new RuntimeException(e);
                            }
                        } else {
                            try {
                                Thread.sleep(100);
                            } catch (InterruptedException e) {
                                throw new RuntimeException(e);
                            }
                        }
                    }
                }
            });
            decoderThread.start();
            playerThread.start();
        }
        // 播放一个音频块并阻塞直到播放完成
        private void playChunk(byte\[] chunk) throws IOException, InterruptedException {
            if (chunk == null || chunk.length == 0) return;
            int bytesWritten = 0;
            while (bytesWritten < chunk.length) {
                bytesWritten += line.write(chunk, bytesWritten, chunk.length - bytesWritten);
            }
            int audioLength = chunk.length / (this.sampleRate\*2/1000);
            // 等待缓冲区中的音频播放完成
            Thread.sleep(audioLength - 10);
        }
        public void write(String b64Audio) {
            b64AudioBuffer.add(b64Audio);
        }
        public void cancel() {
            b64AudioBuffer.clear();
            RawAudioBuffer.clear();
        }
        public void waitForComplete() throws InterruptedException {
            while (!b64AudioBuffer.isEmpty() || !RawAudioBuffer.isEmpty()) {
                Thread.sleep(100);
            }
            line.drain();
        }
        public void shutdown() throws InterruptedException {
            stopped.set(true);
            decoderThread.join();
            playerThread.join();
            if (line != null \&\& line.isRunning()) {
                line.drain();
                line.close();
            }
        }
    } // RealtimePcmPlayer 类定义结束
    // 新增录音方法
    private static void recordAndSend(TargetDataLine line, OmniRealtimeConversation conversation) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte\[] buffer = new byte\[3200];
        AtomicBoolean stopRecording = new AtomicBoolean(false);
        // 启动监听Enter键的线程
        Thread enterKeyListener = new Thread(() -> {
            try {
                System.in.read();
                stopRecording.set(true);
            } catch (IOException e) {
                e.printStackTrace();
            }
        });
        enterKeyListener.start();
        // 录音循环
        while (!stopRecording.get()) {
            int count = line.read(buffer, 0, buffer.length);
            if (count > 0) {
                out.write(buffer, 0, count);
            }
        }
        // 发送录音数据
        byte\[] audioData = out.toByteArray();
        String audioB64 = Base64.getEncoder().encodeToString(audioData);
        conversation.appendAudio(audioB64);
        out.close();
    }
    public static void main(String\[] args) throws InterruptedException, LineUnavailableException {
        OmniRealtimeParam param = OmniRealtimeParam.builder()
                .model("qwen3.5-omni-plus-realtime")
                // .apikey("your-dashscope-api-key")
                .build();
        AtomicReference<CountDownLatch> responseDoneLatch = new AtomicReference<>(null);
        responseDoneLatch.set(new CountDownLatch(1));
        RealtimePcmPlayer audioPlayer = new RealtimePcmPlayer(24000);
        final AtomicReference<OmniRealtimeConversation> conversationRef = new AtomicReference<>(null);
        OmniRealtimeConversation conversation = new OmniRealtimeConversation(param, new OmniRealtimeCallback() {
            @Override
            public void onOpen() {
                System.out.println("connection opened");
            }
            @Override
            public void onEvent(JsonObject message) {
                String type = message.get("type").getAsString();
                switch(type) {
                    case "session.created":
                        System.out.println("start session: " + message.get("session").getAsJsonObject().get("id").getAsString());
                        break;
                    case "conversation.item.input\_audio\_transcription.completed":
                        System.out.println("question: " + message.get("transcript").getAsString());
                        break;
                    case "response.audio\_transcript.delta":
                        System.out.println("got llm response delta: " + message.get("delta").getAsString());
                        break;
                    case "response.audio.delta":
                        String recvAudioB64 = message.get("delta").getAsString();
                        audioPlayer.write(recvAudioB64);
                        break;
                    case "response.done":
                        System.out.println("======RESPONSE DONE======");
                        if (conversationRef.get() != null) {
                            System.out.println("\[Metric] response: " + conversationRef.get().getResponseId() +
                                    ", first text delay: " + conversationRef.get().getFirstTextDelay() +
                                    " ms, first audio delay: " + conversationRef.get().getFirstAudioDelay() + " ms");
                        }
                        responseDoneLatch.get().countDown();
                        break;
                    default:
                        break;
                }
            }
            @Override
            public void onClose(int code, String reason) {
                System.out.println("connection closed code: " + code + ", reason: " + reason);
            }
        });
        conversationRef.set(conversation);
        try {
            conversation.connect();
        } catch (NoApiKeyException e) {
            throw new RuntimeException(e);
        }
        OmniRealtimeConfig config = OmniRealtimeConfig.builder()
                .modalities(Arrays.asList(OmniRealtimeModality.AUDIO, OmniRealtimeModality.TEXT))
                .voice("Ethan")
                .enableTurnDetection(false)
                // 设定模型角色
                .parameters(new HashMap<String, Object>() {{
                    put("instructions","你是个人助理小云，请你准确且友好地解答用户的问题，始终以乐于助人的态度回应。");
                }})
                .build();
        conversation.updateSession(config);
        // 新增麦克风录音功能
        AudioFormat format = new AudioFormat(16000, 16, 1, true, false);
        DataLine.Info info = new DataLine.Info(TargetDataLine.class, format);
        if (!AudioSystem.isLineSupported(info)) {
            System.out.println("Line not supported");
            return;
        }
        TargetDataLine line = null;
        try {
            line = (TargetDataLine) AudioSystem.getLine(info);
            line.open(format);
            line.start();
            while (true) {
                System.out.println("按Enter开始录音...");
                try {
                    System.in.read();
                } catch (IOException e) {
                    System.err.println("读取输入时发生错误: " + e.getMessage());
                    break; // 发生错误时退出循环
                }
                System.out.println("开始录音，请说话...再次按Enter停止录音并发送");
                recordAndSend(line, conversation);
                conversation.commit();
                conversation.createResponse(null, null);
                // 重置latch以便下次等待
                responseDoneLatch.set(new CountDownLatch(1));
            }
        } catch (LineUnavailableException | IOException e) {
            e.printStackTrace();
        } finally {
            if (line != null) {
                line.stop();
                line.close();
            }
        }
    }}
```

运行`OmniWithoutServerVad.main()`方法，按 Enter 键开始录音，录音过程中再次按 Enter 键停止录音并发送，随后将接收并播放模型响应。
\## \*\*交互流程\*\*
\## VAD 模式
将\[session.update](https://help.aliyun.com/zh/model-studio/client-events#af43722339yva)事件的`session.turn\_detection.type` 设为`"server\_vad"`或`"semantic\_vad"`以\[启用 VAD 模式](https://help.aliyun.com/zh/model-studio/client-events#6218707b80vlt)。适用于语音通话场景。
交互流程如下：
1\.  服务端检测到语音开始，发送\[input\\\_audio\\\_buffer.speech\\\_started](https://help.aliyun.com/zh/model-studio/server-events#b99f92d872n5c) 事件。
2\.  客户端随时发送 \[input\\\_audio\\\_buffer.append](https://help.aliyun.com/zh/model-studio/client-events#8d11313f2198k)与\[input\\\_image\\\_buffer.append](https://help.aliyun.com/zh/model-studio/client-events#e27908854eaht) 事件追加音频与图片至缓冲区。
    > 发送 input\\\_image\\\_buffer.append 事件前，至少发送过一次 input\\\_audio\\\_buffer.append 事件。
3\.  服务端检测到语音结束，发送\[input\\\_audio\\\_buffer.speech\\\_stopped](https://help.aliyun.com/zh/model-studio/server-events#fd08ffdf0a2mt) 事件。
4\.  服务端发送\[input\\\_audio\\\_buffer.committed](https://help.aliyun.com/zh/model-studio/server-events#bd9bfdc258afy) 事件提交音频缓冲区。
5\.  服务端发送 \[conversation.item.created](https://help.aliyun.com/zh/model-studio/server-events#bb4547ed5b5ht) 事件，包含从缓冲区创建的用户消息项。

| \*\*生命周期\*\* | \*\*客户端事件\*\* | \*\*服务端事件\*\* |
| --- | --- | --- |
| 会话初始化 | \[session.update](https://help.aliyun.com/zh/model-studio/client-events#af43722339yva) > 会话配置 | \[session.created](https://help.aliyun.com/zh/model-studio/server-events#39689ed6e90ag) > 会话已创建 \[session.updated](https://help.aliyun.com/zh/model-studio/server-events#424ef2e774q9p) > 会话配置已更新 |
| 用户音频输入 | \[input\\\\\_audio\\\\\_buffer.append](https://help.aliyun.com/zh/model-studio/client-events#8d11313f2198k) > 添加音频到缓冲区 \[input\\\\\_image\\\\\_buffer.append](https://help.aliyun.com/zh/model-studio/client-events#e27908854eaht) > 添加图片到缓冲区 | \[input\\\\\_audio\\\\\_buffer.speech\\\\\_started](https://help.aliyun.com/zh/model-studio/server-events#b99f92d872n5c) > 检测到语音开始 \[input\\\\\_audio\\\\\_buffer.speech\\\\\_stopped](https://help.aliyun.com/zh/model-studio/server-events#fd08ffdf0a2mt) > 检测到语音结束 \[input\\\\\_audio\\\\\_buffer.committed](https://help.aliyun.com/zh/model-studio/server-events#bd9bfdc258afy) > 服务器收到提交的音频 |
| 服务器音频输出 | 无   | \[response.created](https://help.aliyun.com/zh/model-studio/server-events#38033afc582r1) > 服务端开始生成响应 \[response.output\\\\\_item.added](https://help.aliyun.com/zh/model-studio/server-events#dae2260d40qtu) > 响应时有新的输出内容 \[conversation.item.created](https://help.aliyun.com/zh/model-studio/server-events#bb4547ed5b5ht) > 对话项被创建 \[response.content\\\\\_part.added](https://help.aliyun.com/zh/model-studio/server-events#de7fa0b877j25) > 新的输出内容添加到assistant message \[response.audio\\\\\_transcript.delta](https://help.aliyun.com/zh/model-studio/server-events#35396453cfood) > 增量生成的转录文字 \[response.audio.delta](https://help.aliyun.com/zh/model-studio/server-events#a25cc50a15car) > 模型增量生成的音频 \[response.audio\\\\\_transcript.done](https://help.aliyun.com/zh/model-studio/server-events#f4d1698567bsm) > 文本转录完成 \[response.audio.done](https://help.aliyun.com/zh/model-studio/server-events#9e8eb59c67qnt) > 音频生成完成 \[response.content\\\\\_part.done](https://help.aliyun.com/zh/model-studio/server-events#011ad54242wft) > Assistant message 的文本或音频内容流式输出完成 \[response.output\\\\\_item.done](https://help.aliyun.com/zh/model-studio/server-events#f580421f45w3h) > Assistant message 的整个输出项流式传输完成 \[response.done](https://help.aliyun.com/zh/model-studio/server-events#f2333c777d9s4) > 响应完成 |

\## Manual 模式
将\[session.update](https://help.aliyun.com/zh/model-studio/client-events#af43722339yva)事件的`session.turn\_detection` 设为 `null` 以启用 Manual 模式。此模式下，客户端通过显式发送`input\_audio\_buffer.commit` 和`response.create`事件请求服务器响应。适用于按下即说场景，如聊天软件中的发送语音。
交互流程如下：
1\.  客户端随时发送 \[input\\\_audio\\\_buffer.append](https://help.aliyun.com/zh/model-studio/client-events#8d11313f2198k)与\[input\\\_image\\\_buffer.append](https://help.aliyun.com/zh/model-studio/client-events#e27908854eaht)事件追加音频与图片至缓冲区。
    > 发送 input\\\_image\\\_buffer.append 事件前，至少发送过一次 input\\\_audio\\\_buffer.append 事件。
2\.  客户端发送\[input\\\_audio\\\_buffer.commit](https://help.aliyun.com/zh/model-studio/client-events#1cbea5fa7fkfl)事件提交音频缓冲区与图像缓冲区，告知服务端本轮的用户输入（音频及图片）已全部发送完毕。
3\.  服务端响应 \[input\\\_audio\\\_buffer.committed](https://help.aliyun.com/zh/model-studio/server-events#bd9bfdc258afy)事件。
4\.  客户端发送\[response.create](https://help.aliyun.com/zh/model-studio/client-events#a42f8e9111n72)事件，等待服务端返回模型的输出。
5\.  服务端响应\[conversation.item.created](https://help.aliyun.com/zh/model-studio/server-events#bb4547ed5b5ht)事件。

| \*\*生命周期\*\* | \*\*客户端事件\*\* | \*\*服务端事件\*\* |
| --- | --- | --- |
| 会话初始化 | \[session.update](https://help.aliyun.com/zh/model-studio/client-events#af43722339yva) > 会话配置 | \[session.created](https://help.aliyun.com/zh/model-studio/server-events#39689ed6e90ag) > 会话已创建 \[session.updated](https://help.aliyun.com/zh/model-studio/server-events#424ef2e774q9p) > 会话配置已更新 |
| 用户音频输入 | \[input\\\\\_audio\\\\\_buffer.append](https://help.aliyun.com/zh/model-studio/client-events#8d11313f2198k) > 添加音频到缓冲区 \[input\\\\\_image\\\\\_buffer.append](https://help.aliyun.com/zh/model-studio/client-events#e27908854eaht) > 添加图片到缓冲区 \[input\\\\\_audio\\\\\_buffer.commit](https://help.aliyun.com/zh/model-studio/client-events#1cbea5fa7fkfl) > 提交音频与图片到服务器 \[response.create](https://help.aliyun.com/zh/model-studio/client-events#a42f8e9111n72) > 创建模型响应 | \[input\\\\\_audio\\\\\_buffer.committed](https://help.aliyun.com/zh/model-studio/server-events#bd9bfdc258afy) > 服务器收到提交的音频 |
| 服务器音频输出 | \[input\\\\\_audio\\\\\_buffer.clear](https://help.aliyun.com/zh/model-studio/client-events#3b44f2f2abakw) > 清除缓冲区的音频 | \[response.created](https://help.aliyun.com/zh/model-studio/server-events#38033afc582r1) > 服务端开始生成响应 \[response.output\\\\\_item.added](https://help.aliyun.com/zh/model-studio/server-events#dae2260d40qtu) > 响应时有新的输出内容 \[conversation.item.created](https://help.aliyun.com/zh/model-studio/server-events#bb4547ed5b5ht) > 对话项被创建 \[response.content\\\\\_part.added](https://help.aliyun.com/zh/model-studio/server-events#de7fa0b877j25) > 新的输出内容添加到assistant message 项 \[response.audio\\\\\_transcript.delta](https://help.aliyun.com/zh/model-studio/server-events#35396453cfood) > 增量生成的转录文字 \[response.audio.delta](https://help.aliyun.com/zh/model-studio/server-events#a25cc50a15car) > 模型增量生成的音频 \[response.audio\\\\\_transcript.done](https://help.aliyun.com/zh/model-studio/server-events#f4d1698567bsm) > 完成文本转录 \[response.audio.done](https://help.aliyun.com/zh/model-studio/server-events#9e8eb59c67qnt) > 完成音频生成 \[response.content\\\\\_part.done](https://help.aliyun.com/zh/model-studio/server-events#011ad54242wft) > Assistant message 的文本或音频内容流式输出完成 \[response.output\\\\\_item.done](https://help.aliyun.com/zh/model-studio/server-events#f580421f45w3h) > Assistant message 的整个输出项流式传输完成 \[response.done](https://help.aliyun.com/zh/model-studio/server-events#f2333c777d9s4) > 响应完成 |

\## \*\*联网搜索\*\*
联网搜索功能使模型能够基于实时检索数据进行回复，适用于股票价格、天气预报等需要即时信息的场景。模型可自主判断是否需要搜索来回应用户的即时问题。
> 联网搜索仅 `Qwen3.5-Omni-Realtime` 模型支持，且默认关闭，需通过 `session.update` 事件启用。
> 计费请参考\[计费说明](https://help.aliyun.com/zh/model-studio/web-search#92ce83df3a599)中的`agent`策略。
\### \*\*启用方式\*\*
在 `session.update` 事件中添加以下参数：
\-   `enable\_search`：设置为 `true` 启用联网搜索功能。
\-   `search\_options.enable\_source`：设置为 `true` 返回搜索结果来源列表。
参数详情请参见\[session.update](https://help.aliyun.com/zh/model-studio/client-events#7692180895hvk)。
\### \*\*响应格式\*\*
启用联网搜索后，`response.done` 事件中的 `usage` 会新增 `plugins` 字段，用于记录搜索计量信息：

```
{
    "usage": {
        "total\_tokens": 2937,
        "input\_tokens": 2554,
        "output\_tokens": 383,
        "input\_tokens\_details": {
            "text\_tokens": 2512,
            "audio\_tokens": 42
        },
        "output\_tokens\_details": {
            "text\_tokens": 90,
            "audio\_tokens": 293
        },
        "plugins": {
            "search": {
                "count": 1,
                "strategy": "agent"
            }
        }
    }
}
```

\### \*\*代码示例\*\*
以下示例展示如何在实时对话中启用联网搜索功能。
\## DashScope Python SDK
在 `update\_session` 调用中传入 `enable\_search` 和 `search\_options` 参数：

```
import os
import base64
import time
import json
import pyaudio
from dashscope.audio.qwen\_omni import MultiModality, AudioFormat, OmniRealtimeCallback, OmniRealtimeConversation
import dashscope
dashscope.api\_key = os.getenv('DASHSCOPE\_API\_KEY')
url = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime'
model = 'qwen3.5-omni-plus-realtime'
voice = 'Tina'
class SearchCallback(OmniRealtimeCallback):
    def \_\_init\_\_(self, pya):
        self.pya = pya
        self.out = None
    def on\_open(self):
        self.out = self.pya.open(format=pyaudio.paInt16, channels=1, rate=24000, output=True)
    def on\_event(self, response):
        if response\['type'] == 'response.audio.delta':
            self.out.write(base64.b64decode(response\['delta']))
        elif response\['type'] == 'conversation.item.input\_audio\_transcription.completed':
            print(f"\[User] {response\['transcript']}")
        elif response\['type'] == 'response.audio\_transcript.done':
            print(f"\[LLM] {response\['transcript']}")
        elif response\['type'] == 'response.done':
            usage = response.get('response', {}).get('usage', {})
            plugins = usage.get('plugins', {})
            if plugins.get('search'):
                print(f"\[Search] count={plugins\['search']\['count']}, strategy={plugins\['search']\['strategy']}")
pya = pyaudio.PyAudio()
callback = SearchCallback(pya)
conv = OmniRealtimeConversation(model=model, callback=callback, url=url)
conv.connect()
conv.update\_session(
    output\_modalities=\[MultiModality.AUDIO, MultiModality.TEXT],
    voice=voice,
    instructions="你是个人助理小云",
    enable\_search=True,
    search\_options={'enable\_source': True}
)
mic = pya.open(format=pyaudio.paInt16, channels=1, rate=16000, input=True)
print("联网搜索已启用，对着麦克风说话 (Ctrl+c 退出)...")
try:
    while True:
        audio\_data = mic.read(3200, exception\_on\_overflow=False)
        conv.append\_audio(base64.b64encode(audio\_data).decode())
        time.sleep(0.01)
except KeyboardInterrupt:
    conv.close()
    mic.close()
    callback.out.close()
    pya.terminate()
    print("\\n对话结束")
```

---
*← 返回 [README](./README.md)*
