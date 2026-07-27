> 来源：`实时语音识别-千问.md`
\## 使用WebSocket API
以下示例演示如何通过 WebSocket 连接发送本地音频文件并获取识别结果。
1\.  \*\*获取API Key：\*\*\[获取API Key](https://help.aliyun.com/zh/model-studio/get-api-key)，安全起见，推荐将API Key配置到环境变量。
2\.  \*\*编写并运行代码：\*\*通过代码实现认证、连接、发送音频和接收结果的完整流程（详情请参见\[交互流程](https://help.aliyun.com/zh/model-studio/qwen-asr-realtime-interaction-process#1b15e5c235azv)）。

    ## Python

    在运行示例前，请确保已使用以下命令安装依赖：

    ```
    pip uninstall websocket-client
    pip uninstall websocket
    pip install websocket-client
    ```

    请不要将示例代码文件命名为 `websocket.py`，否则可能触发如下错误：AttributeError: module 'websocket' has no attribute 'WebSocketApp'. Did you mean: 'WebSocket'?

    ```
    # pip install websocket-client
    import os
    import time
    import json
    import threading
    import base64
    import websocket
    import logging
    import logging.handlers
    from datetime import datetime
    logger = logging.getLogger(\_\_name\_\_)
    logger.setLevel(logging.DEBUG)
    # 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
    # 若没有配置环境变量，请用百炼API Key将下行替换为：API\_KEY="sk-xxx"
    API\_KEY = os.environ.get("DASHSCOPE\_API\_KEY", "sk-xxx")
    QWEN\_MODEL = "qwen3-asr-flash-realtime"
    # 以下是北京地域baseUrl，如果使用新加坡地域的模型，需要将baseUrl替换为：wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime
    baseUrl = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime"
    url = f"{baseUrl}?model={QWEN\_MODEL}"
    print(f"Connecting to server: {url}")
    # 注意： 如果是非vad模式，建议持续发送的音频时长累加不超过60s
    enableServerVad = True
    is\_running = True  # 增加运行标志位
    headers = \[
        "Authorization: Bearer " + API\_KEY,
        "OpenAI-Beta: realtime=v1"
    ]
    def init\_logger():
        formatter = logging.Formatter('%(asctime)s|%(levelname)s|%(message)s')
        f\_handler = logging.handlers.RotatingFileHandler(
            "omni\_tester.log", maxBytes=100 \* 1024 \* 1024, backupCount=3
        )
        f\_handler.setLevel(logging.DEBUG)
        f\_handler.setFormatter(formatter)
        console = logging.StreamHandler()
        console.setLevel(logging.DEBUG)
        console.setFormatter(formatter)
        logger.addHandler(f\_handler)
        logger.addHandler(console)
    def on\_open(ws):
        logger.info("Connected to server.")
        # 会话更新事件
        event\_manual = {
            "event\_id": "event\_123",
            "type": "session.update",
            "session": {
                "modalities": \["text"],
                "input\_audio\_format": "pcm",
                "sample\_rate": 16000,
                "input\_audio\_transcription": {
                    # 语种标识，可选，如果有明确的语种信息，建议设置
                    "language": "zh"
                },
                "turn\_detection": None
            }
        }
        event\_vad = {
            "event\_id": "event\_123",
            "type": "session.update",
            "session": {
                "modalities": \["text"],
                "input\_audio\_format": "pcm",
                "sample\_rate": 16000,
                "input\_audio\_transcription": {
                    "language": "zh"
                },
                "turn\_detection": {
                    "type": "server\_vad",
                    "threshold": 0.0,
                    "silence\_duration\_ms": 400
                }
            }
        }
        if enableServerVad:
            logger.info(f"Sending event: {json.dumps(event\_vad, indent=2)}")
            ws.send(json.dumps(event\_vad))
        else:
            logger.info(f"Sending event: {json.dumps(event\_manual, indent=2)}")
            ws.send(json.dumps(event\_manual))
    def on\_message(ws, message):
        global is\_running
        try:
            data = json.loads(message)
            logger.info(f"Received event: {json.dumps(data, ensure\_ascii=False, indent=2)}")
            if data.get("type") == "session.finished":
                logger.info(f"Final transcript: {data.get('transcript')}")
                logger.info("Closing WebSocket connection after session finished...")
                is\_running = False  # 停止音频发送线程
                ws.close()
        except json.JSONDecodeError:
            logger.error(f"Failed to parse message: {message}")
    def on\_error(ws, error):
        logger.error(f"Error: {error}")
    def on\_close(ws, close\_status\_code, close\_msg):
        logger.info(f"Connection closed: {close\_status\_code} - {close\_msg}")
    def send\_audio(ws, local\_audio\_path):
        time.sleep(3)  # 等待会话更新完成
        global is\_running
        with open(local\_audio\_path, 'rb') as audio\_file:
            logger.info(f"文件读取开始: {datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')\[:-3]}")
            while is\_running:
                audio\_data = audio\_file.read(3200)  # \~0.1s PCM16/16kHz
                if not audio\_data:
                    logger.info(f"文件读取完毕: {datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')\[:-3]}")
                    if ws.sock and ws.sock.connected:
                        if not enableServerVad:
                            commit\_event = {
                                "event\_id": "event\_789",
                                "type": "input\_audio\_buffer.commit"
                            }
                            ws.send(json.dumps(commit\_event))
                        finish\_event = {
                            "event\_id": "event\_987",
                            "type": "session.finish"
                        }
                        ws.send(json.dumps(finish\_event))
                    break
                if not ws.sock or not ws.sock.connected:
                    logger.info("WebSocket已关闭，停止发送音频。")
                    break
                encoded\_data = base64.b64encode(audio\_data).decode('utf-8')
                eventd = {
                    "event\_id": f"event\_{int(time.time() \* 1000)}",
                    "type": "input\_audio\_buffer.append",
                    "audio": encoded\_data
                }
                ws.send(json.dumps(eventd))
                logger.info(f"Sending audio event: {eventd\['event\_id']}")
                time.sleep(0.1)  # 模拟实时采集
    # 初始化日志
    init\_logger()
    logger.info(f"Connecting to WebSocket server at {url}...")
    local\_audio\_path = "your\_audio\_file.pcm"
    ws = websocket.WebSocketApp(
        url,
        header=headers,
        on\_open=on\_open,
        on\_message=on\_message,
        on\_error=on\_error,
        on\_close=on\_close
    )
    thread = threading.Thread(target=send\_audio, args=(ws, local\_audio\_path))
    thread.start()
    ws.run\_forever()
    ```

    ## Java

    在运行示例前，请确保已安装Java-WebSocket依赖：

    ## Maven

    ```
    <dependency>
        <groupId>org.java-websocket</groupId>
        <artifactId>Java-WebSocket</artifactId>
        <version>1.5.6</version>
    </dependency>
    ```

    ## Gradle

    ```
    implementation 'org.java-websocket:Java-WebSocket:1.5.6'
    ```

    ```
    import org.java\_websocket.client.WebSocketClient;
    import org.java\_websocket.handshake.ServerHandshake;
    import org.json.JSONObject;
    import java.net.URI;
    import java.nio.file.Files;
    import java.nio.file.Paths;
    import java.util.Base64;
    import java.util.concurrent.atomic.AtomicBoolean;
    import java.util.logging.\*;
    public class QwenASRRealtimeClient {
        private static final Logger logger = Logger.getLogger(QwenASRRealtimeClient.class.getName());
        // 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
        // 若没有配置环境变量，请用百炼API Key将下行替换为：private static final String API\_KEY = "sk-xxx"
        private static final String API\_KEY = System.getenv().getOrDefault("DASHSCOPE\_API\_KEY", "sk-xxx");
        private static final String MODEL = "qwen3-asr-flash-realtime";
        // 控制是否使用 VAD 模式
        private static final boolean enableServerVad = true;
        private static final AtomicBoolean isRunning = new AtomicBoolean(true);
        private static WebSocketClient client;
        public static void main(String\[] args) throws Exception {
            initLogger();
            // 以下是北京地域baseUrl，如果使用新加坡地域的模型，需要将baseUrl替换为：wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime
            String baseUrl = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
            String url = baseUrl + "?model=" + MODEL;
            logger.info("Connecting to server: " + url);
            client = new WebSocketClient(new URI(url)) {
                @Override
                public void onOpen(ServerHandshake handshake) {
                    logger.info("Connected to server.");
                    sendSessionUpdate();
                }
                @Override
                public void onMessage(String message) {
                    try {
                        JSONObject data = new JSONObject(message);
                        String eventType = data.optString("type");
                        logger.info("Received event: " + data.toString(2));
                        // 收到结束事件 → 停止发送线程并关闭连接
                        if ("session.finished".equals(eventType)) {
                            logger.info("Final transcript: " + data.optString("transcript"));
                            logger.info("Closing WebSocket connection after session finished...");
                            isRunning.set(false); // 停止发送音频线程
                            if (this.isOpen()) {
                                this.close(1000, "ASR finished");
                            }
                        }
                    } catch (Exception e) {
                        logger.severe("Failed to parse message: " + message);
                    }
                }
                @Override
                public void onClose(int code, String reason, boolean remote) {
                    logger.info("Connection closed: " + code + " - " + reason);
                }
                @Override
                public void onError(Exception ex) {
                    logger.severe("Error: " + ex.getMessage());
                }
            };
            // 添加请求头
            client.addHeader("Authorization", "Bearer " + API\_KEY);
            client.addHeader("OpenAI-Beta", "realtime=v1");
            client.connectBlocking(); // 阻塞直到连接建立
            // 替换为待识别的音频文件路径
            String localAudioPath = "your\_audio\_file.pcm";
            Thread audioThread = new Thread(() -> {
                try {
                    sendAudio(localAudioPath);
                } catch (Exception e) {
                    logger.severe("Audio sending thread error: " + e.getMessage());
                }
            });
            audioThread.start();
        }
        /\*\* 会话更新事件（开启/关闭 VAD） \*/
        private static void sendSessionUpdate() {
            JSONObject eventNoVad = new JSONObject()
                    .put("event\_id", "event\_123")
                    .put("type", "session.update")
                    .put("session", new JSONObject()
                            .put("modalities", new String\[]{"text"})
                            .put("input\_audio\_format", "pcm")
                            .put("sample\_rate", 16000)
                            .put("input\_audio\_transcription", new JSONObject()
                                    .put("language", "zh"))
                            .put("turn\_detection", JSONObject.NULL) // 手动模式
                    );
            JSONObject eventVad = new JSONObject()
                    .put("event\_id", "event\_123")
                    .put("type", "session.update")
                    .put("session", new JSONObject()
                            .put("modalities", new String\[]{"text"})
                            .put("input\_audio\_format", "pcm")
                            .put("sample\_rate", 16000)
                            .put("input\_audio\_transcription", new JSONObject()
                                    .put("language", "zh"))
                            .put("turn\_detection", new JSONObject()
                                    .put("type", "server\_vad")
                                    .put("threshold", 0.0)
                                    .put("silence\_duration\_ms", 400))
                    );
            if (enableServerVad) {
                logger.info("Sending event (VAD):\\n" + eventVad.toString(2));
                client.send(eventVad.toString());
            } else {
                logger.info("Sending event (Manual):\\n" + eventNoVad.toString(2));
                client.send(eventNoVad.toString());
            }
        }
        /\*\* 发送音频文件流 \*/
        private static void sendAudio(String localAudioPath) throws Exception {
            Thread.sleep(3000); // 等会话准备
            byte\[] allBytes = Files.readAllBytes(Paths.get(localAudioPath));
            logger.info("文件读取开始");
            int offset = 0;
            while (isRunning.get() \&\& offset < allBytes.length) {
                int chunkSize = Math.min(3200, allBytes.length - offset);
                byte\[] chunk = new byte\[chunkSize];
                System.arraycopy(allBytes, offset, chunk, 0, chunkSize);
                offset += chunkSize;
                if (client != null \&\& client.isOpen()) {
                    String encoded = Base64.getEncoder().encodeToString(chunk);
                    JSONObject eventd = new JSONObject()
                            .put("event\_id", "event\_" + System.currentTimeMillis())
                            .put("type", "input\_audio\_buffer.append")
                            .put("audio", encoded);
                    client.send(eventd.toString());
                    logger.info("Sending audio event: " + eventd.getString("event\_id"));
                } else {
                    break; // 避免在断开后继续发送
                }
                Thread.sleep(100); // 模拟实时发送
            }
            logger.info("文件读取完毕");
            if (client != null \&\& client.isOpen()) {
                // 非 VAD 模式下需要 commit
                if (!enableServerVad) {
                    JSONObject commitEvent = new JSONObject()
                            .put("event\_id", "event\_789")
                            .put("type", "input\_audio\_buffer.commit");
                    client.send(commitEvent.toString());
                    logger.info("Sent commit event for manual mode.");
                }
                JSONObject finishEvent = new JSONObject()
                        .put("event\_id", "event\_987")
                        .put("type", "session.finish");
                client.send(finishEvent.toString());
                logger.info("Sent finish event.");
            }
        }
        /\*\* 初始化日志 \*/
        private static void initLogger() {
            logger.setLevel(Level.ALL);
            Logger rootLogger = Logger.getLogger("");
            for (Handler h : rootLogger.getHandlers()) {
                rootLogger.removeHandler(h);
            }
            Handler consoleHandler = new ConsoleHandler();
            consoleHandler.setLevel(Level.ALL);
            consoleHandler.setFormatter(new SimpleFormatter());
            logger.addHandler(consoleHandler);
        }
    }
    ```

    ## Node.js

    在运行示例前，请确保已使用以下命令安装依赖：

    ```
    npm install ws
    ```

    ```
    /\*\*
     \* Qwen-ASR Realtime WebSocket 客户端（Node.js版）
     \* 功能：
     \* - 支持 VAD 模式和 Manual 模式
     \* - 发送 session.update 启动会话
     \* - 持续发送音频块 input\_audio\_buffer.append
     \* - 如果是Manual模式，需要发送 input\_audio\_buffer.commit
     \* - 发送session.finish事件
     \* - 收到 session.finished 事件后关闭连接
     \*/
    import WebSocket from 'ws';
    import fs from 'fs';
    // ===== 配置 =====
    // 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
    // 若没有配置环境变量，请用百炼API Key将下行替换为：const API\_KEY = "sk-xxx"
    const API\_KEY = process.env.DASHSCOPE\_API\_KEY || 'sk-xxx';
    const MODEL = 'qwen3-asr-flash-realtime';
    const enableServerVad = true; // true为VAD模式，false为Manual模式
    const localAudioPath = 'your\_audio\_file.pcm'; // PCM16、16kHz音频文件路径
    // 以下是北京地域baseUrl，如果使用新加坡地域的模型，需要将baseUrl替换为：wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime
    const baseUrl = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
    const url = `${baseUrl}?model=${MODEL}`;
    console.log(`Connecting to server: ${url}`);
    // ===== 状态控制 =====
    let isRunning = true;
    // ===== 建立连接 =====
    const ws = new WebSocket(url, {
        headers: {
            'Authorization': `Bearer ${API\_KEY}`,
            'OpenAI-Beta': 'realtime=v1'
        }
    });
    // ===== 事件绑定 =====
    ws.on('open', () => {
        console.log('\[WebSocket] Connected to server.');
        sendSessionUpdate();
        // 启动音频发送线程
        sendAudio(localAudioPath);
    });
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log('\[Received Event]:', JSON.stringify(data, null, 2));
            // 收到结束事件
            if (data.type === 'session.finished') {
                console.log(`\[Final Transcript] ${data.transcript}`);
                console.log('\[Action] Closing WebSocket connection after session finished...');
                if (ws.readyState === WebSocket.OPEN) {
                    ws.close(1000, 'ASR finished');
                }
            }
        } catch (e) {
            console.error('\[Error] Failed to parse message:', message);
        }
    });
    ws.on('close', (code, reason) => {
        console.log(`\[WebSocket] Connection closed: ${code} - ${reason}`);
    });
    ws.on('error', (err) => {
        console.error('\[WebSocket Error]', err);
    });
    // ===== 会话更新 =====
    function sendSessionUpdate() {
        const eventNoVad = {
            event\_id: 'event\_123',
            type: 'session.update',
            session: {
                modalities: \['text'],
                input\_audio\_format: 'pcm',
                sample\_rate: 16000,
                input\_audio\_transcription: {
                    language: 'zh'
                },
                turn\_detection: null
            }
        };
        const eventVad = {
            event\_id: 'event\_123',
            type: 'session.update',
            session: {
                modalities: \['text'],
                input\_audio\_format: 'pcm',
                sample\_rate: 16000,
                input\_audio\_transcription: {
                    language: 'zh'
                },
                turn\_detection: {
                    type: 'server\_vad',
                    threshold: 0.0,
                    silence\_duration\_ms: 400
                }
            }
        };
        if (enableServerVad) {
            console.log('\[Send Event] VAD Mode:\\n', JSON.stringify(eventVad, null, 2));
            ws.send(JSON.stringify(eventVad));
        } else {
            console.log('\[Send Event] Manual Mode:\\n', JSON.stringify(eventNoVad, null, 2));
            ws.send(JSON.stringify(eventNoVad));
        }
    }
    // ===== 发送音频文件流 =====
    function sendAudio(audioPath) {
        setTimeout(() => {
            console.log(`\[File Read Start] ${audioPath}`);
            const buffer = fs.readFileSync(audioPath);
            let offset = 0;
            const chunkSize = 3200; // 约0.1s的PCM16音频
            function sendChunk() {
                if (!isRunning) return;
                if (offset >= buffer.length) {
                    isRunning = false; // 停止发送音频
                    console.log('\[File Read End]');
                    if (ws.readyState === WebSocket.OPEN) {
                        if (!enableServerVad) {
                            const commitEvent = {
                                event\_id: 'event\_789',
                                type: 'input\_audio\_buffer.commit'
                            };
                            ws.send(JSON.stringify(commitEvent));
                            console.log('\[Send Commit Event]');
                        }
                        const finishEvent = {
                            event\_id: 'event\_987',
                            type: 'session.finish'
                        };
                        ws.send(JSON.stringify(finishEvent));
                        console.log('\[Send Finish Event]');
                    }
                    return;
                }
                if (ws.readyState !== WebSocket.OPEN) {
                    console.log('\[Stop] WebSocket is not open.');
                    return;
                }
                const chunk = buffer.slice(offset, offset + chunkSize);
                offset += chunkSize;
                const encoded = chunk.toString('base64');
                const appendEvent = {
                    event\_id: `event\_${Date.now()}`,
                    type: 'input\_audio\_buffer.append',
                    audio: encoded
                };
                ws.send(JSON.stringify(appendEvent));
                console.log(`\[Send Audio Event] ${appendEvent.event\_id}`);
                setTimeout(sendChunk, 100); // 模拟实时发送
            }
            sendChunk();
        }, 3000); // 等待会话配置完成
    }
    ```

---
*← 返回 [README](./README.md)*
