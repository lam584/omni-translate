> 来源：`实时语音识别-Fun-ASR-Gummy-Paraformer.md`
\## Java
示例中用到的音频为：\[hello\\\_world.wav](https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20250415/ojoixp/hello\_world.wav)。

```
import com.alibaba.dashscope.audio.asr.translation.TranslationRecognizerChat;
import com.alibaba.dashscope.audio.asr.translation.TranslationRecognizerParam;
import com.alibaba.dashscope.audio.asr.translation.results.TranslationRecognizerResult;
import com.alibaba.dashscope.common.ResultCallback;
import com.alibaba.dashscope.exception.NoApiKeyException;
import java.io.FileInputStream;
import java.nio.ByteBuffer;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.LocalDateTime;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
class RealtimeTranslateChatTask implements Runnable {
    private Path filepath;
    private TranslationRecognizerChat translator = null;
    public RealtimeTranslateChatTask(Path filepath) {
        this.filepath = filepath;
    }
    @Override
    public void run() {
        for (int i=0; i<1; i++) {
            // 初始化请求参数
            TranslationRecognizerParam param =
                    TranslationRecognizerParam.builder()
                            // 若没有将API Key配置到环境变量中，需将your-api-key替换为自己的API Key
                            // .apiKey("your-api-key")
                            .model("gummy-chat-v1") // 设置模型名
                            .format("wav") // 设置待识别音频格式，支持的音频格式：pcm、pcm编码的wav、mp3、ogg封装的opus、ogg封装的speex、aac、amr
                            .sampleRate(16000) // 设置待识别音频采样率（单位Hz）。只支持16000Hz的采样率。
                            .transcriptionEnabled(true) // 设置是否开启实时识别
                            .translationEnabled(true) // 设置是否开启实时翻译
                            .translationLanguages(new String\[] {"en"}) // 设置翻译目标语言
                            .build();
            if (translator == null) {
                // 初始化流式识别服务
                translator = new TranslationRecognizerChat();
            }
            String threadName = Thread.currentThread().getName();
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
                                    System.out.println("\\tFix:" + result.getTranslationResult().getTranslation("en").getText());
                                } else {
                                    System.out.println("\\tTemp Result:" + result.getTranslationResult().getTranslation("en").getText());
                                }
                            }
                        }
                        @Override
                        public void onComplete() {
                            System.out.println("\[" + threadName + "] Translation complete");
                        }
                        @Override
                        public void onError(Exception e) {
                            e.printStackTrace();
                            System.out.println("\[" + threadName + "] TranslationCallback error: " + e.getMessage());
                        }
                    };
            try {
                // 启动流式语音识别/翻译，绑定请求参数和回调接口
                translator.call(param, callback);
                // 替换成您自己的文件路径
                System.out.println("\[" + threadName + "] Input file\_path is: " + this.filepath);
                // Read file and send audio by chunks
                try (FileInputStream fis = new FileInputStream(this.filepath.toFile())) {
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
                        if (!translator.sendAudioFrame(byteBuffer)) {
                            System.out.println("sentence end, stop sending");
                            break;
                        }
                        buffer = new byte\[3200];
                        Thread.sleep(100);
                    }
                    fis.close();
                    System.out.println(LocalDateTime.now());
                } catch (Exception e) {
                    e.printStackTrace();
                }
                // 通知结束
                translator.stop();
            } catch (Exception e) {
                e.printStackTrace();
            } finally {
                // 任务结束关闭 websocket 连接
                if (translator != null) {
                    translator.getDuplexApi().close(1000, "bye");
                }
            }
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
            executorService.submit(new RealtimeTranslateChatTask(filepath));
        }
        executorService.shutdown();
        // wait for all tasks to complete
        executorService.awaitTermination(1, TimeUnit.MINUTES);
//        System.exit(0);
    }
}
```

\## Paraformer
\## 识别传入麦克风的语音
实时语音识别可以识别麦克风中传入的语音并输出识别结果，达到“边说边出文字”的效果。
---
*← 返回 [README](./README.md)*
