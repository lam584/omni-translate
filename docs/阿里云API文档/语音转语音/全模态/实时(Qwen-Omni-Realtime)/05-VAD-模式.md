> 来源：`实时(Qwen-Omni-Realtime).md`
\## VAD 模式
OmniServerVad.java

```
import com.alibaba.dashscope.audio.omni.\*;
import com.alibaba.dashscope.exception.NoApiKeyException;
import com.google.gson.JsonObject;
import javax.sound.sampled.\*;
import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.Base64;
import java.util.Map;
import java.util.Queue;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicBoolean;
public class OmniServerVad {
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
            try {
                byte\[] audio = Base64.getDecoder().decode(base64Audio);
                audioQueue.add(audio);
            } catch (Exception e) {
                System.err.println("音频解码失败: " + e.getMessage());
            }
        }
        public void cancel() {
            audioQueue.clear();
            line.flush();
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
            AtomicBoolean userIsSpeaking = new AtomicBoolean(false);
            AtomicBoolean shouldStop = new AtomicBoolean(false);
            OmniRealtimeParam param = OmniRealtimeParam.builder()
                    .model("qwen3.5-omni-plus-realtime")
                    .apikey(System.getenv("DASHSCOPE\_API\_KEY"))
                    // 以下为中国内地（北京）地域url，若使用国际（新加坡）地域的模型，需将url替换为：wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime
                    .url("wss://dashscope.aliyuncs.com/api-ws/v1/realtime")
                    .build();
            OmniRealtimeConversation conversation = new OmniRealtimeConversation(param, new OmniRealtimeCallback() {
                @Override public void onOpen() {
                    System.out.println("连接已建立");
                }
                @Override public void onClose(int code, String reason) {
                    System.out.println("连接已关闭 (" + code + "): " + reason);
                    shouldStop.set(true);
                }
                @Override public void onEvent(JsonObject event) {
                    handleEvent(event, player, userIsSpeaking);
                }
            });
            conversation.connect();
            conversation.updateSession(OmniRealtimeConfig.builder()
                    .modalities(Arrays.asList(OmniRealtimeModality.AUDIO, OmniRealtimeModality.TEXT))
                    .voice("Ethan")
                    .enableTurnDetection(true)
                    .enableInputAudioTranscription(true)
                    .parameters(Map.of("instructions",
                            "你是五星级酒店的AI客服专员，请准确且友好地解答客户关于房型、设施、价格、预订政策的咨询。请始终以专业和乐于助人的态度回应，杜绝提供未经证实或超出酒店服务范围的信息。"))
                    .build()
            );
            System.out.println("请开始说话（自动检测语音开始/结束，按Ctrl+C退出）...");
            AudioFormat format = new AudioFormat(16000, 16, 1, true, false);
            TargetDataLine mic = AudioSystem.getTargetDataLine(format);
            mic.open(format);
            mic.start();
            ByteBuffer buffer = ByteBuffer.allocate(3200);
            while (!shouldStop.get()) {
                int bytesRead = mic.read(buffer.array(), 0, buffer.capacity());
                if (bytesRead > 0) {
                    try {
                        conversation.appendAudio(Base64.getEncoder().encodeToString(buffer.array()));
                    } catch (Exception e) {
                        if (e.getMessage() != null \&\& e.getMessage().contains("closed")) {
                            System.out.println("对话已关闭，停止录音");
                            break;
                        }
                    }
                }
                Thread.sleep(20);
            }
            conversation.close(1000, "正常结束");
            player.close();
            mic.close();
            System.out.println("\\n程序已退出");
        } catch (NoApiKeyException e) {
            System.err.println("未找到API KEY: 请设置环境变量 DASHSCOPE\_API\_KEY");
            System.exit(1);
        } catch (Exception e) {
            e.printStackTrace();
        }
    }
    private static void handleEvent(JsonObject event, SequentialAudioPlayer player, AtomicBoolean userIsSpeaking) {
        String type = event.get("type").getAsString();
        switch (type) {
            case "input\_audio\_buffer.speech\_started":
                System.out.println("\\n\[用户开始说话]");
                player.cancel();
                userIsSpeaking.set(true);
                break;
            case "input\_audio\_buffer.speech\_stopped":
                System.out.println("\[用户停止说话]");
                userIsSpeaking.set(false);
                break;
            case "response.audio.delta":
                if (!userIsSpeaking.get()) {
                    player.play(event.get("delta").getAsString());
                }
                break;
            case "conversation.item.input\_audio\_transcription.completed":
                System.out.println("用户: " + event.get("transcript").getAsString());
                break;
            case "response.audio\_transcript.delta":
                System.out.print(event.get("delta").getAsString());
                break;
            case "response.done":
                System.out.println("回复完成");
                break;
        }
    }
}
```

运行`OmniServerVad.main()`方法，通过麦克风即可与 Realtime 模型实时对话，系统会检测您的音频起始位置并自动发送到服务器，无需您手动发送。
---
*← 返回 [README](./README.md)*
