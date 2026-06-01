> 来源：`实时语音识别-Fun-ASR-Gummy-Paraformer.md`
\## Java
示例中用到的音频为：\[hello\\\_world.wav](https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20250415/ngevnu/hello\_world.wav)。

```
import com.alibaba.dashscope.audio.asr.translation.TranslationRecognizerParam;
import com.alibaba.dashscope.audio.asr.translation.TranslationRecognizerRealtime;
import com.alibaba.dashscope.audio.asr.translation.results.TranslationRecognizerResult;
import com.alibaba.dashscope.common.ResultCallback;
import com.alibaba.dashscope.exception.NoApiKeyException;
import java.io.FileInputStream;
import java.nio.ByteBuffer;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.LocalDateTime;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
class RealtimeTranslateTask implements Runnable {
    private Path filepath;
    public RealtimeTranslateTask(Path filepath) {
        this.filepath = filepath;
    }
    @Override
    public void run() {
        String targetLanguage = "en";
        // Create translation params
        // you can customize the translation parameters, like model, format,
        // sample\_rate for more information, please refer to
        // https://help.aliyun.com/document\_detail/2712536.html
        TranslationRecognizerParam param =
                TranslationRecognizerParam.builder()
                        // 若没有将API Key配置到环境变量中，需将your-api-key替换为自己的API Key
                        // .apiKey("your-api-key")
                        .model("gummy-realtime-v1")
                        .format("wav") // 'pcm'、'wav'、'mp3'、'opus'、'speex'、'aac'、'amr', you
                        // can check the supported formats in the document
                        .sampleRate(16000)
                        .transcriptionEnabled(true)
                        .sourceLanguage("auto")
                        .translationEnabled(true)
                        .translationLanguages(new String\[] {targetLanguage})
                        .build();
        TranslationRecognizerRealtime translator = new TranslationRecognizerRealtime();
        CountDownLatch latch = new CountDownLatch(1);
        String threadName = Thread.currentThread().getName();
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
                        System.out.println("\[" + threadName + "] Translation complete");
                        latch.countDown();
                    }
                    @Override
                    public void onError(Exception e) {
                        e.printStackTrace();
                        System.out.println("\[" + threadName + "] TranslationCallback error: " + e.getMessage());
                    }
                };
        // set param \& callback
        try {
            translator.call(param, callback);
            // Please replace the path with your audio file path
            System.out.println("\[" + threadName + "] Input file\_path is: " + this.filepath);
            // Read file and send audio by chunks
            FileInputStream fis = new FileInputStream(this.filepath.toFile());
            // chunk size set to 1 seconds for 16KHz sample rate
            byte\[] buffer = new byte\[3200];
            int bytesRead;
            // Loop to read chunks of the file
            while ((bytesRead = fis.read(buffer)) != -1) {
                ByteBuffer byteBuffer;
                // Handle the last chunk which might be smaller than the buffer size
                System.out.println("\[" + threadName + "] bytesRead: " + bytesRead);
                if (bytesRead < buffer.length) {
                    byteBuffer = ByteBuffer.wrap(buffer, 0, bytesRead);
                } else {
                    byteBuffer = ByteBuffer.wrap(buffer);
                }
                // Send the ByteBuffer to the translation instance
                translator.sendAudioFrame(byteBuffer);
                buffer = new byte\[3200];
                Thread.sleep(100);
            }
            System.out.println(LocalDateTime.now());
            translator.stop();
        } catch (Exception e) {
            e.printStackTrace();
        } finally {
            // 任务结束关闭 websocket 连接
            translator.getDuplexApi().close(1000, "bye");
        }
        // wait for the translation to complete
        try {
            latch.await();
        } catch (InterruptedException e) {
            throw new RuntimeException(e);
        }
    }
}
public class Main {
    public static void main(String\[] args)
            throws NoApiKeyException, InterruptedException {
        String currentDir = System.getProperty("user.dir");
        // Please replace the path with your audio source
        Path\[] filePaths = {
                Paths.get(currentDir, "hello\_world.wav"),
//                Paths.get(currentDir, "hello\_world\_male\_16k\_16bit\_mono.wav"),
        };
        // Use ThreadPool to run recognition tasks
        ExecutorService executorService = Executors.newFixedThreadPool(10);
        for (Path filepath:filePaths) {
            executorService.submit(new RealtimeTranslateTask(filepath));
        }
        executorService.shutdown();
        // wait for all tasks to complete
        executorService.awaitTermination(1, TimeUnit.MINUTES);
        System.exit(0);
    }
}
```

\## 一句话识别
一句话识别能够对一分钟内的语音数据流（无论是从外部设备如麦克风获取的音频流，还是从本地文件读取的音频流）进行识别并流式返回结果。
\## 识别传入麦克风的语音
---
*← 返回 [README](./README.md)*
