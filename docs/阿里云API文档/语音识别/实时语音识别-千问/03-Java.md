> 来源：`实时语音识别-千问.md`
\## Java
1\.  \[安装SDK](https://help.aliyun.com/zh/model-studio/install-sdk)，确保DashScope SDK版本不低于2.22.5。
2\.  \[获取API Key](https://help.aliyun.com/zh/model-studio/get-api-key)，推荐使用环境变量配置 API Key，以避免在代码中硬编码。
3\.  运行示例代码。
    更多示例代码请参见\[Github](https://github.com/aliyun/alibabacloud-bailian-speech-demo/tree/master/samples/speech-recognition/recognize\_speech\_from\_microphone\_with\_qwen3\_asr\_flash\_realtime)。

    ```
    import com.alibaba.dashscope.audio.omni.\*;
    import com.alibaba.dashscope.exception.NoApiKeyException;
    import com.google.gson.JsonObject;
    import org.slf4j.Logger;
    import org.slf4j.LoggerFactory;
    import javax.sound.sampled.LineUnavailableException;
    import java.io.File;
    import java.io.FileInputStream;
    import java.util.Base64;
    import java.util.Collections;
    import java.util.concurrent.CountDownLatch;
    import java.util.concurrent.atomic.AtomicReference;
    public class Qwen3AsrRealtimeUsage {
        private static final Logger log = LoggerFactory.getLogger(Qwen3AsrRealtimeUsage.class);
        private static final int AUDIO\_CHUNK\_SIZE = 1024; // Audio chunk size in bytes
        private static final int SLEEP\_INTERVAL\_MS = 30;  // Sleep interval in milliseconds
        public static void main(String\[] args) throws InterruptedException, LineUnavailableException {
            CountDownLatch finishLatch = new CountDownLatch(1);
            OmniRealtimeParam param = OmniRealtimeParam.builder()
                    .model("qwen3-asr-flash-realtime")
                    // 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime
                    .url("wss://dashscope.aliyuncs.com/api-ws/v1/realtime")
                    // 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
                    // 若没有配置环境变量，请用百炼API Key将下行替换为：.apikey("sk-xxx")
                    .apikey(System.getenv("DASHSCOPE\_API\_KEY"))
                    .build();
            OmniRealtimeConversation conversation = null;
            final AtomicReference<OmniRealtimeConversation> conversationRef = new AtomicReference<>(null);
            conversation = new OmniRealtimeConversation(param, new OmniRealtimeCallback() {
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
                            System.out.println("transcription: " + message.get("transcript").getAsString());
                            finishLatch.countDown();
                            break;
                        case "input\_audio\_buffer.speech\_started":
                            System.out.println("======VAD Speech Start======");
                            break;
                        case "input\_audio\_buffer.speech\_stopped":
                            System.out.println("======VAD Speech Stop======");
                            break;
                        case "conversation.item.input\_audio\_transcription.text":
                            System.out.println("transcription: " + message.get("text").getAsString() + message.get("stash").getAsString());
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
            OmniRealtimeTranscriptionParam transcriptionParam = new OmniRealtimeTranscriptionParam();
            transcriptionParam.setLanguage("zh");
            transcriptionParam.setInputAudioFormat("pcm");
            transcriptionParam.setInputSampleRate(16000);
            OmniRealtimeConfig config = OmniRealtimeConfig.builder()
                    .modalities(Collections.singletonList(OmniRealtimeModality.TEXT))
                    .transcriptionConfig(transcriptionParam)
                    .build();
            conversation.updateSession(config);
            String filePath = "your\_audio\_file.pcm";
            File audioFile = new File(filePath);
            if (!audioFile.exists()) {
                log.error("Audio file not found: {}", filePath);
                return;
            }
            try (FileInputStream audioInputStream = new FileInputStream(audioFile)) {
                byte\[] audioBuffer = new byte\[AUDIO\_CHUNK\_SIZE];
                int bytesRead;
                int totalBytesRead = 0;
                log.info("Starting to send audio data from: {}", filePath);
                // Read and send audio data in chunks
                while ((bytesRead = audioInputStream.read(audioBuffer)) != -1) {
                    totalBytesRead += bytesRead;
                    String audioB64 = Base64.getEncoder().encodeToString(audioBuffer);
                    // Send audio chunk to conversation
                    conversation.appendAudio(audioB64);
                    // Add small delay to simulate real-time audio streaming
                    Thread.sleep(SLEEP\_INTERVAL\_MS);
                }
                log.info("Finished sending audio data. Total bytes sent: {}", totalBytesRead);
            } catch (Exception e) {
                log.error("Error sending audio from file: {}", filePath, e);
            }
            //send session.finish and wait for finish and close
            conversation.endSession();
            log.info("task finished");
            System.exit(0);
        }
    }
    ```

---
*← 返回 [README](./README.md)*
