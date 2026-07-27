> 来源：`实时语音识别-Fun-ASR-Gummy-Paraformer.md`
\## Java
示例中用到的音频为：\[asr\\\_example.wav](https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20250210/oiydrd/asr\_example.wav)。

```
import com.alibaba.dashscope.api.GeneralApi;
import com.alibaba.dashscope.audio.asr.recognition.Recognition;
import com.alibaba.dashscope.audio.asr.recognition.RecognitionParam;
import com.alibaba.dashscope.audio.asr.recognition.RecognitionResult;
import com.alibaba.dashscope.base.HalfDuplexParamBase;
import com.alibaba.dashscope.common.GeneralListParam;
import com.alibaba.dashscope.common.ResultCallback;
import com.alibaba.dashscope.protocol.GeneralServiceOption;
import com.alibaba.dashscope.protocol.HttpMethod;
import com.alibaba.dashscope.protocol.Protocol;
import com.alibaba.dashscope.protocol.StreamingMode;
import com.alibaba.dashscope.utils.Constants;
import java.io.FileInputStream;
import java.nio.ByteBuffer;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
class TimeUtils {
    private static final DateTimeFormatter formatter =
            DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss.SSS");
    public static String getTimestamp() {
        return LocalDateTime.now().format(formatter);
    }
}
public class Main {
    public static void main(String\[] args) throws InterruptedException {
        // 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference
        Constants.baseWebsocketApiUrl = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
        // 实际应用中，该方法仅在程序最开始执行一次即可，不必多次执行该方法。
        warmUp();
        ExecutorService executorService = Executors.newSingleThreadExecutor();
        executorService.submit(new RealtimeRecognitionTask(Paths.get(System.getProperty("user.dir"), "asr\_example.wav")));
        executorService.shutdown();
        // wait for all tasks to complete
        executorService.awaitTermination(1, TimeUnit.MINUTES);
        System.exit(0);
    }
    public static void warmUp() {
        try {
            // Lightweight GET request to establish connection
            GeneralServiceOption warmupOption = GeneralServiceOption.builder()
                    .protocol(Protocol.HTTP)
                    .httpMethod(HttpMethod.GET)
                    .streamingMode(StreamingMode.OUT)
                    .path("assistants")
                    .build();
            warmupOption.setBaseHttpUrl(Constants.baseHttpApiUrl);
            GeneralApi<HalfDuplexParamBase> api = new GeneralApi<>();
            api.get(GeneralListParam.builder().limit(1L).build(), warmupOption);
        } catch (Exception e) {
            // Reset flag to allow retry if pre-warming failed
        }
    }
}
class RealtimeRecognitionTask implements Runnable {
    private Path filepath;
    public RealtimeRecognitionTask(Path filepath) {
        this.filepath = filepath;
    }
    @Override
    public void run() {
        RecognitionParam param = RecognitionParam.builder()
                .model("fun-asr-realtime")
                // 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
                // 若没有配置环境变量，请用百炼API Key将下行替换为：.apiKey("sk-xxx")
                .apiKey(System.getenv("DASHSCOPE\_API\_KEY"))
                .format("wav")
                .sampleRate(16000)
                .build();
        Recognition recognizer = new Recognition();
        String threadName = Thread.currentThread().getName();
        ResultCallback<RecognitionResult> callback = new ResultCallback<RecognitionResult>() {
            @Override
            public void onEvent(RecognitionResult message) {
                if (message.isSentenceEnd()) {
                    System.out.println(TimeUtils.getTimestamp()+" "+
                            "\[process " + threadName + "] Final Result:" + message.getSentence().getText());
                } else {
                    System.out.println(TimeUtils.getTimestamp()+" "+
                            "\[process " + threadName + "] Intermediate Result: " + message.getSentence().getText());
                }
            }
            @Override
            public void onComplete() {
                System.out.println(TimeUtils.getTimestamp()+" "+"\[" + threadName + "] Recognition complete");
            }
            @Override
            public void onError(Exception e) {
                System.out.println(TimeUtils.getTimestamp()+" "+
                        "\[" + threadName + "] RecognitionCallback error: " + e.getMessage());
            }
        };
        try {
            recognizer.call(param, callback);
            // Please replace the path with your audio file path
            System.out.println(TimeUtils.getTimestamp()+" "+"\[" + threadName + "] Input file\_path is: " + this.filepath);
            // Read file and send audio by chunks
            FileInputStream fis = new FileInputStream(this.filepath.toFile());
            byte\[] allData = new byte\[fis.available()];
            int ret = fis.read(allData);
            fis.close();
            int sendFrameLength = 3200;
            for (int i = 0; i \* sendFrameLength < allData.length; i ++) {
                int start = i \* sendFrameLength;
                int end = Math.min(start + sendFrameLength, allData.length);
                ByteBuffer byteBuffer = ByteBuffer.wrap(allData, start, end - start);
                recognizer.sendAudioFrame(byteBuffer);
                Thread.sleep(100);
            }
            System.out.println(TimeUtils.getTimestamp()+" "+LocalDateTime.now());
            recognizer.stop();
        } catch (Exception e) {
            e.printStackTrace();
        } finally {
            // 任务结束后关闭 Websocket 连接
            recognizer.getDuplexApi().close(1000, "bye");
        }
        System.out.println(
                "\["
                        + threadName
                        + "]\[Metric] requestId: "
                        + recognizer.getLastRequestId()
                        + ", first package delay ms: "
                        + recognizer.getFirstPackageDelay()
                        + ", last package delay ms: "
                        + recognizer.getLastPackageDelay());
    }
}
```

\## Gummy
\*\*实时语音识别\*\*：适用于会议演讲、视频直播等长时间不间断识别的场景。
\*\*一句话识别\*\*：对停顿更加敏感，支持对一分钟内的短语音进行精准识别，适用于对话聊天、指令控制、语音输入法、语音搜索等短时语音交互场景。
\## 实时语音识别
实时语音识别支持对长时间的语音数据流（无论是从外部设备如麦克风获取的音频流，还是从本地文件读取的音频流）进行识别并流式返回结果。
\## 识别传入麦克风的语音
---
*← 返回 [README](./README.md)*
