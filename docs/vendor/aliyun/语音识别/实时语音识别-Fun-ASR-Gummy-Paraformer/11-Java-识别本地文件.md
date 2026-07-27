> 来源：`实时语音识别-Fun-ASR-Gummy-Paraformer.md`
\## Java

```
package org.alibaba.bailian.example.examples;
import com.alibaba.dashscope.audio.asr.translation.TranslationRecognizerChat;
import com.alibaba.dashscope.audio.asr.translation.TranslationRecognizerParam;
import com.alibaba.dashscope.audio.asr.translation.results.TranscriptionResult;
import com.alibaba.dashscope.audio.asr.translation.results.TranslationRecognizerResult;
import com.alibaba.dashscope.common.ResultCallback;
import com.alibaba.dashscope.exception.NoApiKeyException;
import javax.sound.sampled.AudioFormat;
import javax.sound.sampled.AudioSystem;
import javax.sound.sampled.LineUnavailableException;
import javax.sound.sampled.TargetDataLine;
import java.nio.ByteBuffer;
public class Main {
    public static void main(String\[] args) throws NoApiKeyException, InterruptedException, LineUnavailableException {
        // 创建Recognizer
        TranslationRecognizerChat translator = new TranslationRecognizerChat();
        // 初始化请求参数
        TranslationRecognizerParam param =
                TranslationRecognizerParam.builder()
                        // 若没有将API Key配置到环境变量中，需将your-api-key替换为自己的API Key
                        // .apiKey("your-api-key")
                        .model("gummy-chat-v1") // 设置模型名
                        .format("pcm") // 设置待识别音频格式，支持的音频格式：pcm、pcm编码的wav、mp3、ogg封装的opus、ogg封装的speex、aac、amr
                        .sampleRate(16000) // 设置待识别音频采样率（单位Hz）。仅支持16000Hz采样率。
                        .transcriptionEnabled(true) // 设置是否开启实时识别
                        .translationEnabled(true) // 设置是否开启实时翻译
                        .translationLanguages(new String\[] {"en"}) // 设置翻译目标语言
                        .build();
        try {
            translator.call(param, new ResultCallback<TranslationRecognizerResult>() {
                @Override
                public void onEvent(TranslationRecognizerResult result) {
                    if (result.getTranscriptionResult() == null) {
                        return;
                    }
                    try {
                        System.out.println("RequestId: " + result.getRequestId());
                        // 打印最终结果
                        if (result.getTranscriptionResult() != null) {
                            System.out.println("Transcription Result:");
                            if (result.isSentenceEnd()) {
                                System.out.println("\\tFix:" + result.getTranscriptionResult().getText());
                            } else {
                                TranscriptionResult transcriptionResult = result.getTranscriptionResult();
                                System.out.println("\\tTemp Result:" + transcriptionResult.getText());
                                if (result.getTranscriptionResult().isVadPreEnd()) {
                                    System.out.printf("VadPreEnd: start:%d, end:%d, time:%d\\n", transcriptionResult.getPreEndStartTime(), transcriptionResult.getPreEndEndTime(), transcriptionResult.getPreEndTimemillis());
                                }
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
                    } catch (Exception e) {
                        e.printStackTrace();
                    }
                }
                @Override
                public void onComplete() {
                    System.out.println("Translation complete");
                }
                @Override
                public void onError(Exception e) {
                }
            });
            // 创建音频格式
            AudioFormat audioFormat = new AudioFormat(16000, 16, 1, true, false);
            // 根据格式匹配默认录音设备
            TargetDataLine targetDataLine =
                    AudioSystem.getTargetDataLine(audioFormat);
            targetDataLine.open(audioFormat);
            // 开始录音
            targetDataLine.start();
            System.out.println("请您通过麦克风讲话体验一句话语音识别和翻译功能");
            ByteBuffer buffer = ByteBuffer.allocate(1024);
            long start = System.currentTimeMillis();
            // 录音5s并进行实时识别
            while (System.currentTimeMillis() - start < 50000) {
                int read = targetDataLine.read(buffer.array(), 0, buffer.capacity());
                if (read > 0) {
                    buffer.limit(read);
                    // 将录音音频数据发送给流式识别服务
                    if (!translator.sendAudioFrame(buffer)) {
                        System.out.println("sentence end, stop sending");
                        break;
                    }
                    buffer = ByteBuffer.allocate(1024);
                    // 录音速率有限，防止cpu占用过高，休眠一小会儿
                    Thread.sleep(20);
                }
            }
            translator.stop();
        } catch (Exception e) {
            e.printStackTrace();
        } finally {
            // 任务结束关闭 websocket 连接
            translator.getDuplexApi().close(1000, "bye");
        }
        System.exit(0);
    }
}
```

\## 识别本地文件
---
*← 返回 [README](./README.md)*
