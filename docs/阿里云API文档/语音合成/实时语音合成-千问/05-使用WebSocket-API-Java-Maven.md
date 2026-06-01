> 来源：`实时语音合成-千问.md`
\## 使用WebSocket API
1\.  \*\*准备运行环境\*\*

    ## Python

    根据您的操作系统安装 pyaudio。

    ## macOS

    ```
    brew install portaudio \&\& pip install pyaudio
    ```

    ## Debian/Ubuntu

    ```
    sudo apt-get install python3-pyaudio
    或者
    pip install pyaudio
    ```

    ## CentOS

    ```
    sudo yum install -y portaudio portaudio-devel \&\& pip install pyaudio
    ```

    ## Windows

    ```
    pip install pyaudio
    ```

    安装完成后，通过 pip 安装 websocket 相关的依赖：

    ```
    pip install websocket-client==1.8.0 websockets
    ```

    ## Java

    在项目中添加以下依赖：

    ## Maven

    在`pom.xml`中添加如下内容：

    ```
    <!-- Java-WebSocket 库 -->
    <dependency>
        <groupId>org.java-websocket</groupId>
        <artifactId>Java-WebSocket</artifactId>
        <version>1.5.7</version>
    </dependency>
    <!-- Gson 用于 JSON 处理 -->
    <dependency>
        <groupId>com.google.code.gson</groupId>
        <artifactId>gson</artifactId>
        <version>2.13.1</version>
    </dependency>
    ```

    ## Gradle

    在`build.gradle`中添加如下内容：

    ```
    // Java-WebSocket 库
    implementation("org.java-websocket:Java-WebSocket:1.5.7")
    // Gson 用于 JSON 处理
    implementation("com.google.code.gson:gson:2.13.1")
    ```

2\.  \*\*创建客户端\*\*

    ## Python

    在本地新建 Python 文件，命名为`tts\_realtime\_client.py`并复制以下代码到文件中：
    tts\\\_realtime\\\_client.py

    ```
    # -- coding: utf-8 --
    import asyncio
    import websockets
    import json
    import base64
    import time
    from typing import Optional, Callable, Dict, Any
    from enum import Enum
    class SessionMode(Enum):
        SERVER\_COMMIT = "server\_commit"
        COMMIT = "commit"
    class TTSRealtimeClient:
        """
        与 TTS Realtime API 交互的客户端。
        该类提供了连接 TTS Realtime API、发送文本数据、获取音频输出以及管理 WebSocket 连接的相关方法。
        属性说明:
            base\_url (str):
                Realtime API 的基础地址。
            api\_key (str):
                用于身份验证的 API Key。
            voice (str):
                服务端合成语音所使用的声音。
            mode (SessionMode):
                会话模式，可选 server\_commit 或 commit。
            audio\_callback (Callable\[\[bytes], None]):
                接收音频数据的回调函数。
            language\_type(str)
                合成的语音的语种，可选值Chinese、English、German、Italian、Portuguese、Spanish、Japanese、Korean、French、Russian、Auto
        """
        def \_\_init\_\_(
                self,
                base\_url: str,
                api\_key: str,
                voice: str = "Cherry",
                mode: SessionMode = SessionMode.SERVER\_COMMIT,
                audio\_callback: Optional\[Callable\[\[bytes], None]] = None,
            language\_type: str = "Auto"):
            self.base\_url = base\_url
            self.api\_key = api\_key
            self.voice = voice
            self.mode = mode
            self.ws = None
            self.audio\_callback = audio\_callback
            self.language\_type = language\_type
            # 当前回复状态
            self.\_current\_response\_id = None
            self.\_current\_item\_id = None
            self.\_is\_responding = False
            self.\_response\_done\_future = None
        async def connect(self) -> None:
            """与 TTS Realtime API 建立 WebSocket 连接。"""
            headers = {
                "Authorization": f"Bearer {self.api\_key}"
            }
            self.ws = await websockets.connect(self.base\_url, additional\_headers=headers)
            # 设置默认会话配置
            await self.update\_session({
                "mode": self.mode.value,
                "voice": self.voice,
                # 如需使用指令控制功能，请取消下方注释，并在server\_commit.py或commit.py中将model替换为qwen3-tts-instruct-flash-realtime
                # "instructions": "语速较快，带有明显的上扬语调，适合介绍时尚产品。",
                # "optimize\_instructions": true
                "language\_type": self.language\_type,
                "response\_format": "pcm",
                "sample\_rate": 24000
            })
        async def send\_event(self, event) -> None:
            """发送事件到服务器。"""
            event\['event\_id'] = "event\_" + str(int(time.time() \* 1000))
            print(f"发送事件: type={event\['type']}, event\_id={event\['event\_id']}")
            await self.ws.send(json.dumps(event))
        async def update\_session(self, config: Dict\[str, Any]) -> None:
            """更新会话配置。"""
            event = {
                "type": "session.update",
                "session": config
            }
            print("更新会话配置: ", event)
            await self.send\_event(event)
        async def append\_text(self, text: str) -> None:
            """向 API 发送文本数据。"""
            event = {
                "type": "input\_text\_buffer.append",
                "text": text
            }
            await self.send\_event(event)
        async def commit\_text\_buffer(self) -> None:
            """提交文本缓冲区以触发处理。"""
            event = {
                "type": "input\_text\_buffer.commit"
            }
            await self.send\_event(event)
        async def clear\_text\_buffer(self) -> None:
            """清除文本缓冲区。"""
            event = {
                "type": "input\_text\_buffer.clear"
            }
            await self.send\_event(event)
        async def finish\_session(self) -> None:
            """结束会话。"""
            event = {
                "type": "session.finish"
            }
            await self.send\_event(event)
        async def wait\_for\_response\_done(self):
            """等待 response.done 事件"""
            if self.\_response\_done\_future:
                await self.\_response\_done\_future
        async def handle\_messages(self) -> None:
            """处理来自服务器的消息。"""
            try:
                async for message in self.ws:
                    event = json.loads(message)
                    event\_type = event.get("type")
                    if event\_type != "response.audio.delta":
                        print(f"收到事件: {event\_type}")
                    if event\_type == "error":
                        print("错误: ", event.get('error', {}))
                        continue
                    elif event\_type == "session.created":
                        print("会话创建，ID: ", event.get('session', {}).get('id'))
                    elif event\_type == "session.updated":
                        print("会话更新，ID: ", event.get('session', {}).get('id'))
                    elif event\_type == "input\_text\_buffer.committed":
                        print("文本缓冲区已提交，项目ID: ", event.get('item\_id'))
                    elif event\_type == "input\_text\_buffer.cleared":
                        print("文本缓冲区已清除")
                    elif event\_type == "response.created":
                        self.\_current\_response\_id = event.get("response", {}).get("id")
                        self.\_is\_responding = True
                        # 创建新的 future 来等待 response.done
                        self.\_response\_done\_future = asyncio.Future()
                        print("响应已创建，ID: ", self.\_current\_response\_id)
                    elif event\_type == "response.output\_item.added":
                        self.\_current\_item\_id = event.get("item", {}).get("id")
                        print("输出项已添加，ID: ", self.\_current\_item\_id)
                    # 处理音频增量
                    elif event\_type == "response.audio.delta" and self.audio\_callback:
                        audio\_bytes = base64.b64decode(event.get("delta", ""))
                        self.audio\_callback(audio\_bytes)
                    elif event\_type == "response.audio.done":
                        print("音频生成完成")
                    elif event\_type == "response.done":
                        self.\_is\_responding = False
                        self.\_current\_response\_id = None
                        self.\_current\_item\_id = None
                        # 标记 future 完成
                        if self.\_response\_done\_future and not self.\_response\_done\_future.done():
                            self.\_response\_done\_future.set\_result(True)
                        print("响应完成")
                    elif event\_type == "session.finished":
                        print("会话已结束")
            except websockets.exceptions.ConnectionClosed:
                print("连接已关闭")
            except Exception as e:
                print("消息处理出错: ", str(e))
        async def close(self) -> None:
            """关闭 WebSocket 连接。"""
            if self.ws:
                await self.ws.close()
    ```

    ## Java

    在本地新建 Java 文件，命名为`TTSRealtimeClient.java`并复制以下代码到文件中：

    ```
    import com.google.gson.Gson;
    import com.google.gson.JsonObject;
    import org.java\_websocket.client.WebSocketClient;
    import org.java\_websocket.handshake.ServerHandshake;
    import java.net.URI;
    import java.util.Base64;
    import java.util.HashMap;
    import java.util.Map;
    import java.util.concurrent.CountDownLatch;
    import java.util.function.Consumer;
    /\*\*
     \* 与 TTS Realtime API 交互的客户端。
     \*
     \* 该类提供了连接 TTS Realtime API、发送文本数据、获取音频输出以及管理 WebSocket 连接的相关方法。
     \*/
    public class TTSRealtimeClient {
        public enum SessionMode {
            SERVER\_COMMIT("server\_commit"),
            COMMIT("commit");
            private final String value;
            SessionMode(String value) { this.value = value; }
            public String getValue() { return value; }
        }
        /\*\*
         \* 音频回调接口
         \*/
        public interface AudioCallback {
            void onAudio(byte\[] audioData);
        }
        private final String baseUrl;
        private final String apiKey;
        private final String voice;
        private final SessionMode mode;
        private final String languageType;
        private final AudioCallback audioCallback;
        private final Gson gson = new Gson();
        private WebSocketClient ws;
        private CountDownLatch responseDoneLatch;
        private CountDownLatch sessionFinishedLatch;
        public TTSRealtimeClient(String baseUrl, String apiKey, String voice,
                                 SessionMode mode, AudioCallback audioCallback,
                                 String languageType) {
            this.baseUrl = baseUrl;
            this.apiKey = apiKey;
            this.voice = voice;
            this.mode = mode;
            this.audioCallback = audioCallback;
            this.languageType = languageType;
        }
        public TTSRealtimeClient(String baseUrl, String apiKey, String voice,
                                 SessionMode mode, AudioCallback audioCallback) {
            this(baseUrl, apiKey, voice, mode, audioCallback, "Auto");
        }
        /\*\*
         \* 与 TTS Realtime API 建立 WebSocket 连接。
         \*/
        public void connect() throws Exception {
            Map<String, String> headers = new HashMap<>();
            headers.put("Authorization", "Bearer " + apiKey);
            responseDoneLatch = new CountDownLatch(0);
            sessionFinishedLatch = new CountDownLatch(1);
            ws = new WebSocketClient(new URI(baseUrl), headers) {
                @Override
                public void onOpen(ServerHandshake handshake) {
                    System.out.println("WebSocket 连接已建立");
                    // 发送默认会话配置
                    JsonObject session = new JsonObject();
                    session.addProperty("mode", mode.getValue());
                    session.addProperty("voice", TTSRealtimeClient.this.voice);
                    // 如需使用指令控制功能，请取消下方注释，并将model替换为qwen3-tts-instruct-flash-realtime
                    // session.addProperty("instructions", "语速较快，带有明显的上扬语调，适合介绍时尚产品。");
                    // session.addProperty("optimize\_instructions", true);
                    session.addProperty("language\_type", languageType);
                    session.addProperty("response\_format", "pcm");
                    session.addProperty("sample\_rate", 24000);
                    updateSession(session);
                }
                @Override
                public void onMessage(String message) {
                    JsonObject event = gson.fromJson(message, JsonObject.class);
                    String eventType = event.has("type") ? event.get("type").getAsString() : "";
                    if (!"response.audio.delta".equals(eventType)) {
                        System.out.println("收到事件: " + eventType);
                    }
                    switch (eventType) {
                        case "error":
                            System.err.println("错误: " + event.get("error"));
                            break;
                        case "session.created":
                            System.out.println("会话创建，ID: " +
                                event.getAsJsonObject("session").get("id").getAsString());
                            break;
                        case "session.updated":
                            System.out.println("会话更新，ID: " +
                                event.getAsJsonObject("session").get("id").getAsString());
                            break;
                        case "input\_text\_buffer.committed":
                            System.out.println("文本缓冲区已提交，项目ID: " + event.get("item\_id"));
                            break;
                        case "input\_text\_buffer.cleared":
                            System.out.println("文本缓冲区已清除");
                            break;
                        case "response.created":
                            System.out.println("响应已创建，ID: " +
                                event.getAsJsonObject("response").get("id").getAsString());
                            responseDoneLatch = new CountDownLatch(1);
                            break;
                        case "response.output\_item.added":
                            System.out.println("输出项已添加，ID: " +
                                event.getAsJsonObject("item").get("id").getAsString());
                            break;
                        case "response.audio.delta":
                            if (audioCallback != null) {
                                byte\[] audioBytes = Base64.getDecoder().decode(
                                    event.get("delta").getAsString());
                                audioCallback.onAudio(audioBytes);
                            }
                            break;
                        case "response.audio.done":
                            System.out.println("音频生成完成");
                            break;
                        case "response.done":
                            System.out.println("响应完成");
                            responseDoneLatch.countDown();
                            break;
                        case "session.finished":
                            System.out.println("会话已结束");
                            sessionFinishedLatch.countDown();
                            break;
                    }
                }
                @Override
                public void onClose(int code, String reason, boolean remote) {
                    System.out.println("连接已关闭: " + reason);
                }
                @Override
                public void onError(Exception ex) {
                    System.err.println("WebSocket 错误: " + ex.getMessage());
                }
            };
            ws.connectBlocking();
        }
        /\*\*
         \* 发送事件到服务器。
         \*/
        public void sendEvent(JsonObject event) {
            String eventId = "event\_" + System.currentTimeMillis();
            event.addProperty("event\_id", eventId);
            System.out.println("发送事件: type=" + event.get("type").getAsString()
                + ", event\_id=" + eventId);
            ws.send(gson.toJson(event));
        }
        /\*\*
         \* 更新会话配置。
         \*/
        public void updateSession(JsonObject config) {
            JsonObject event = new JsonObject();
            event.addProperty("type", "session.update");
            event.add("session", config);
            System.out.println("更新会话配置: " + event);
            sendEvent(event);
        }
        /\*\*
         \* 向 API 发送文本数据。
         \*/
        public void appendText(String text) {
            JsonObject event = new JsonObject();
            event.addProperty("type", "input\_text\_buffer.append");
            event.addProperty("text", text);
            sendEvent(event);
        }
        /\*\*
         \* 提交文本缓冲区以触发处理。
         \*/
        public void commitTextBuffer() {
            JsonObject event = new JsonObject();
            event.addProperty("type", "input\_text\_buffer.commit");
            sendEvent(event);
        }
        /\*\*
         \* 清除文本缓冲区。
         \*/
        public void clearTextBuffer() {
            JsonObject event = new JsonObject();
            event.addProperty("type", "input\_text\_buffer.clear");
            sendEvent(event);
        }
        /\*\*
         \* 结束会话。
         \*/
        public void finishSession() {
            JsonObject event = new JsonObject();
            event.addProperty("type", "session.finish");
            sendEvent(event);
        }
        /\*\*
         \* 等待 response.done 事件。
         \*/
        public void waitForResponseDone() throws InterruptedException {
            responseDoneLatch.await();
        }
        /\*\*
         \* 等待 session.finished 事件。
         \*/
        public void waitForSessionFinished() throws InterruptedException {
            sessionFinishedLatch.await();
        }
        /\*\*
         \* 关闭 WebSocket 连接。
         \*/
        public void close() {
            if (ws != null) {
                ws.close();
            }
        }
    }
    ```

3\.  \*\*选择语音合成模式\*\*
    Realtime API 支持以下两种模式：
    -   \*\*server\\\_commit 模式\*\*
        客户端仅发送文本。服务端会智能判断文本分段方式与合成时机。适合低延迟且无需手动控制合成节奏的场景，例如 GPS 导航。
    -   \*\*commit 模式\*\*
        客户端先将文本添加至缓冲区，再主动触发服务端合成指定文本。适合需精细控制断句和停顿的场景，例如新闻播报。

    ## \*\*server\\\_commit 模式\*\*

    ## Python

    在`tts\_realtime\_client.py`的同级目录下新建另一个 Python 文件，命名为`server\_commit.py`，并将以下代码复制进文件中：
    server\\\_commit.py

    ```
    import os
    import asyncio
    import logging
    import wave
    from tts\_realtime\_client import TTSRealtimeClient, SessionMode
    import pyaudio
    # QwenTTS 服务配置
    # 如需使用指令控制功能，请将model替换为qwen3-tts-instruct-flash-realtime，并在tts\_realtime\_client.py中取消instructions的注释
    # 以下是北京地域url，如果使用新加坡地域的模型，需要将url替换为：wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model=qwen3-tts-flash-realtime
    URL = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-tts-flash-realtime"
    # 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
    # 若没有配置环境变量，请用百炼API Key将下行替换为：API\_KEY="sk-xxx"
    API\_KEY = os.getenv("DASHSCOPE\_API\_KEY")
    if not API\_KEY:
        raise ValueError("Please set DASHSCOPE\_API\_KEY environment variable")
    # 收集音频数据
    \_audio\_chunks = \[]
    # 实时播放相关
    \_AUDIO\_SAMPLE\_RATE = 24000
    \_audio\_pyaudio = pyaudio.PyAudio()
    \_audio\_stream = None  # 将在运行时打开
    def \_audio\_callback(audio\_bytes: bytes):
        """TTSRealtimeClient 音频回调: 实时播放并缓存"""
        global \_audio\_stream
        if \_audio\_stream is not None:
            try:
                \_audio\_stream.write(audio\_bytes)
            except Exception as exc:
                logging.error(f"PyAudio playback error: {exc}")
        \_audio\_chunks.append(audio\_bytes)
        logging.info(f"Received audio chunk: {len(audio\_bytes)} bytes")
    def \_save\_audio\_to\_file(filename: str = "output.wav", sample\_rate: int = 24000) -> bool:
        """将收集到的音频数据保存为 WAV 文件"""
        if not \_audio\_chunks:
            logging.warning("No audio data to save")
            return False
        try:
            audio\_data = b"".join(\_audio\_chunks)
            with wave.open(filename, 'wb') as wav\_file:
                wav\_file.setnchannels(1)  # 单声道
                wav\_file.setsampwidth(2)  # 16-bit
                wav\_file.setframerate(sample\_rate)
                wav\_file.writeframes(audio\_data)
            logging.info(f"Audio saved to: {filename}")
            return True
        except Exception as exc:
            logging.error(f"Failed to save audio: {exc}")
            return False
    async def \_produce\_text(client: TTSRealtimeClient):
        """向服务器发送文本片段"""
        text\_fragments = \[
            "阿里云的大模型服务平台百炼是一站式的大模型开发及应用构建平台。",
            "不论是开发者还是业务人员，都能深入参与大模型应用的设计和构建。",
            "您可以通过简单的界面操作，在5分钟内开发出一款大模型应用，",
            "或在几小时内训练出一个专属模型，从而将更多精力专注于应用创新。",
        ]
        logging.info("Sending text fragments…")
        for text in text\_fragments:
            logging.info(f"Sending fragment: {text}")
            await client.append\_text(text)
            await asyncio.sleep(0.1)  # 片段间稍作延时
        # 等待服务器完成内部处理后结束会话
        await asyncio.sleep(1.0)
        await client.finish\_session()
    async def \_run\_demo():
        """运行完整 Demo"""
        global \_audio\_stream
        # 打开 PyAudio 输出流
        \_audio\_stream = \_audio\_pyaudio.open(
            format=pyaudio.paInt16,
            channels=1,
            rate=\_AUDIO\_SAMPLE\_RATE,
            output=True,
            frames\_per\_buffer=1024
        )
        client = TTSRealtimeClient(
            base\_url=URL,
            api\_key=API\_KEY,
            voice="Cherry",
            mode=SessionMode.SERVER\_COMMIT,
            audio\_callback=\_audio\_callback
        )
        # 建立连接
        await client.connect()
        # 并行执行消息处理与文本发送
        consumer\_task = asyncio.create\_task(client.handle\_messages())
        producer\_task = asyncio.create\_task(\_produce\_text(client))
        await producer\_task  # 等待文本发送完成
        # 等待 response.done
        await client.wait\_for\_response\_done()
        # 关闭连接并取消消费者任务
        await client.close()
        consumer\_task.cancel()
        # 关闭音频流
        if \_audio\_stream is not None:
            \_audio\_stream.stop\_stream()
            \_audio\_stream.close()
        \_audio\_pyaudio.terminate()
        # 保存音频数据
        os.makedirs("outputs", exist\_ok=True)
        \_save\_audio\_to\_file(os.path.join("outputs", "qwen\_tts\_output.wav"))
    def main():
        """同步入口"""
        logging.basicConfig(
            level=logging.INFO,
            format='%(asctime)s \[%(levelname)s] %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        )
        logging.info("Starting QwenTTS Realtime Client demo…")
        asyncio.run(\_run\_demo())
    if \_\_name\_\_ == "\_\_main\_\_":
        main()
    ```

    运行`server\_commit.py`，即可听到 Realtime API 实时生成的音频。

    ## Java

    在`TTSRealtimeClient.java`的同级目录下新建另一个 Java 文件，命名为`ServerCommit.java`，并将以下代码复制进文件中：

    ```
    import javax.sound.sampled.\*;
    import java.io.\*;
    import java.util.ArrayList;
    import java.util.List;
    import java.util.concurrent.ConcurrentLinkedQueue;
    import java.util.concurrent.atomic.AtomicBoolean;
    public class ServerCommit {
        // 以下是北京地域url，如果使用新加坡地域的模型，需要将url替换为：wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model=qwen3-tts-flash-realtime
        private static final String URL = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-tts-flash-realtime";
        // 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
        // 若没有配置环境变量，请用百炼API Key将下行替换为：private static final String API\_KEY = "sk-xxx";
        private static final String API\_KEY = System.getenv("DASHSCOPE\_API\_KEY");
        private static final int SAMPLE\_RATE = 24000;
        // 音频数据缓存
        private static final List<byte\[]> audioChunks = new ArrayList<>();
        // 实时播放队列
        private static final ConcurrentLinkedQueue<byte\[]> playbackQueue = new ConcurrentLinkedQueue<>();
        private static final AtomicBoolean playing = new AtomicBoolean(true);
        public static void main(String\[] args) throws Exception {
            if (API\_KEY == null || API\_KEY.isEmpty()) {
                throw new IllegalStateException("请设置 DASHSCOPE\_API\_KEY 环境变量");
            }
            // 初始化音频播放
            AudioFormat format = new AudioFormat(SAMPLE\_RATE, 16, 1, true, false);
            DataLine.Info info = new DataLine.Info(SourceDataLine.class, format);
            SourceDataLine audioLine = (SourceDataLine) AudioSystem.getLine(info);
            audioLine.open(format);
            audioLine.start();
            // 启动播放线程
            Thread playerThread = new Thread(() -> {
                while (playing.get() || !playbackQueue.isEmpty()) {
                    byte\[] chunk = playbackQueue.poll();
                    if (chunk != null) {
                        audioLine.write(chunk, 0, chunk.length);
                    } else {
                        try { Thread.sleep(10); } catch (InterruptedException ignored) {}
                    }
                }
            });
            playerThread.start();
            // 创建 TTS 客户端
            // 如需使用指令控制功能，请将model替换为qwen3-tts-instruct-flash-realtime，并在TTSRealtimeClient.java中取消instructions的注释
            TTSRealtimeClient client = new TTSRealtimeClient(
                URL, API\_KEY, "Cherry",
                TTSRealtimeClient.SessionMode.SERVER\_COMMIT,
                audioData -> {
                    playbackQueue.add(audioData);
                    audioChunks.add(audioData);
                    System.out.println("收到音频数据: " + audioData.length + " bytes");
                }
            );
            client.connect();
            // 发送文本片段
            String\[] textFragments = {
                "阿里云的大模型服务平台百炼是一站式的大模型开发及应用构建平台。",
                "不论是开发者还是业务人员，都能深入参与大模型应用的设计和构建。",
                "您可以通过简单的界面操作，在5分钟内开发出一款大模型应用，",
                "或在几小时内训练出一个专属模型，从而将更多精力专注于应用创新。"
            };
            System.out.println("开始发送文本...");
            for (String text : textFragments) {
                System.out.println("发送片段: " + text);
                client.appendText(text);
                Thread.sleep(100);
            }
            Thread.sleep(1000);
            client.finishSession();
            // 等待响应完成
            client.waitForResponseDone();
            client.waitForSessionFinished();
            client.close();
            // 等待播放完成
            playing.set(false);
            playerThread.join();
            audioLine.drain();
            audioLine.close();
            // 保存音频文件
            saveWav("output.wav");
            System.out.println("完成");
        }
        private static void saveWav(String filename) throws IOException {
            if (audioChunks.isEmpty()) {
                System.out.println("没有音频数据可保存");
                return;
            }
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            for (byte\[] chunk : audioChunks) {
                bos.write(chunk);
            }
            byte\[] allAudio = bos.toByteArray();
            AudioFormat format = new AudioFormat(SAMPLE\_RATE, 16, 1, true, false);
            AudioInputStream ais = new AudioInputStream(
                new ByteArrayInputStream(allAudio), format, allAudio.length / 2);
            new File("outputs").mkdirs();
            AudioSystem.write(ais, AudioFileFormat.Type.WAVE,
                new File("outputs/" + filename));
            System.out.println("音频已保存到: outputs/" + filename);
        }
    }
    ```

    编译并运行`ServerCommit.java`，即可听到 Realtime API 实时生成的音频。

    ## \*\*commit 模式\*\*

    ## Python

    在`tts\_realtime\_client.py`的同级目录下新建另一个 Python 文件，命名为`commit.py`，并将以下代码复制进文件中：
    commit.py

    ```
    import os
    import asyncio
    import logging
    import wave
    from tts\_realtime\_client import TTSRealtimeClient, SessionMode
    import pyaudio
    # QwenTTS 服务配置
    # 如需使用指令控制功能，请将model替换为qwen3-tts-instruct-flash-realtime，并在tts\_realtime\_client.py中取消instructions的注释
    # 以下是北京地域url，如果使用新加坡地域的模型，需要将url替换为：wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model=qwen3-tts-flash-realtime
    URL = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-tts-flash-realtime"
    # 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
    # 若没有配置环境变量，请用百炼API Key将下行替换为：API\_KEY="sk-xxx"
    API\_KEY = os.getenv("DASHSCOPE\_API\_KEY")
    if not API\_KEY:
        raise ValueError("Please set DASHSCOPE\_API\_KEY environment variable")
    # 收集音频数据
    \_audio\_chunks = \[]
    \_AUDIO\_SAMPLE\_RATE = 24000
    \_audio\_pyaudio = pyaudio.PyAudio()
    \_audio\_stream = None
    def \_audio\_callback(audio\_bytes: bytes):
        """TTSRealtimeClient 音频回调: 实时播放并缓存"""
        global \_audio\_stream
        if \_audio\_stream is not None:
            try:
                \_audio\_stream.write(audio\_bytes)
            except Exception as exc:
                logging.error(f"PyAudio playback error: {exc}")
        \_audio\_chunks.append(audio\_bytes)
        logging.info(f"Received audio chunk: {len(audio\_bytes)} bytes")
    def \_save\_audio\_to\_file(filename: str = "output.wav", sample\_rate: int = 24000) -> bool:
        """将收集到的音频数据保存为 WAV 文件"""
        if not \_audio\_chunks:
            logging.warning("No audio data to save")
            return False
        try:
            audio\_data = b"".join(\_audio\_chunks)
            with wave.open(filename, 'wb') as wav\_file:
                wav\_file.setnchannels(1)  # 单声道
                wav\_file.setsampwidth(2)  # 16-bit
                wav\_file.setframerate(sample\_rate)
                wav\_file.writeframes(audio\_data)
            logging.info(f"Audio saved to: {filename}")
            return True
        except Exception as exc:
            logging.error(f"Failed to save audio: {exc}")
            return False
    async def \_user\_input\_loop(client: TTSRealtimeClient):
        """持续获取用户输入并发送文本，当用户输入空文本时发送commit事件并结束本次会话"""
        print("请输入文本（直接按Enter发送commit事件并结束本次会话，按Ctrl+C或Ctrl+D结束整个程序）：")
        while True:
            try:
                user\_text = input("> ")
                if not user\_text:  # 用户输入为空
                    # 空输入视为一次对话的结束: 提交缓冲区 -> 结束会话 -> 跳出循环
                    logging.info("空输入，发送 commit 事件并结束本次会话")
                    await client.commit\_text\_buffer()
                    # 适当等待服务器处理 commit，防止过早结束会话导致丢失音频
                    await asyncio.sleep(0.3)
                    await client.finish\_session()
                    break  # 直接退出用户输入循环，无需再次回车
                else:
                    logging.info(f"发送文本: {user\_text}")
                    await client.append\_text(user\_text)
            except EOFError:  # 用户按下Ctrl+D
                break
            except KeyboardInterrupt:  # 用户按下Ctrl+c
                break
        # 结束会话
        logging.info("结束会话...")
    async def \_run\_demo():
        """运行完整 Demo"""
        global \_audio\_stream
        # 打开 PyAudio 输出流
        \_audio\_stream = \_audio\_pyaudio.open(
            format=pyaudio.paInt16,
            channels=1,
            rate=\_AUDIO\_SAMPLE\_RATE,
            output=True,
            frames\_per\_buffer=1024
        )
        client = TTSRealtimeClient(
            base\_url=URL,
            api\_key=API\_KEY,
            voice="Cherry",
            mode=SessionMode.COMMIT,  # 修改为COMMIT模式
            audio\_callback=\_audio\_callback
        )
        # 建立连接
        await client.connect()
        # 并行执行消息处理与用户输入
        consumer\_task = asyncio.create\_task(client.handle\_messages())
        producer\_task = asyncio.create\_task(\_user\_input\_loop(client))
        await producer\_task  # 等待用户输入完成
        # 等待 response.done
        await client.wait\_for\_response\_done()
        # 关闭连接并取消消费者任务
        await client.close()
        consumer\_task.cancel()
        # 关闭音频流
        if \_audio\_stream is not None:
            \_audio\_stream.stop\_stream()
            \_audio\_stream.close()
        \_audio\_pyaudio.terminate()
        # 保存音频数据
        os.makedirs("outputs", exist\_ok=True)
        \_save\_audio\_to\_file(os.path.join("outputs", "qwen\_tts\_output.wav"))
    def main():
        logging.basicConfig(
            level=logging.INFO,
            format='%(asctime)s \[%(levelname)s] %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        )
        logging.info("Starting QwenTTS Realtime Client demo…")
        asyncio.run(\_run\_demo())
    if \_\_name\_\_ == "\_\_main\_\_":
        main()
    ```

    运行`commit.py`，可多次输入要合成的文本。在未输入文本的情况下单击 Enter 键，您将从扬声器听到 Realtime API 返回的音频。

    ## Java

    在`TTSRealtimeClient.java`的同级目录下新建另一个 Java 文件，命名为`Commit.java`，并将以下代码复制进文件中：

    ```
    import javax.sound.sampled.\*;
    import java.io.\*;
    import java.util.ArrayList;
    import java.util.List;
    import java.util.Scanner;
    import java.util.concurrent.ConcurrentLinkedQueue;
    import java.util.concurrent.atomic.AtomicBoolean;
    public class Commit {
        // 以下是北京地域url，如果使用新加坡地域的模型，需要将url替换为：wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model=qwen3-tts-flash-realtime
        private static final String URL = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-tts-flash-realtime";
        // 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
        // 若没有配置环境变量，请用百炼API Key将下行替换为：private static final String API\_KEY = "sk-xxx";
        private static final String API\_KEY = System.getenv("DASHSCOPE\_API\_KEY");
        private static final int SAMPLE\_RATE = 24000;
        private static final List<byte\[]> audioChunks = new ArrayList<>();
        private static final ConcurrentLinkedQueue<byte\[]> playbackQueue = new ConcurrentLinkedQueue<>();
        private static final AtomicBoolean playing = new AtomicBoolean(true);
        public static void main(String\[] args) throws Exception {
            if (API\_KEY == null || API\_KEY.isEmpty()) {
                throw new IllegalStateException("请设置 DASHSCOPE\_API\_KEY 环境变量");
            }
            // 初始化音频播放
            AudioFormat format = new AudioFormat(SAMPLE\_RATE, 16, 1, true, false);
            DataLine.Info info = new DataLine.Info(SourceDataLine.class, format);
            SourceDataLine audioLine = (SourceDataLine) AudioSystem.getLine(info);
            audioLine.open(format);
            audioLine.start();
            // 启动播放线程
            Thread playerThread = new Thread(() -> {
                while (playing.get() || !playbackQueue.isEmpty()) {
                    byte\[] chunk = playbackQueue.poll();
                    if (chunk != null) {
                        audioLine.write(chunk, 0, chunk.length);
                    } else {
                        try { Thread.sleep(10); } catch (InterruptedException ignored) {}
                    }
                }
            });
            playerThread.start();
            // 创建 TTS 客户端（commit 模式）
            // 如需使用指令控制功能，请将model替换为qwen3-tts-instruct-flash-realtime，并在TTSRealtimeClient.java中取消instructions的注释
            TTSRealtimeClient client = new TTSRealtimeClient(
                URL, API\_KEY, "Cherry",
                TTSRealtimeClient.SessionMode.COMMIT,
                audioData -> {
                    playbackQueue.add(audioData);
                    audioChunks.add(audioData);
                    System.out.println("收到音频数据: " + audioData.length + " bytes");
                }
            );
            client.connect();
            // 交互式输入
            System.out.println("请输入文本（直接按Enter发送commit事件并结束本次会话，按Ctrl+D结束程序）：");
            Scanner scanner = new Scanner(System.in);
            while (true) {
                System.out.print("> ");
                if (!scanner.hasNextLine()) {
                    client.finishSession();
                    break;
                }
                String userText = scanner.nextLine();
                if (userText.isEmpty()) {
                    // 空输入：提交缓冲区并结束会话
                    System.out.println("空输入，发送 commit 事件并结束本次会话");
                    client.commitTextBuffer();
                    Thread.sleep(300);
                    client.finishSession();
                    break;
                } else {
                    System.out.println("发送文本: " + userText);
                    client.appendText(userText);
                }
            }
            scanner.close();
            // 等待响应完成
            client.waitForResponseDone();
            client.waitForSessionFinished();
            client.close();
            // 等待播放完成
            playing.set(false);
            playerThread.join();
            audioLine.drain();
            audioLine.close();
            // 保存音频文件
            saveWav("output.wav");
            System.out.println("完成");
        }
        private static void saveWav(String filename) throws IOException {
            if (audioChunks.isEmpty()) {
                System.out.println("没有音频数据可保存");
                return;
            }
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            for (byte\[] chunk : audioChunks) {
                bos.write(chunk);
            }
            byte\[] allAudio = bos.toByteArray();
            AudioFormat format = new AudioFormat(SAMPLE\_RATE, 16, 1, true, false);
            AudioInputStream ais = new AudioInputStream(
                new ByteArrayInputStream(allAudio), format, allAudio.length / 2);
            new File("outputs").mkdirs();
            AudioSystem.write(ais, AudioFileFormat.Type.WAVE,
                new File("outputs/" + filename));
            System.out.println("音频已保存到: outputs/" + filename);
        }
    }
    ```

    编译并运行`Commit.java`，可多次输入要合成的文本。在未输入文本的情况下单击 Enter 键，您将从扬声器听到 Realtime API 返回的音频。
\## Java
需要导入Gson依赖，若是使用Maven或者Gradle，添加依赖方式如下：
\## Maven
在`pom.xml`中添加如下内容：

```
<!-- https://mvnrepository.com/artifact/com.google.code.gson/gson -->
<dependency>
    <groupId>com.google.code.gson</groupId>
    <artifactId>gson</artifactId>
    <version>2.13.1</version>
</dependency>
```

---
*← 返回 [README](./README.md)*
