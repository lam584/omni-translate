> 来源：`实时语音识别-Fun-ASR-Gummy-Paraformer.md`
\## Java

```
import com.alibaba.dashscope.audio.asr.translation.TranslationRecognizerParam;
import com.alibaba.dashscope.audio.asr.translation.TranslationRecognizerRealtime;
import com.alibaba.dashscope.audio.asr.translation.results.TranslationRecognizerResult;
import com.alibaba.dashscope.common.ResultCallback;
import javax.sound.sampled.AudioFormat;
import javax.sound.sampled.AudioSystem;
import javax.sound.sampled.TargetDataLine;
import java.nio.ByteBuffer;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
public class Main {
    public static void main(String\[] args) throws InterruptedException {
        ExecutorService executorService = Executors.newSingleThreadExecutor();
        executorService.submit(new RealtimeRecognitionTask());
        executorService.shutdown();
        executorService.awaitTermination(1, TimeUnit.MINUTES);
        System.exit(0);
    }
}
class RealtimeRecognitionTask implements Runnable {
    @Override
    public void run() {
        String targetLanguage = "en";
        // 初始化请求参数
        TranslationRecognizerParam param =
                TranslationRecognizerParam.builder()
                        // 若没有将API Key配置到环境变量中，需将your-api-key替换为自己的API Key
                        // .apiKey("your-api-key")
                        .model("gummy-realtime-v1") // 设置模型名
                        .format("pcm") // 设置待识别音频格式，支持的音频格式：pcm、wav、mp3、opus、speex、aac、amr
                        .sampleRate(16000) // 设置待识别音频采样率（单位Hz）。支持16000Hz及以上采样率。
                        .transcriptionEnabled(true) // 设置是否开启实时识别
                        .sourceLanguage("auto") // 设置源语言（待识别/翻译语言）代码
                        .translationEnabled(true) // 设置是否开启实时翻译
                        .translationLanguages(new String\[] {targetLanguage}) // 设置翻译目标语言
                        .build();
        // 初始化回调接口
        ResultCallback<TranslationRecognizerResult> callback =
                new ResultCallback<TranslationRecognizerResult>() {
                    @Override
                    public void onEvent(TranslationRecognizerResult result) {
                        System.out.println("RequestId: " + result.getRequestId());
                        // 打印最终结果
                        if (result.getTranscriptionResult() != null) {
                            System.out.println("Transcription Result:"+result);
                            if (result.isSentenceEnd()) {
                                System.out.println("\\tFix:" + result.getTranscriptionResult().getText());
                            } else {
                                System.out.println("\\tTemp Result:" + result.getTranscriptionResult().getText());
                            }
                        }
                        if (result.getTranslationResult() != null) {
                            System.out.println("English Translation Result:");
                            if (result.isSentenceEnd()) {
                                System.out.println("\\tFix:" + result.getTranslationResult().getTranslation(targetLanguage).getText());
                            } else {
                                System.out.println("\\tTemp Result:" + result.getTranslationResult().getTranslation(targetLanguage).getText());
                            }
                        }
                    }
                    @Override
                    public void onComplete() {
                        System.out.println("Translation complete");
                    }
                    @Override
                    public void onError(Exception e) {
                        e.printStackTrace();
                        System.out.println("TranslationCallback error: " + e.getMessage());
                    }
                };
        // 初始化流式识别服务
        TranslationRecognizerRealtime translator = new TranslationRecognizerRealtime();
        try {
            // 启动流式语音识别/翻译，绑定请求参数和回调接口
            translator.call(param, callback);
            // 创建音频格式
            AudioFormat audioFormat = new AudioFormat(16000, 16, 1, true, false);
            // 根据格式匹配默认录音设备
            TargetDataLine targetDataLine =
                    AudioSystem.getTargetDataLine(audioFormat);
            targetDataLine.open(audioFormat);
            // 开始录音
            targetDataLine.start();
            System.out.println("请您通过麦克风讲话体验实时语音识别和翻译功能");
            ByteBuffer buffer = ByteBuffer.allocate(1024);
            long start = System.currentTimeMillis();
            // 录音50s并进行实时识别
            while (System.currentTimeMillis() - start < 50000) {
                int read = targetDataLine.read(buffer.array(), 0, buffer.capacity());
                if (read > 0) {
                    buffer.limit(read);
                    // 将录音音频数据发送给流式识别服务
                    translator.sendAudioFrame(buffer);
                    buffer = ByteBuffer.allocate(1024);
                    // 录音速率有限，防止cpu占用过高，休眠一小会儿
                    Thread.sleep(20);
                }
            }
            // 通知结束
            translator.stop();
        } catch (Exception e) {
            e.printStackTrace();
        } finally {
            // 任务结束关闭 websocket 连接
            translator.getDuplexApi().close(1000, "bye");
        }
        System.out.println(
                "\[Metric] requestId: "
                        + translator.getLastRequestId()
                        + ", first package delay ms: "
                        + translator.getFirstPackageDelay()
                        + ", last package delay ms: "
                        + translator.getLastPackageDelay());
    }
}
```

\## 识别本地文件
---
*← 返回 [README](./README.md)*
