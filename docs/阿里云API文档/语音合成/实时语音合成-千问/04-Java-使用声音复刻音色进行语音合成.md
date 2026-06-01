> 来源：`实时语音合成-千问.md`
\## Java
\### \*\*server commit模式\*\*

```
import com.alibaba.dashscope.audio.qwen\_tts\_realtime.\*;
import com.alibaba.dashscope.exception.NoApiKeyException;
import com.google.gson.JsonObject;
import javax.sound.sampled.LineUnavailableException;
import javax.sound.sampled.SourceDataLine;
import javax.sound.sampled.AudioFormat;
import javax.sound.sampled.DataLine;
import javax.sound.sampled.AudioSystem;
import java.io.\*;
import java.util.Base64;
import java.util.Queue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicBoolean;
public class Main {
    static String\[] textToSynthesize = {
            "对吧\~我就特别喜欢这种超市",
            "尤其是过年的时候",
            "去逛超市",
            "就会觉得",
            "超级超级开心！",
            "想买好多好多的东西呢！"
    };
    public static QwenTtsRealtimeAudioFormat ttsFormat = QwenTtsRealtimeAudioFormat.PCM\_24000HZ\_MONO\_16BIT;
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
        private ByteArrayOutputStream totalAudioStream = new ByteArrayOutputStream();
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
                            // 将音频数据写入 totalAudioStream
                            try {
                                totalAudioStream.write(rawAudio);
                            } catch (IOException e) {
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
        public void shutdown() throws InterruptedException, IOException {
            stopped.set(true);
            decoderThread.join();
            playerThread.join();
            // 保存完整音频文件
            File file = new File("TotalAudio\_"+ttsFormat.getSampleRate()+"."+ttsFormat.getFormat());
            try (FileOutputStream fos = new FileOutputStream(file)) {
                fos.write(totalAudioStream.toByteArray());
            }
            if (line != null \&\& line.isRunning()) {
                line.drain();
                line.close();
            }
        }
    }
    public static void main(String\[] args) throws InterruptedException, LineUnavailableException, IOException {
        QwenTtsRealtimeParam param = QwenTtsRealtimeParam.builder()
                // 如需使用指令控制功能，请将model替换为qwen3-tts-instruct-flash-realtime
                .model("qwen3-tts-flash-realtime")
                // 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime
                .url("wss://dashscope.aliyuncs.com/api-ws/v1/realtime")
                // 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
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
                        if (message.has("session")) {
                            String eventId = message.get("event\_id").getAsString();
                            String sessionId = message.get("session").getAsJsonObject().get("id").getAsString();
                            System.out.println("\[onEvent] session.created, session\_id: "
                                    + sessionId + ", event\_id: " + eventId);
                        }
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
                .voice("Cherry")
                .responseFormat(ttsFormat)
                .mode("server\_commit")
                // 如需使用指令控制功能，请取消下方注释，并将model替换为qwen3-tts-instruct-flash-realtime
                // .instructions("")
                // .optimizeInstructions(true)
                .build();
        qwenTtsRealtime.updateSession(config);
        for (String text:textToSynthesize) {
            qwenTtsRealtime.appendText(text);
            Thread.sleep(100);
        }
        qwenTtsRealtime.finish();
        completeLatch.get().await();
        qwenTtsRealtime.close();
        // 等待音频播放完成并关闭播放器
        audioPlayer.waitForComplete();
        audioPlayer.shutdown();
        System.exit(0);
    }
}
```

\### \*\*commit模式\*\*

```
import com.alibaba.dashscope.audio.qwen\_tts\_realtime.\*;
import com.alibaba.dashscope.exception.NoApiKeyException;
import com.google.gson.JsonObject;
import javax.sound.sampled.LineUnavailableException;
import javax.sound.sampled.SourceDataLine;
import javax.sound.sampled.AudioFormat;
import javax.sound.sampled.DataLine;
import javax.sound.sampled.AudioSystem;
import java.io.\*;
import java.util.Base64;
import java.util.Queue;
import java.util.Scanner;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicBoolean;
public class Main {
    public static QwenTtsRealtimeAudioFormat ttsFormat = QwenTtsRealtimeAudioFormat.PCM\_24000HZ\_MONO\_16BIT;
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
        private ByteArrayOutputStream totalAudioStream = new ByteArrayOutputStream();
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
                            // 将音频数据写入 totalAudioStream
                            try {
                                totalAudioStream.write(rawAudio);
                            } catch (IOException e) {
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
            // 等待所有缓冲区中的音频数据播放完成
            while (!b64AudioBuffer.isEmpty() || !RawAudioBuffer.isEmpty()) {
                Thread.sleep(100);
            }
            // 等待音频线路播放完成
            line.drain();
        }
        public void shutdown() throws InterruptedException {
            stopped.set(true);
            decoderThread.join();
            playerThread.join();
            // 保存完整音频文件
            File file = new File("TotalAudio\_"+ttsFormat.getSampleRate()+"."+ttsFormat.getFormat());
            try (FileOutputStream fos = new FileOutputStream(file)) {
                fos.write(totalAudioStream.toByteArray());
            } catch (FileNotFoundException e) {
                throw new RuntimeException(e);
            } catch (IOException e) {
                throw new RuntimeException(e);
            }
            if (line != null \&\& line.isRunning()) {
                line.drain();
                line.close();
            }
        }
    }
    public static void main(String\[] args) throws InterruptedException, LineUnavailableException, FileNotFoundException {
        Scanner scanner = new Scanner(System.in);
        QwenTtsRealtimeParam param = QwenTtsRealtimeParam.builder()
                // 如需使用指令控制功能，请将model替换为qwen3-tts-instruct-flash-realtime
                .model("qwen3-tts-flash-realtime")
                // 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime
                .url("wss://dashscope.aliyuncs.com/api-ws/v1/realtime")
                // 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
                .apikey(System.getenv("DASHSCOPE\_API\_KEY"))
                .build();
        AtomicReference<CountDownLatch> completeLatch = new AtomicReference<>(new CountDownLatch(1));
        // 创建实时播放器实例
        RealtimePcmPlayer audioPlayer = new RealtimePcmPlayer(24000);
        final AtomicReference<QwenTtsRealtime> qwenTtsRef = new AtomicReference<>(null);
        QwenTtsRealtime qwenTtsRealtime = new QwenTtsRealtime(param, new QwenTtsRealtimeCallback() {
            //            File file = new File("result\_24k.pcm");
//            FileOutputStream fos = new FileOutputStream(file);
            @Override
            public void onOpen() {
                System.out.println("connection opened");
                System.out.println("输入文本并按Enter发送，输入'quit'退出程序");
            }
            @Override
            public void onEvent(JsonObject message) {
                String type = message.get("type").getAsString();
                switch(type) {
                    case "session.created":
                        System.out.println("start session: " + message.get("session").getAsJsonObject().get("id").getAsString());
                        break;
                    case "response.audio.delta":
                        String recvAudioB64 = message.get("delta").getAsString();
                        byte\[] rawAudio = Base64.getDecoder().decode(recvAudioB64);
                        //                            fos.write(rawAudio);
                        // 实时播放音频
                        audioPlayer.write(recvAudioB64);
                        break;
                    case "response.done":
                        System.out.println("response done");
                        // 等待音频播放完成
                        try {
                            audioPlayer.waitForComplete();
                        } catch (InterruptedException e) {
                            throw new RuntimeException(e);
                        }
                        // 为下一次输入做准备
                        completeLatch.get().countDown();
                        break;
                    case "session.finished":
                        System.out.println("session finished");
                        if (qwenTtsRef.get() != null) {
                            System.out.println("\[Metric] response: " + qwenTtsRef.get().getResponseId() +
                                    ", first audio delay: " + qwenTtsRef.get().getFirstAudioDelay() + " ms");
                        }
                        completeLatch.get().countDown();
                    default:
                        break;
                }
            }
            @Override
            public void onClose(int code, String reason) {
                System.out.println("connection closed code: " + code + ", reason: " + reason);
                try {
//                    fos.close();
                    // 等待播放完成并关闭播放器
                    audioPlayer.waitForComplete();
                    audioPlayer.shutdown();
                } catch (InterruptedException e) {
                    throw new RuntimeException(e);
                }
            }
        });
        qwenTtsRef.set(qwenTtsRealtime);
        try {
            qwenTtsRealtime.connect();
        } catch (NoApiKeyException e) {
            throw new RuntimeException(e);
        }
        QwenTtsRealtimeConfig config = QwenTtsRealtimeConfig.builder()
                .voice("Cherry")
                .responseFormat(ttsFormat)
                .mode("commit")
                // 如需使用指令控制功能，请取消下方注释，并将model替换为qwen3-tts-instruct-flash-realtime
                // .instructions("")
                // .optimizeInstructions(true)
                .build();
        qwenTtsRealtime.updateSession(config);
        // 循环读取用户输入
        while (true) {
            System.out.print("请输入要合成的文本: ");
            String text = scanner.nextLine();
            // 如果用户输入quit，则退出程序
            if ("quit".equalsIgnoreCase(text.trim())) {
                System.out.println("正在关闭连接...");
                qwenTtsRealtime.finish();
                completeLatch.get().await();
                break;
            }
            // 如果用户输入为空，跳过
            if (text.trim().isEmpty()) {
                continue;
            }
            // 重新初始化倒计时锁存器
            completeLatch.set(new CountDownLatch(1));
            // 发送文本
            qwenTtsRealtime.appendText(text);
            qwenTtsRealtime.commit();
            // 等待本次合成完成
            completeLatch.get().await();
        }
        // 清理资源
        audioPlayer.waitForComplete();
        audioPlayer.shutdown();
        scanner.close();
        System.exit(0);
    }
}
```

\## 使用声音复刻音色进行语音合成
声音复刻服务不提供预览音频，需通过语音合成接口试听并评估效果。建议使用简短文本进行初次测试。
以下示例演示了如何在语音合成中使用声音复刻生成的专属音色，实现与原音高度相似的输出效果。这里参考了使用系统音色进行语音合成DashScope SDK的“server commit模式”示例代码，将`voice`参数替换为复刻生成的专属音色进行语音合成。
\-   \*\*关键原则\*\*：声音复刻时使用的模型 (`target\_model`) 必须与后续进行语音合成时使用的模型 (`model`) 保持一致，否则会导致合成失败。
\-   示例使用本地音频文件 `voice.mp3` 进行声音复刻，运行代码时，请注意替换。
---
*← 返回 [README](./README.md)*
