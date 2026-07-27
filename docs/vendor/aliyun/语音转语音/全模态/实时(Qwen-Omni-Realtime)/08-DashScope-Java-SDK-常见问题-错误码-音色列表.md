> 来源：`实时(Qwen-Omni-Realtime).md`
\## DashScope Java SDK
在 `updateSession` 中通过 `parameters` 传入联网搜索配置：

```
import com.alibaba.dashscope.audio.omni.\*;
import com.alibaba.dashscope.exception.NoApiKeyException;
import com.google.gson.JsonObject;
import javax.sound.sampled.\*;
import java.nio.ByteBuffer;
import java.util.\*;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicBoolean;
public class OmniSearch {
    static class SequentialAudioPlayer {
        private final SourceDataLine line;
        private final Queue<byte\[]> audioQueue = new ConcurrentLinkedQueue<>();
        private final Thread playerThread;
        private final AtomicBoolean shouldStop = new AtomicBoolean(false);
        public SequentialAudioPlayer() throws LineUnavailableException {
            AudioFormat format = new AudioFormat(24000, 16, 1, true, false);
            line = AudioSystem.getSourceDataLine(format);
            line.open(format);
            line.start();
            playerThread = new Thread(() -> {
                while (!shouldStop.get()) {
                    byte\[] audio = audioQueue.poll();
                    if (audio != null) {
                        line.write(audio, 0, audio.length);
                    } else {
                        try { Thread.sleep(10); } catch (InterruptedException ignored) {}
                    }
                }
            }, "AudioPlayer");
            playerThread.start();
        }
        public void play(String base64Audio) {
            audioQueue.add(Base64.getDecoder().decode(base64Audio));
        }
        public void close() {
            shouldStop.set(true);
            try { playerThread.join(1000); } catch (InterruptedException ignored) {}
            line.drain();
            line.close();
        }
    }
    public static void main(String\[] args) {
        try {
            SequentialAudioPlayer player = new SequentialAudioPlayer();
            AtomicBoolean shouldStop = new AtomicBoolean(false);
            OmniRealtimeParam param = OmniRealtimeParam.builder()
                    .model("qwen3.5-omni-plus-realtime")
                    .apikey(System.getenv("DASHSCOPE\_API\_KEY"))
                    .url("wss://dashscope.aliyuncs.com/api-ws/v1/realtime")
                    .build();
            OmniRealtimeConversation conversation = new OmniRealtimeConversation(param, new OmniRealtimeCallback() {
                @Override public void onOpen() {
                    System.out.println("连接已建立");
                }
                @Override public void onClose(int code, String reason) {
                    System.out.println("连接已关闭");
                    shouldStop.set(true);
                }
                @Override public void onEvent(JsonObject event) {
                    String type = event.get("type").getAsString();
                    if ("response.audio.delta".equals(type)) {
                        player.play(event.get("delta").getAsString());
                    } else if ("response.audio\_transcript.done".equals(type)) {
                        System.out.println("\[LLM] " + event.get("transcript").getAsString());
                    } else if ("response.done".equals(type)) {
                        JsonObject response = event.getAsJsonObject("response");
                        if (response != null \&\& response.has("usage")) {
                            JsonObject usage = response.getAsJsonObject("usage");
                            if (usage.has("plugins")) {
                                JsonObject plugins = usage.getAsJsonObject("plugins");
                                if (plugins.has("search")) {
                                    JsonObject search = plugins.getAsJsonObject("search");
                                    System.out.println("\[Search] count=" + search.get("count").getAsInt()
                                            + ", strategy=" + search.get("strategy").getAsString());
                                }
                            }
                        }
                    }
                }
            });
            conversation.connect();
            conversation.updateSession(OmniRealtimeConfig.builder()
                    .modalities(Arrays.asList(OmniRealtimeModality.AUDIO, OmniRealtimeModality.TEXT))
                    .voice("Tina")
                    .enableTurnDetection(true)
                    .enableInputAudioTranscription(true)
                    .parameters(Map.of(
                            "instructions", "你是个人助理小云",
                            "enable\_search", true,
                            "search\_options", Map.of("enable\_source", true)
                    ))
                    .build()
            );
            System.out.println("联网搜索已启用，请开始说话（按Ctrl+C退出）...");
            AudioFormat format = new AudioFormat(16000, 16, 1, true, false);
            TargetDataLine mic = AudioSystem.getTargetDataLine(format);
            mic.open(format);
            mic.start();
            ByteBuffer buffer = ByteBuffer.allocate(3200);
            while (!shouldStop.get()) {
                int bytesRead = mic.read(buffer.array(), 0, buffer.capacity());
                if (bytesRead > 0) {
                    conversation.appendAudio(Base64.getEncoder().encodeToString(buffer.array()));
                }
                Thread.sleep(20);
            }
            conversation.close(1000, "正常结束");
            player.close();
            mic.close();
        } catch (NoApiKeyException e) {
            System.err.println("未找到API KEY: 请设置环境变量 DASHSCOPE\_API\_KEY");
        } catch (Exception e) {
            e.printStackTrace();
        }
    }
}
```

\## \*\*常见问题\*\*
\### \*\*如何在线体验 Qwen-Omni-Realtime 模型？\*\*
A：您可以通过以下方式一键部署：
1\.  访问\[函数计算模板](https://fcnext.console.aliyun.com/applications/create?template=omni-realtime@dev)，\*\*部署类型\*\*选择\*\*直接部署\*\*，\*\*百炼 API-KEY\*\* 填入您的 API Key；单击\*\*创建并部署默认环境\*\*。
2\.  等待约一分钟，在\*\*环境详情\*\*的\*\*环境信息\*\*中获取\*\*访问域名\*\*，\*\*将访问域名的\*\*`\*\*http\*\*`\*\*改成\*\*`\*\*https\*\*`（示例：https://omni-realtime.fcv3.xxxx.cn-hangzhou.fc.devsapp.net），修改后的 HTTPS 链接指向一个可在线体验的 Web 应用，可通过它与模型进行实时视频或语音通话。
\*\*重要\*\*
此链接使用自签名证书，仅用于临时测试。首次访问时，浏览器会显示安全警告，这是预期行为，\*\*请勿在生产环境使用\*\*。如需继续，请按浏览器提示操作（如点击“高级” → “继续前往（不安全）”）。
> 通过\*\*资源信息\*\*\\-\*\*函数资源\*\*查看项目源代码。
> \[函数计算](https://help.aliyun.com/zh/functioncompute/fc/product-overview/trial-quota-1)与\[阿里云百炼](https://help.aliyun.com/zh/model-studio/new-free-quota)均为新用户提供免费额度，可以覆盖简单调试所需成本，额度耗尽后按量计费。只有在访问的情况下会产生费用。
\### \*\*怎么向模型输入图片？\*\*
A：通过客户端发送\[input\\\_image\\\_buffer.append](https://help.aliyun.com/zh/model-studio/client-events#c28ed38410nfw)事件。
\-   VAD 模式
    该模式会根据语音检测情况自动提交音频与图片，请在服务端响应\[input\\\_audio\\\_buffer.speech\\\_stopped](https://help.aliyun.com/zh/model-studio/server-events#fd08ffdf0a2mt)前发送\[input\\\_image\\\_buffer.append](https://help.aliyun.com/zh/model-studio/client-events#c28ed38410nfw)事件。
\-   Manual 模式
    参见\[Manual 模式](#b3fed8b9161vd)代码，将图片输入与提交的两部分代码取消注释，即可传入本地图片。
若用于视频通话场景，可以对视频抽帧，建议以 1张/秒 的频率向服务端发送图像。\[input\\\_image\\\_buffer.append](https://help.aliyun.com/zh/model-studio/client-events#c28ed38410nfw) 事件。 DashScope SDK 代码请参见\[Omni-Realtime 示例代码](https://github.com/aliyun/alibabacloud-bailian-speech-demo/tree/master/samples/conversation/omni)。
\## \*\*错误码\*\*
如果模型调用失败并返回报错信息，请参见\[错误信息](https://help.aliyun.com/zh/model-studio/error-code)进行解决。
\## \*\*音色列表\*\*
Qwen-Omni-Realtime模型的音色列表可参见\[音色列表](https://help.aliyun.com/zh/model-studio/omni-voice-list)。
/\\\* 让引用上下间距调小，避免内容显示过于稀疏 \\\*/ .unionContainer .markdown-body blockquote { margin: 4px 0; } .aliyun-docs-content table.qwen blockquote { border-left: none; /\\\* 添加这一行来移除表格里的引用文字的左侧边框 \\\*/ padding-left: 5px; /\\\* 左侧内边距 \\\*/ margin: 4px 0; }
---
*← 返回 [README](./README.md)*
