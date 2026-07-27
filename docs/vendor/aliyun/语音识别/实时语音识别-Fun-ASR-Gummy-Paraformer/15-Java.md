> 来源：`实时语音识别-Fun-ASR-Gummy-Paraformer.md`
\## Java

```
import com.alibaba.dashscope.audio.asr.recognition.Recognition;
import com.alibaba.dashscope.audio.asr.recognition.RecognitionParam;
import com.alibaba.dashscope.exception.NoApiKeyException;
import io.reactivex.BackpressureStrategy;
import io.reactivex.Flowable;
import java.nio.ByteBuffer;
import javax.sound.sampled.AudioFormat;
import javax.sound.sampled.AudioSystem;
import javax.sound.sampled.TargetDataLine;
public class Main {
    public static void main(String\[] args) throws NoApiKeyException {
        // 创建一个Flowable<ByteBuffer>
        Flowable<ByteBuffer> audioSource = Flowable.create(emitter -> {
            new Thread(() -> {
                try {
                    // 创建音频格式
                    AudioFormat audioFormat = new AudioFormat(16000, 16, 1, true, false);
                    // 根据格式匹配默认录音设备
                    TargetDataLine targetDataLine =
                            AudioSystem.getTargetDataLine(audioFormat);
                    targetDataLine.open(audioFormat);
                    // 开始录音
                    targetDataLine.start();
                    ByteBuffer buffer = ByteBuffer.allocate(1024);
                    long start = System.currentTimeMillis();
                    // 录音300s并进行实时转写
                    while (System.currentTimeMillis() - start < 300000) {
                        int read = targetDataLine.read(buffer.array(), 0, buffer.capacity());
                        if (read > 0) {
                            buffer.limit(read);
                            // 将录音音频数据发送给流式识别服务
                            emitter.onNext(buffer);
                            buffer = ByteBuffer.allocate(1024);
                            // 录音速率有限，防止cpu占用过高，休眠一小会儿
                            Thread.sleep(20);
                        }
                    }
                    // 通知结束转写
                    emitter.onComplete();
                } catch (Exception e) {
                    emitter.onError(e);
                }
            }).start();
        },
        BackpressureStrategy.BUFFER);
        // 创建Recognizer
        Recognition recognizer = new Recognition();
        // 创建RecognitionParam，audioFrames参数中传入上面创建的Flowable<ByteBuffer>
        RecognitionParam param = RecognitionParam.builder()
            .model("paraformer-realtime-v2")
            .format("pcm")
            .sampleRate(16000)
            // 若没有将API Key配置到环境变量中，需将下面这行代码注释放开，并将apiKey替换为自己的API Key
            // .apiKey("apikey")
            .build();
        // 流式调用接口
        recognizer.streamCall(param, audioSource)
            // 调用Flowable的subscribe方法订阅结果
            .blockingForEach(
                result -> {
                    // 打印最终结果
                    if (result.isSentenceEnd()) {
                        System.out.println("Fix:" + result.getSentence().getText());
                    } else {
                        System.out.println("Result:" + result.getSentence().getText());
                    }
                });
        System.exit(0);
    }
}
```

---
*← 返回 [README](./README.md)*
