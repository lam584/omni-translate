> 来源：`实时语音合成-千问.md`
\## Gradle
在`build.gradle`中添加如下内容：

```
// https://mvnrepository.com/artifact/com.google.code.gson/gson
implementation("com.google.code.gson:gson:2.13.1")
```

```
import com.alibaba.dashscope.audio.qwen\_tts\_realtime.\*;
import com.alibaba.dashscope.exception.NoApiKeyException;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import javax.sound.sampled.\*;
import java.io.\*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.file.\*;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Queue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicBoolean;
public class Main {
    // ===== 常量定义 =====
    // 声音复刻、语音合成要使用相同的模型
    private static final String TARGET\_MODEL = "qwen3-tts-vc-realtime-2026-01-15";
    private static final String PREFERRED\_NAME = "guanyu";
    // 用于声音复刻的本地音频文件的相对路径
    private static final String AUDIO\_FILE = "voice.mp3";
    private static final String AUDIO\_MIME\_TYPE = "audio/mpeg";
    private static String\[] textToSynthesize = {
            "对吧\~我就特别喜欢这种超市",
            "尤其是过年的时候",
            "去逛超市",
            "就会觉得",
            "超级超级开心！",
            "想买好多好多的东西呢！"
    };
    // 生成 data URI
    public static String toDataUrl(String filePath) throws IOException {
        byte\[] bytes = Files.readAllBytes(Paths.get(filePath));
        String encoded = Base64.getEncoder().encodeToString(bytes);
        return "data:" + AUDIO\_MIME\_TYPE + ";base64," + encoded;
    }
    // 调用 API 创建 voice
    public static String createVoice() throws Exception {
        // 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
        // 若没有配置环境变量，请用百炼API Key将下行替换为：String apiKey = "sk-xxx"
        String apiKey = System.getenv("DASHSCOPE\_API\_KEY");
        String jsonPayload =
                "{"
                        + "\\"model\\": \\"qwen-voice-enrollment\\"," // 不要修改该值
                        + "\\"input\\": {"
                        +     "\\"action\\": \\"create\\","
                        +     "\\"target\_model\\": \\"" + TARGET\_MODEL + "\\","
                        +     "\\"preferred\_name\\": \\"" + PREFERRED\_NAME + "\\","
                        +     "\\"audio\\": {"
                        +         "\\"data\\": \\"" + toDataUrl(AUDIO\_FILE) + "\\""
                        +     "}"
                        + "}"
                        + "}";
        HttpURLConnection con = (HttpURLConnection) new URL("https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization").openConnection();
        con.setRequestMethod("POST");
        con.setRequestProperty("Authorization", "Bearer " + apiKey);
        con.setRequestProperty("Content-Type", "application/json");
        con.setDoOutput(true);
        try (OutputStream os = con.getOutputStream()) {
            os.write(jsonPayload.getBytes(StandardCharsets.UTF\_8));
        }
        int status = con.getResponseCode();
        System.out.println("HTTP 状态码: " + status);
        try (BufferedReader br = new BufferedReader(
                new InputStreamReader(status >= 200 \&\& status < 300 ? con.getInputStream() : con.getErrorStream(),
                        StandardCharsets.UTF\_8))) {
            StringBuilder response = new StringBuilder();
            String line;
            while ((line = br.readLine()) != null) {
                response.append(line);
            }
            System.out.println("返回内容: " + response);
            if (status == 200) {
                JsonObject jsonObj = new Gson().fromJson(response.toString(), JsonObject.class);
                return jsonObj.getAsJsonObject("output").get("voice").getAsString();
            }
            throw new IOException("创建语音失败: " + status + " - " + response);
        }
    }
    // 实时PCM音频播放器类
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
    }
    public static void main(String\[] args) throws Exception {
        QwenTtsRealtimeParam param = QwenTtsRealtimeParam.builder()
                .model(TARGET\_MODEL)
                // 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime
                .url("wss://dashscope.aliyuncs.com/api-ws/v1/realtime")
                // 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
                // 若没有配置环境变量，请用百炼API Key将下行替换为：.apikey("sk-xxx")
                .apikey(System.getenv("DASHSCOPE\_API\_KEY"))
                .build();
        AtomicReference<CountDownLatch> completeLatch = new AtomicReference<>(new CountDownLatch(1));
        final AtomicReference<QwenTtsRealtime> qwenTtsRef = new AtomicReference<>(null);
        // 创建实时音频播放器实例
        RealtimePcmPlayer audioPlayer = new RealtimePcmPlayer(24000);
        QwenTtsRealtime qwenTtsRealtime = new QwenTtsRealtime(param, new QwenTtsRealtimeCallback() {
            @Override
            public void onOpen() {
                // 连接建立时的处理
            }
            @Override
            public void onEvent(JsonObject message) {
                String type = message.get("type").getAsString();
                switch(type) {
                    case "session.created":
                        // 会话创建时的处理
                        break;
                    case "response.audio.delta":
                        String recvAudioB64 = message.get("delta").getAsString();
                        // 实时播放音频
                        audioPlayer.write(recvAudioB64);
                        break;
                    case "response.done":
                        // 响应完成时的处理
                        break;
                    case "session.finished":
                        // 会话结束时的处理
                        completeLatch.get().countDown();
                    default:
                        break;
                }
            }
            @Override
            public void onClose(int code, String reason) {
                // 连接关闭时的处理
            }
        });
        qwenTtsRef.set(qwenTtsRealtime);
        try {
            qwenTtsRealtime.connect();
        } catch (NoApiKeyException e) {
            throw new RuntimeException(e);
        }
        QwenTtsRealtimeConfig config = QwenTtsRealtimeConfig.builder()
                .voice(createVoice()) // 将voice参数替换为复刻生成的专属音色
                .responseFormat(QwenTtsRealtimeAudioFormat.PCM\_24000HZ\_MONO\_16BIT)
                .mode("server\_commit")
                .build();
        qwenTtsRealtime.updateSession(config);
        for (String text:textToSynthesize) {
            qwenTtsRealtime.appendText(text);
            Thread.sleep(100);
        }
        qwenTtsRealtime.finish();
        completeLatch.get().await();
        // 等待音频播放完成并关闭播放器
        audioPlayer.waitForComplete();
        audioPlayer.shutdown();
        System.exit(0);
    }
}
```

\## \*\*交互流程\*\*
\## server\\\_commit 模式
将`session.update`事件的`session.mode` 设为`"server\_commit"`以启用该模式，服务端会智能处理文本分段和合成时机。
交互流程如下：
1\.  客户端发送`session.update`事件，服务端响应`session.created`与`session.updated`事件。
2\.  客户端发送 `input\_text\_buffer.append` 事件追加文本至服务端缓冲区。
3\.  服务端智能处理文本分段和合成时机，并返回`response.created`、`response.output\_item.added`、`response.content\_part.added`、`response.audio.delta`事件。
4\.  服务端响应完成后响应`response.audio.done`、`response.content\_part.done`、`response.output\_item.done`、`response.done`。
5\.  服务端响应`session.finished`来结束会话。

| \*\*生命周期\*\* | \*\*客户端事件\*\* | \*\*服务器事件\*\* |
| --- | --- | --- |
| 会话初始化 | session.update > 会话配置 | session.created > 会话已创建 session.updated > 会话配置已更新 |
| 用户文本输入 | input\\\\\_text\\\\\_buffer.append > 添加文本到服务端 input\\\\\_text\\\\\_buffer.commit > 立即合成服务端缓存的文本 session.finish > 通知服务端不再有文本输入 | input\\\\\_text\\\\\_buffer.committed > 服务端收到提交的文本 |
| 服务器音频输出 | 无   | response.created > 服务端开始生成响应 response.output\\\\\_item.added > 响应时有新的输出内容 response.content\\\\\_part.added > 新的输出内容添加到assistant message response.audio.delta > 模型增量生成的音频 response.content\\\\\_part.done > Assistant message 的文本或音频内容流式输出完成 response.output\\\\\_item.done > Assistant message 的整个输出项流式传输完成 response.audio.done > 音频生成完成 response.done > 响应完成 |

\## commit 模式
将`session.update`事件的`session.mode` 设为`"commit"`以启用该模式，客户端需主动提交文本缓冲区至服务端来获取响应。
交互流程如下：
1\.  客户端发送`session.update`事件，服务端响应`session.created`与`session.updated`事件。
2\.  客户端发送 `input\_text\_buffer.append` 事件追加文本至服务端缓冲区。
3\.  客户端发送`input\_text\_buffer.commit`事件将缓冲区提交至服务端，并发送 `session.finish`事件表示后续无文本输入。
4\.  服务端响应`response.created`，开始生成响应。
5\.  服务端响应`response.output\_item.added`、`response.content\_part.added`、`response.audio.delta`事件。
6\.  服务端响应完成后返回`response.audio.done`、`response.content\_part.done`、`response.output\_item.done`、`response.done`。
7\.  服务端响应`session.finished`来结束会话。

| \*\*生命周期\*\* | \*\*客户端事件\*\* | \*\*服务器事件\*\* |
| --- | --- | --- |
| 会话初始化 | session.update > 会话配置 | session.created > 会话已创建 session.updated > 会话配置已更新 |
| 用户文本输入 | input\\\\\_text\\\\\_buffer.append > 添加文本到缓冲区 input\\\\\_text\\\\\_buffer.commit > 提交缓冲区到服务端 input\\\\\_text\\\\\_buffer.clear > 清除缓冲区 | input\\\\\_text\\\\\_buffer.committed > 服务端收到提交的文本 |
| 服务器音频输出 | 无   | response.created > 服务端开始生成响应 response.output\\\\\_item.added > 响应时有新的输出内容 response.content\\\\\_part.added > 新的输出内容添加到assistant message response.audio.delta > 模型增量生成的音频 response.content\\\\\_part.done > Assistant message 的文本或音频内容流式输出完成 response.output\\\\\_item.done > Assistant message 的整个输出项流式传输完成 response.audio.done > 音频生成完成 response.done > 响应完成 |

\## \*\*指令控制\*\*
指令控制是一项高级语音合成功能，通过自然语言描述的方式精确控制语音的表达效果。您可以使用简单的文字描述，让合成语音呈现出特定的音调、语速、情感、音色特点，无需调整复杂的音频参数。
\*\*支持的模型\*\*：仅支持千问3-TTS-Instruct-Flash-Realtime系列模型。
\*\*使用方式\*\*：通过`instructions`参数指定指令内容，例如“语速较快，带有明显的上扬语调，适合介绍时尚产品”。
\*\*支持语言\*\*：描述文本仅支持中文和英文。
\*\*长度限制\*\*：长度不得超过 1600 Token。
\*\*适用场景\*\*：
\-   有声书和广播剧配音
\-   广告和宣传片配音
\-   游戏角色和动画配音
\-   情感化的智能语音助手
\-   纪录片和新闻播报
\*\*如何编写高质量的声音描述：\*\*
\-   核心原则：
    1.  具体而非模糊：使用能够描绘具体声音特质的词语，如“低沉”、“清脆”、“语速偏快”。避免使用“好听”、“普通”等主观且缺乏信息量的词汇。
    2.  多维而非单一：优秀的描述通常结合多个维度（如下文所述的音调、语速、情感等）。单一维度的描述（如仅“高音”）过于宽泛，难以生成特色鲜明的效果。
    3.  客观而非主观：专注于声音本身的物理和感知特征，而不是个人的喜好。例如，用“音调偏高，带有活力”代替“我最喜欢的声音”。
    4.  原创而非模仿：请描述声音的特质，而不是要求模仿特定人物（如名人、演员）。此类请求涉及版权风险且模型不支持直接模仿。
    5.  简洁而非冗余：确保每个词都有其意义。避免重复使用同义词或无意义的强调词（如“非常非常棒的声音”）。
\-   描述维度参考：可以组合多个维度，创造更丰富的表达效果。

    | \*\*维度\*\* | \*\*描述示例\*\* |
    | --- | --- |
    | 音调  | 高音、中音、低音、偏高、偏低 |
    | 语速  | 快速、中速、缓慢、偏快、偏慢 |
    | 情感  | 开朗、沉稳、温柔、严肃、活泼、冷静、治愈 |
    | 特点  | 有磁性、清脆、沙哑、圆润、甜美、浑厚、有力 |
    | 用途  | 新闻播报、广告配音、有声书、动画角色、语音助手、纪录片解说 |

\-   示例：
    -   标准播音风格：吐字清晰精准，字正腔圆
    -   情绪递进效果：音量由正常对话迅速增强至高喊，性格直率，情绪易激动且外露
    -   特殊情感状态：哭腔导致发音略微含糊，略显沙哑，带有明显哭腔的紧张感
    -   广告配音风格：音调偏高，语速中等，充满活力和感染力，适合广告配音
    -   温柔治愈风格：语速偏慢，音调温柔甜美，语气治愈温暖，像贴心朋友般关怀
\## \*\*API参考\*\*
\[实时语音合成-千问API参考](https://help.aliyun.com/zh/model-studio/qwen-tts-realtime-api-reference/)
\[声音复刻-API参考](https://help.aliyun.com/zh/model-studio/qwen-tts-voice-cloning)
\[声音设计-API参考](https://help.aliyun.com/zh/model-studio/qwen-tts-voice-design)
\## \*\*模型功能特性对比\*\*

| \*\*功能/特性\*\* | \*\*千问3-TTS-Instruct-Flash-Realtime\*\* | \*\*千问3-TTS-VD-Realtime\*\* | \*\*千问3-TTS-VC-Realtime\*\* | \*\*千问3-TTS-Flash-Realtime\*\* | \*\*千问-TTS-Realtime\*\* |
| --- | --- | --- | --- | --- | --- |
| \*\*支持语言\*\* | 中文（普通话）、英文、西班牙语、俄语、意大利语、法语、韩语、日语、德语、葡萄牙语 | 中文（普通话）、英文、西班牙语、俄语、意大利语、法语、韩语、日语、德语、葡萄牙语 |   | 中文（普通话、北京、上海、四川、南京、陕西、闽南、天津、粤语，因\[音色](#422789c49bqqx)而异）、英文、西班牙语、俄语、意大利语、法语、韩语、日语、德语、葡萄牙语 | 中文、英文 |
| \*\*音频格式\*\* | pcm、wav、mp3、opus |   |   |   | pcm |
| \*\*音频采样率\*\* | 8kHz、16kHz、24kHz、48kHz |   |   |   | 24kHz |
| \*\*声音复刻\*\* | 不支持 |   | 支持  | 不支持 |   |
| \*\*声音设计\*\* | 不支持 | 支持  | 不支持 |   |   |
| \*\*SSML\*\* | 不支持 |   |   |   |   |
| \*\*LaTeX\*\* | 不支持 |   |   |   |   |
| \*\*音量调节\*\* | 支持  |   |   |   | 不支持 |
| \*\*语速调节\*\* | 支持  |   |   |   | 不支持 |
| \*\*语调（音高）调节\*\* | 支持  |   |   |   | 不支持 |
| \*\*码率调节\*\* | 支持  |   |   |   | 不支持 |
| \*\*时间戳\*\* | 不支持 |   |   |   |   |
| \*\*指令控制（Instruct）\*\* | 支持  | 不支持 |   |   |   |
| \*\*流式输入\*\* | 支持  |   |   |   |   |
| \*\*流式输出\*\* | 支持  |   |   |   |   |
| \*\*限流\*\* |     | 每分钟调用次数（RPM）：180 |   | qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27 每分钟调用次数（RPM）：180 qwen3-tts-flash-realtime-2025-09-18 每分钟调用次数（RPM）：10 | 每分钟调用次数（RPM）：10 每分钟消耗Token数（TPM）：100,000 |
| \*\*接入方式\*\* | Java/Python SDK、WebSocket API |   |   |   |   |
| \*\*价格\*\* | 中国内地：1元/万字符 国际：1元/万字符 | 中国内地：1元/万字符 国际：0.954101元/万字符 | 中国内地：1元/万字符 国际：0.954101元/万字符 |   | 中国内地： - 输入成本：0.0024元/千Token - 输出成本：0.012元/千Token |

\## \*\*支持的音色\*\*
不同模型支持的音色有所差异，使用时将请求参数`voice`设置为音色列表中\*\*voice参数\*\*列对应的值。

| `\*\*voice\*\*`\*\*参数\*\* | \*\*详情\*\* | \*\*支持语种\*\* | \*\*支持模型\*\* |
| `Cherry` | \*\*音色名\*\*：芊悦 \*\*描述\*\*：阳光积极、亲切自然小姐姐（女性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash-Realtime\*\*：qwen3-tts-instruct-flash-realtime、qwen3-tts-instruct-flash-realtime-2026-01-22 - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27、qwen3-tts-flash-realtime-2025-09-18 - \*\*千问-TTS-Realtime\*\*：qwen-tts-realtime、qwen-tts-realtime-latest、qwen-tts-realtime-2025-07-15 |
| `Serena` | \*\*音色名\*\*：苏瑶 \*\*描述\*\*：温柔小姐姐（女性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash-Realtime\*\*：qwen3-tts-instruct-flash-realtime、qwen3-tts-instruct-flash-realtime-2026-01-22 - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27 - \*\*千问-TTS-Realtime\*\*：qwen-tts-realtime、qwen-tts-realtime-latest、qwen-tts-realtime-2025-07-15 |
| `Ethan` | \*\*音色名\*\*：晨煦 \*\*描述\*\*：标准普通话，带部分北方口音。阳光、温暖、活力、朝气（男性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash-Realtime\*\*：qwen3-tts-instruct-flash-realtime、qwen3-tts-instruct-flash-realtime-2026-01-22 - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27、qwen3-tts-flash-realtime-2025-09-18 - \*\*千问-TTS-Realtime\*\*：qwen-tts-realtime、qwen-tts-realtime-latest、qwen-tts-realtime-2025-07-15 |
| `Chelsie` | \*\*音色名\*\*：千雪 \*\*描述\*\*：二次元虚拟女友（女性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash-Realtime\*\*：qwen3-tts-instruct-flash-realtime、qwen3-tts-instruct-flash-realtime-2026-01-22 - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27 - \*\*千问-TTS-Realtime\*\*：qwen-tts-realtime、qwen-tts-realtime-latest、qwen-tts-realtime-2025-07-15 |
| `Momo` | \*\*音色名\*\*：茉兔 \*\*描述\*\*：撒娇搞怪，逗你开心（女性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash-Realtime\*\*：qwen3-tts-instruct-flash-realtime、qwen3-tts-instruct-flash-realtime-2026-01-22 - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27 |
| `Vivian` | \*\*音色名\*\*：十三 \*\*描述\*\*：拽拽的、可爱的小暴躁（女性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash-Realtime\*\*：qwen3-tts-instruct-flash-realtime、qwen3-tts-instruct-flash-realtime-2026-01-22 - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27 |
| `Moon` | \*\*音色名\*\*：月白 \*\*描述\*\*：率性帅气的月白（男性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash-Realtime\*\*：qwen3-tts-instruct-flash-realtime、qwen3-tts-instruct-flash-realtime-2026-01-22 - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27 |
| `Maia` | \*\*音色名\*\*：四月 \*\*描述\*\*：知性与温柔的碰撞（女性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash-Realtime\*\*：qwen3-tts-instruct-flash-realtime、qwen3-tts-instruct-flash-realtime-2026-01-22 - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27 |
| `Kai` | \*\*音色名\*\*：凯 \*\*描述\*\*：耳朵的一场SPA（男性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash-Realtime\*\*：qwen3-tts-instruct-flash-realtime、qwen3-tts-instruct-flash-realtime-2026-01-22 - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27 |
| `Nofish` | \*\*音色名\*\*：不吃鱼 \*\*描述\*\*：不会翘舌音的设计师（男性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash-Realtime\*\*：qwen3-tts-instruct-flash-realtime、qwen3-tts-instruct-flash-realtime-2026-01-22 - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27、qwen3-tts-flash-realtime-2025-09-18 |
| `Bella` | \*\*音色名\*\*：萌宝 \*\*描述\*\*：喝酒不打醉拳的小萝莉（女性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash-Realtime\*\*：qwen3-tts-instruct-flash-realtime、qwen3-tts-instruct-flash-realtime-2026-01-22 - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27 |
| `Jennifer` | \*\*音色名\*\*：詹妮弗 \*\*描述\*\*：品牌级、电影质感般美语女声（女性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27、qwen3-tts-flash-realtime-2025-09-18 |
| `Ryan` | \*\*音色名\*\*：甜茶 \*\*描述\*\*：节奏拉满，戏感炸裂，真实与张力共舞（男性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27、qwen3-tts-flash-realtime-2025-09-18 |
| `Katerina` | \*\*音色名\*\*：卡捷琳娜 \*\*描述\*\*：御姐音色，韵律回味十足（女性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27、qwen3-tts-flash-realtime-2025-09-18 |
| `Aiden` | \*\*音色名\*\*：艾登 \*\*描述\*\*：精通厨艺的美语大男孩（男性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27 |
| `Eldric Sage` | \*\*音色名\*\*：沧明子 \*\*描述\*\*：沉稳睿智的老者，沧桑如松却心明如镜（男性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash-Realtime\*\*：qwen3-tts-instruct-flash-realtime、qwen3-tts-instruct-flash-realtime-2026-01-22 - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27 |
| `Mia` | \*\*音色名\*\*：乖小妹 \*\*描述\*\*：温顺如春水，乖巧如初雪（女性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash-Realtime\*\*：qwen3-tts-instruct-flash-realtime、qwen3-tts-instruct-flash-realtime-2026-01-22 - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27 |
| `Mochi` | \*\*音色名\*\*：沙小弥 \*\*描述\*\*：聪明伶俐的小大人，童真未泯却早慧如禅（男性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash-Realtime\*\*：qwen3-tts-instruct-flash-realtime、qwen3-tts-instruct-flash-realtime-2026-01-22 - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27 |
| `Bellona` | \*\*音色名\*\*：燕铮莺 \*\*描述\*\*：声音洪亮，吐字清晰，人物鲜活，听得人热血沸腾；金戈铁马入梦来，字正腔圆间尽显千面人声的江湖（女性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash-Realtime\*\*：qwen3-tts-instruct-flash-realtime、qwen3-tts-instruct-flash-realtime-2026-01-22 - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27 |
| `Vincent` | \*\*音色名\*\*：田叔 \*\*描述\*\*：一口独特的沙哑烟嗓，一开口便道尽了千军万马与江湖豪情（男性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash-Realtime\*\*：qwen3-tts-instruct-flash-realtime、qwen3-tts-instruct-flash-realtime-2026-01-22 - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27 |
| `Bunny` | \*\*音色名\*\*：萌小姬 \*\*描述\*\*：“萌属性”爆棚的小萝莉（女性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash-Realtime\*\*：qwen3-tts-instruct-flash-realtime、qwen3-tts-instruct-flash-realtime-2026-01-22 - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27 |
| `Neil` | \*\*音色名\*\*：阿闻 \*\*描述\*\*：平直的基线语调，字正腔圆的咬字发音，这就是最专业的新闻主持人（男性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash-Realtime\*\*：qwen3-tts-instruct-flash-realtime、qwen3-tts-instruct-flash-realtime-2026-01-22 - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27 |
| `Elias` | \*\*音色名\*\*：墨讲师 \*\*描述\*\*：既保持学科严谨性，又通过叙事技巧将复杂知识转化为可消化的认知模块（女性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash-Realtime\*\*：qwen3-tts-instruct-flash-realtime、qwen3-tts-instruct-flash-realtime-2026-01-22 - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27、qwen3-tts-flash-realtime-2025-09-18 |
| `Arthur` | \*\*音色名\*\*：徐大爷 \*\*描述\*\*：被岁月和旱烟浸泡过的质朴嗓音，不疾不徐地摇开了满村的奇闻异事（男性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash-Realtime\*\*：qwen3-tts-instruct-flash-realtime、qwen3-tts-instruct-flash-realtime-2026-01-22 - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27 |
| `Nini` | \*\*音色名\*\*：邻家妹妹 \*\*描述\*\*：糯米糍一样又软又黏的嗓音，那一声声拉长了的“哥哥”，甜得能把人的骨头都叫酥了（女性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash-Realtime\*\*：qwen3-tts-instruct-flash-realtime、qwen3-tts-instruct-flash-realtime-2026-01-22 - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27 |
| `Seren` | \*\*音色名\*\*：小婉 \*\*描述\*\*：温和舒缓的声线，助你更快地进入睡眠，晚安，好梦（女性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash-Realtime\*\*：qwen3-tts-instruct-flash-realtime、qwen3-tts-instruct-flash-realtime-2026-01-22 - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27 |
| `Pip` | \*\*音色名\*\*：顽屁小孩 \*\*描述\*\*：调皮捣蛋却充满童真的他来了，这是你记忆中的小新吗（男性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash-Realtime\*\*：qwen3-tts-instruct-flash-realtime、qwen3-tts-instruct-flash-realtime-2026-01-22 - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27 |
| `Stella` | \*\*音色名\*\*：少女阿月 \*\*描述\*\*：平时是甜到发腻的迷糊少女音，但在喊出“代表月亮消灭你”时，瞬间充满不容置疑的爱与正义（女性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash-Realtime\*\*：qwen3-tts-instruct-flash-realtime、qwen3-tts-instruct-flash-realtime-2026-01-22 - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27 |
| `Bodega` | \*\*音色名\*\*：博德加 \*\*描述\*\*：热情的西班牙大叔（男性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27 |
| `Sonrisa` | \*\*音色名\*\*：索尼莎 \*\*描述\*\*：热情开朗的拉美大姐（女性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27 |
| `Alek` | \*\*音色名\*\*：阿列克 \*\*描述\*\*：一开口，是战斗民族的冷，也是毛呢大衣下的暖（男性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27 |
| `Dolce` | \*\*音色名\*\*：多尔切 \*\*描述\*\*：慵懒的意大利大叔（男性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27 |
| `Sohee` | \*\*音色名\*\*：素熙 \*\*描述\*\*：温柔开朗，情绪丰富的韩国欧尼（女性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27 |
| `Ono Anna` | \*\*音色名\*\*：小野杏 \*\*描述\*\*：鬼灵精怪的青梅竹马（女性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27 |
| `Lenn` | \*\*音色名\*\*：莱恩 \*\*描述\*\*：理性是底色，叛逆藏在细节里——穿西装也听后朋克的德国青年（男性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27 |
| `Emilien` | \*\*音色名\*\*：埃米尔安 \*\*描述\*\*：浪漫的法国大哥哥（男性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27 |
| `Andre` | \*\*音色名\*\*：安德雷 \*\*描述\*\*：声音磁性，自然舒服、沉稳男生（男性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27 |
| `Radio Gol` | \*\*音色名\*\*：拉迪奥·戈尔 \*\*描述\*\*：足球诗人Rádio Gol！今天我要用名字为你们解说足球（男性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27 |
| `Jada` | \*\*音色名\*\*：上海-阿珍 \*\*描述\*\*：风风火火的沪上阿姐（女性） | 中文（上海话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27、qwen3-tts-flash-realtime-2025-09-18 |
| `Dylan` | \*\*音色名\*\*：北京-晓东 \*\*描述\*\*：北京胡同里长大的少年（男性） | 中文（北京话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27、qwen3-tts-flash-realtime-2025-09-18 |
| `Li` | \*\*音色名\*\*：南京-老李 \*\*描述\*\*：耐心的瑜伽老师（男性） | 中文（南京话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27、qwen3-tts-flash-realtime-2025-09-18 |
| `Marcus` | \*\*音色名\*\*：陕西-秦川 \*\*描述\*\*：面宽话短，心实声沉——老陕的味道（男性） | 中文（陕西话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27、qwen3-tts-flash-realtime-2025-09-18 |
| `Roy` | \*\*音色名\*\*：闽南-阿杰 \*\*描述\*\*：诙谐直爽、市井活泼的台湾哥仔形象（男性） | 中文（闽南语）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27、qwen3-tts-flash-realtime-2025-09-18 |
| `Peter` | \*\*音色名\*\*：天津-李彼得 \*\*描述\*\*：天津相声，专业捧哏（男性） | 中文（天津话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27、qwen3-tts-flash-realtime-2025-09-18 |
| `Sunny` | \*\*音色名\*\*：四川-晴儿 \*\*描述\*\*：甜到你心里的川妹子（女性） | 中文（四川话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27、qwen3-tts-flash-realtime-2025-09-18 |
| `Eric` | \*\*音色名\*\*：四川-程川 \*\*描述\*\*：一个跳脱市井的四川成都男子（男性） | 中文（四川话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27、qwen3-tts-flash-realtime-2025-09-18 |
| `Rocky` | \*\*音色名\*\*：粤语-阿强 \*\*描述\*\*：幽默风趣的阿强，在线陪聊（男性） | 中文（粤语）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27、qwen3-tts-flash-realtime-2025-09-18 |
| `Kiki` | \*\*音色名\*\*：粤语-阿清 \*\*描述\*\*：甜美的港妹闺蜜（女性） | 中文（粤语）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash-Realtime\*\*：qwen3-tts-flash-realtime、qwen3-tts-flash-realtime-2025-11-27、qwen3-tts-flash-realtime-2025-09-18 |

 span.aliyun-docs-icon { color: transparent !important; font-size: 0 !important; } span.aliyun-docs-icon:before { color: black; font-size: 16px; } span.aliyun-docs-icon.icon-size-20:before { font-size: 20px; } span.aliyun-docs-icon.icon-size-22:before { font-size: 22px; } span.aliyun-docs-icon.icon-size-24:before { font-size: 24px; } span.aliyun-docs-icon.icon-size-26:before { font-size: 26px; } span.aliyun-docs-icon.icon-size-28:before { font-size: 28px; }
---
*← 返回 [README](./README.md)*
