> 来源：`实时(Qwen-Omni-Realtime).md`
\## WebSocket（Python）
\-   \*\*准备运行环境\*\*
    您的 Python 版本需要不低于 3.10。
    首先根据您的操作系统来安装 pyaudio。

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

    > 推荐使用`pip install pyaudio`。如果安装失败，请先根据您的操作系统安装`portaudio`依赖。

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
    pip install websockets==15.0.1
    ```

\-   \*\*创建客户端\*\*
    在本地新建一个 python 文件，命名为`omni\_realtime\_client.py`，并将以下代码复制进文件中：
    omni\\\_realtime\\\_client.py

    ```
    import asyncio
    import websockets
    import json
    import base64
    import time
    from typing import Optional, Callable, List, Dict, Any
    from enum import Enum
    class TurnDetectionMode(Enum):
        SERVER\_VAD = "server\_vad"
        SEMANTIC\_VAD = "semantic\_vad"  # 使用qwen3.5-omni-realtime模型时推荐
        MANUAL = "manual"
    class OmniRealtimeClient:
        def \_\_init\_\_(
                self,
                base\_url,
                api\_key: str,
                model: str = "",
                voice: str = "Ethan",
                instructions: str = "You are a helpful assistant.",
                turn\_detection\_mode: TurnDetectionMode = TurnDetectionMode.SERVER\_VAD,
                on\_text\_delta: Optional\[Callable\[\[str], None]] = None,
                on\_audio\_delta: Optional\[Callable\[\[bytes], None]] = None,
                on\_input\_transcript: Optional\[Callable\[\[str], None]] = None,
                on\_output\_transcript: Optional\[Callable\[\[str], None]] = None,
                extra\_event\_handlers: Optional\[Dict\[str, Callable\[\[Dict\[str, Any]], None]]] = None
        ):
            self.base\_url = base\_url
            self.api\_key = api\_key
            self.model = model
            self.voice = voice
            self.instructions = instructions
            self.ws = None
            self.on\_text\_delta = on\_text\_delta
            self.on\_audio\_delta = on\_audio\_delta
            self.on\_input\_transcript = on\_input\_transcript
            self.on\_output\_transcript = on\_output\_transcript
            self.turn\_detection\_mode = turn\_detection\_mode
            self.extra\_event\_handlers = extra\_event\_handlers or {}
            # 当前回复状态
            self.\_current\_response\_id = None
            self.\_current\_item\_id = None
            self.\_is\_responding = False
            # 输入/输出转录打印状态
            self.\_print\_input\_transcript = True
            self.\_output\_transcript\_buffer = ""
        async def connect(self) -> None:
            """与 Realtime API 建立 WebSocket 连接。"""
            url = f"{self.base\_url}?model={self.model}"
            headers = {
                "Authorization": f"Bearer {self.api\_key}"
            }
            self.ws = await websockets.connect(url, additional\_headers=headers)
            # 会话配置
            session\_config = {
                "modalities": \["text", "audio"],
                "voice": self.voice,
                "instructions": self.instructions,
                "input\_audio\_format": "pcm",
                "output\_audio\_format": "pcm",
                "input\_audio\_transcription": {
                    "model": "qwen3-asr-flash-realtime"
                }
            }
            if self.turn\_detection\_mode == TurnDetectionMode.MANUAL:
                session\_config\['turn\_detection'] = None
                await self.update\_session(session\_config)
            elif self.turn\_detection\_mode == TurnDetectionMode.SERVER\_VAD:
                session\_config\['turn\_detection'] = {
                    "type": "server\_vad",
                    "threshold": 0.1,
                    "prefix\_padding\_ms": 500,
                    "silence\_duration\_ms": 900
                }
                await self.update\_session(session\_config)
            elif self.turn\_detection\_mode == TurnDetectionMode.SEMANTIC\_VAD:
                session\_config\['turn\_detection'] = {
                    "type": "semantic\_vad",
                    "threshold": 0.1,
                    "prefix\_padding\_ms": 500,
                    "silence\_duration\_ms": 900
                }
                await self.update\_session(session\_config)
            else:
                raise ValueError(f"Invalid turn detection mode: {self.turn\_detection\_mode}")
        async def send\_event(self, event) -> None:
            event\['event\_id'] = "event\_" + str(int(time.time() \* 1000))
            await self.ws.send(json.dumps(event))
        async def update\_session(self, config: Dict\[str, Any]) -> None:
            """更新会话配置。"""
            event = {
                "type": "session.update",
                "session": config
            }
            await self.send\_event(event)
        async def stream\_audio(self, audio\_chunk: bytes) -> None:
            """向 API 流式发送原始音频数据。"""
            # 仅支持 16bit 16kHz 单声道 PCM
            audio\_b64 = base64.b64encode(audio\_chunk).decode()
            append\_event = {
                "type": "input\_audio\_buffer.append",
                "audio": audio\_b64
            }
            await self.send\_event(append\_event)
        async def commit\_audio\_buffer(self) -> None:
            """提交音频缓冲区以触发处理。"""
            event = {
                "type": "input\_audio\_buffer.commit"
            }
            await self.send\_event(event)
        async def append\_image(self, image\_chunk: bytes) -> None:
            """向图像缓冲区追加图像数据。
            图像数据可以来自本地文件，也可以来自实时视频流。
            注意:
                - 图像格式必须为 JPG 或 JPEG。推荐分辨率为 480P 或 720P，最高支持 1080P。
                - 单张图片大小不应超过 500KB。
                - 将图像数据编码为 Base64 后再发送。
                - 建议以 1张/秒 的频率向服务端发送图像。
                - 在发送图像数据之前，需要至少发送过一次音频数据。
            """
            image\_b64 = base64.b64encode(image\_chunk).decode()
            event = {
                "type": "input\_image\_buffer.append",
                "image": image\_b64
            }
            await self.send\_event(event)
        async def create\_response(self) -> None:
            """向 API 请求生成回复（仅在手动模式下需要调用）。"""
            event = {
                "type": "response.create"
            }
            await self.send\_event(event)
        async def cancel\_response(self) -> None:
            """取消当前回复。"""
            event = {
                "type": "response.cancel"
            }
            await self.send\_event(event)
        async def handle\_interruption(self):
            """处理用户对当前回复的打断。"""
            if not self.\_is\_responding:
                return
            # 1. 取消当前回复
            if self.\_current\_response\_id:
                await self.cancel\_response()
            self.\_is\_responding = False
            self.\_current\_response\_id = None
            self.\_current\_item\_id = None
        async def handle\_messages(self) -> None:
            try:
                async for message in self.ws:
                    event = json.loads(message)
                    event\_type = event.get("type")
                    if event\_type == "error":
                        print(" Error: ", event\['error'])
                        continue
                    elif event\_type == "response.created":
                        self.\_current\_response\_id = event.get("response", {}).get("id")
                        self.\_is\_responding = True
                    elif event\_type == "response.output\_item.added":
                        self.\_current\_item\_id = event.get("item", {}).get("id")
                    elif event\_type == "response.done":
                        self.\_is\_responding = False
                        self.\_current\_response\_id = None
                        self.\_current\_item\_id = None
                    elif event\_type == "input\_audio\_buffer.speech\_started":
                        print("检测到语音开始")
                        if self.\_is\_responding:
                            print("处理打断")
                            await self.handle\_interruption()
                    elif event\_type == "input\_audio\_buffer.speech\_stopped":
                        print("检测到语音结束")
                    elif event\_type == "response.text.delta":
                        if self.on\_text\_delta:
                            self.on\_text\_delta(event\["delta"])
                    elif event\_type == "response.audio.delta":
                        if self.on\_audio\_delta:
                            audio\_bytes = base64.b64decode(event\["delta"])
                            self.on\_audio\_delta(audio\_bytes)
                    elif event\_type == "conversation.item.input\_audio\_transcription.completed":
                        transcript = event.get("transcript", "")
                        print(f"用户: {transcript}")
                        if self.on\_input\_transcript:
                            await asyncio.to\_thread(self.on\_input\_transcript, transcript)
                            self.\_print\_input\_transcript = True
                    elif event\_type == "response.audio\_transcript.delta":
                        if self.on\_output\_transcript:
                            delta = event.get("delta", "")
                            if not self.\_print\_input\_transcript:
                                self.\_output\_transcript\_buffer += delta
                            else:
                                if self.\_output\_transcript\_buffer:
                                    await asyncio.to\_thread(self.on\_output\_transcript, self.\_output\_transcript\_buffer)
                                    self.\_output\_transcript\_buffer = ""
                                await asyncio.to\_thread(self.on\_output\_transcript, delta)
                    elif event\_type == "response.audio\_transcript.done":
                        print(f"大模型: {event.get('transcript', '')}")
                        self.\_print\_input\_transcript = False
                    elif event\_type in self.extra\_event\_handlers:
                        self.extra\_event\_handlers\[event\_type](event)
            except websockets.exceptions.ConnectionClosed:
                print(" Connection closed")
            except Exception as e:
                print(" Error in message handling: ", str(e))
        async def close(self) -> None:
            """关闭 WebSocket 连接。"""
            if self.ws:
                await self.ws.close()
    ```

\-   \*\*选择交互模式\*\*
    -   VAD 模式（Voice Activity Detection，自动检测语音起止）
        Realtime API 自动判断用户何时开始与停止说话并作出回应。
    -   Manual 模式（按下即说，松开即发送）
        客户端控制语音起止。用户说话结束后，客户端需主动发送消息至服务端。

    ## VAD 模式

    在`omni\_realtime\_client.py`的同级目录下新建另一个 python 文件，命名为`vad\_mode.py`，并将以下代码复制进文件中：
    vad\\\_mode.py

    ```
    # -- coding: utf-8 --
    import os, asyncio, pyaudio, queue, threading
    from omni\_realtime\_client import OmniRealtimeClient, TurnDetectionMode
    # 音频播放器类（处理中断）
    class AudioPlayer:
        def \_\_init\_\_(self, pyaudio\_instance, rate=24000):
            self.stream = pyaudio\_instance.open(format=pyaudio.paInt16, channels=1, rate=rate, output=True)
            self.queue = queue.Queue()
            self.stop\_evt = threading.Event()
            self.interrupt\_evt = threading.Event()
            threading.Thread(target=self.\_run, daemon=True).start()
        def \_run(self):
            while not self.stop\_evt.is\_set():
                try:
                    data = self.queue.get(timeout=0.5)
                    if data is None: break
                    if not self.interrupt\_evt.is\_set(): self.stream.write(data)
                    self.queue.task\_done()
                except queue.Empty: continue
        def add\_audio(self, data): self.queue.put(data)
        def handle\_interrupt(self): self.interrupt\_evt.set(); self.queue.queue.clear()
        def stop(self): self.stop\_evt.set(); self.queue.put(None); self.stream.stop\_stream(); self.stream.close()
    # 麦克风录音并发送
    async def record\_and\_send(client):
        p = pyaudio.PyAudio()
        stream = p.open(format=pyaudio.paInt16, channels=1, rate=16000, input=True, frames\_per\_buffer=3200)
        print("开始录音，请讲话...")
        try:
            while True:
                audio\_data = stream.read(3200)
                await client.stream\_audio(audio\_data)
                await asyncio.sleep(0.02)
        finally:
            stream.stop\_stream(); stream.close(); p.terminate()
    async def main():
        p = pyaudio.PyAudio()
        player = AudioPlayer(pyaudio\_instance=p)
        client = OmniRealtimeClient(
            # 以下是中国内地（北京）地域 base\_url，国际（新加坡）地域base\_url为wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime
            base\_url="wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
            api\_key=os.environ.get("DASHSCOPE\_API\_KEY"),
            model="qwen3.5-omni-plus-realtime",
            voice="Ethan",
            instructions="你是小云，风趣幽默的好助手",
            # 使用qwen3.5-omni-realtime模型时推荐设为SEMANTIC\_VAD
            turn\_detection\_mode=TurnDetectionMode.SEMANTIC\_VAD,
            on\_text\_delta=lambda t: print(f"\\nAssistant: {t}", end="", flush=True),
            on\_audio\_delta=player.add\_audio,
        )
        await client.connect()
        print("连接成功，开始实时对话...")
        # 并发运行
        await asyncio.gather(client.handle\_messages(), record\_and\_send(client))
    if \_\_name\_\_ == "\_\_main\_\_":
        try:
            asyncio.run(main())
        except KeyboardInterrupt:
            print("\\n程序已退出。")
    ```

    运行`vad\_mode.py`，通过麦克风即可与 Realtime 模型实时对话，系统会检测您的音频起始位置并自动发送到服务器，无需您手动发送。

    ## Manual 模式

    在`omni\_realtime\_client.py`的同级目录下新建另一个 python 文件，命名为`manual\_mode.py`，并将以下代码复制进文件中：
    manual\\\_mode.py

    ```
    # -- coding: utf-8 --
    import os
    import asyncio
    import time
    import threading
    import queue
    import pyaudio
    from omni\_realtime\_client import OmniRealtimeClient, TurnDetectionMode
    class AudioPlayer:
        """实时音频播放器类"""
        def \_\_init\_\_(self, sample\_rate=24000, channels=1, sample\_width=2):
            self.sample\_rate = sample\_rate
            self.channels = channels
            self.sample\_width = sample\_width  # 2 bytes for 16-bit
            self.audio\_queue = queue.Queue()
            self.is\_playing = False
            self.play\_thread = None
            self.pyaudio\_instance = None
            self.stream = None
            self.\_lock = threading.Lock()  # 添加锁来同步访问
            self.\_last\_data\_time = time.time()  # 记录最后接收数据的时间
            self.\_response\_done = False  # 添加响应完成标志
            self.\_waiting\_for\_response = False # 标记是否正在等待服务器响应
            # 记录最后一次向音频流写入数据的时间及最近一次音频块的时长，用于更精确地判断播放结束
            self.\_last\_play\_time = time.time()
            self.\_last\_chunk\_duration = 0.0
        def start(self):
            """启动音频播放器"""
            with self.\_lock:
                if self.is\_playing:
                    return
                self.is\_playing = True
                try:
                    self.pyaudio\_instance = pyaudio.PyAudio()
                    # 创建音频输出流
                    self.stream = self.pyaudio\_instance.open(
                        format=pyaudio.paInt16,  # 16-bit
                        channels=self.channels,
                        rate=self.sample\_rate,
                        output=True,
                        frames\_per\_buffer=1024
                    )
                    # 启动播放线程
                    self.play\_thread = threading.Thread(target=self.\_play\_audio)
                    self.play\_thread.daemon = True
                    self.play\_thread.start()
                    print("音频播放器已启动")
                except Exception as e:
                    print(f"启动音频播放器失败: {e}")
                    self.\_cleanup\_resources()
                    raise
        def stop(self):
            """停止音频播放器"""
            with self.\_lock:
                if not self.is\_playing:
                    return
                self.is\_playing = False
            # 清空队列
            while not self.audio\_queue.empty():
                try:
                    self.audio\_queue.get\_nowait()
                except queue.Empty:
                    break
            # 等待播放线程结束（在锁外面等待，避免死锁）
            if self.play\_thread and self.play\_thread.is\_alive():
                self.play\_thread.join(timeout=2.0)
            # 再次获取锁来清理资源
            with self.\_lock:
                self.\_cleanup\_resources()
            print("音频播放器已停止")
        def \_cleanup\_resources(self):
            """清理音频资源（必须在锁内调用）"""
            try:
                # 关闭音频流
                if self.stream:
                    if not self.stream.is\_stopped():
                        self.stream.stop\_stream()
                    self.stream.close()
                    self.stream = None
            except Exception as e:
                print(f"关闭音频流时出错: {e}")
            try:
                if self.pyaudio\_instance:
                    self.pyaudio\_instance.terminate()
                    self.pyaudio\_instance = None
            except Exception as e:
                print(f"终止PyAudio时出错: {e}")
        def add\_audio\_data(self, audio\_data):
            """添加音频数据到播放队列"""
            if self.is\_playing and audio\_data:
                self.audio\_queue.put(audio\_data)
                with self.\_lock:
                    self.\_last\_data\_time = time.time()  # 更新最后接收数据的时间
                    self.\_waiting\_for\_response = False # 收到数据，不再等待
        def stop\_receiving\_data(self):
            """标记不再接收新的音频数据"""
            with self.\_lock:
                self.\_response\_done = True
                self.\_waiting\_for\_response = False # 响应结束，不再等待
        def prepare\_for\_next\_turn(self):
            """为下一轮对话重置播放器状态。"""
            with self.\_lock:
                self.\_response\_done = False
                self.\_last\_data\_time = time.time()
                self.\_last\_play\_time = time.time()
                self.\_last\_chunk\_duration = 0.0
                self.\_waiting\_for\_response = True # 开始等待下一轮响应
            # 清空上一轮可能残留的音频数据
            while not self.audio\_queue.empty():
                try:
                    self.audio\_queue.get\_nowait()
                except queue.Empty:
                    break
        def is\_finished\_playing(self):
            """检查是否已经播放完所有音频数据"""
            with self.\_lock:
                queue\_size = self.audio\_queue.qsize()
                time\_since\_last\_data = time.time() - self.\_last\_data\_time
                time\_since\_last\_play = time.time() - self.\_last\_play\_time
                # ---------------------- 智能结束判定 ----------------------
                # 1. 首选：如果服务器已标记完成且播放队列为空
                #    进一步等待最近一块音频播放完毕（音频块时长 + 0.1s 容错）。
                if self.\_response\_done and queue\_size == 0:
                    min\_wait = max(self.\_last\_chunk\_duration + 0.1, 0.5)  # 至少等待 0.5s
                    if time\_since\_last\_play >= min\_wait:
                        return True
                # 2. 备用：如果长时间没有新数据且播放队列为空
                #    当服务器没有明确发出 `response.done` 时，此逻辑作为保障
                if not self.\_waiting\_for\_response and queue\_size == 0 and time\_since\_last\_data > 1.0:
                    print("\\n(超时未收到新音频，判定播放结束)")
                    return True
                return False
        def \_play\_audio(self):
            """播放音频数据的工作线程"""
            while True:
                # 检查是否应该停止
                with self.\_lock:
                    if not self.is\_playing:
                        break
                    stream\_ref = self.stream  # 获取流的引用
                try:
                    # 从队列中获取音频数据，超时0.1秒
                    audio\_data = self.audio\_queue.get(timeout=0.1)
                    # 再次检查状态和流的有效性
                    with self.\_lock:
                        if self.is\_playing and stream\_ref and not stream\_ref.is\_stopped():
                            try:
                                # 播放音频数据
                                stream\_ref.write(audio\_data)
                                # 更新最近播放信息
                                self.\_last\_play\_time = time.time()
                                self.\_last\_chunk\_duration = len(audio\_data) / (self.channels \* self.sample\_width) / self.sample\_rate
                            except Exception as e:
                                print(f"写入音频流时出错: {e}")
                                break
                    # 标记该数据块已处理完成
                    self.audio\_queue.task\_done()
                except queue.Empty:
                    # 队列为空时继续等待
                    continue
                except Exception as e:
                    print(f"播放音频时出错: {e}")
                    break
    class MicrophoneRecorder:
        """实时麦克风录音器"""
        def \_\_init\_\_(self, sample\_rate=16000, channels=1, chunk\_size=3200):
            self.sample\_rate = sample\_rate
            self.channels = channels
            self.chunk\_size = chunk\_size
            self.pyaudio\_instance = None
            self.stream = None
            self.frames = \[]
            self.\_is\_recording = False
            self.\_record\_thread = None
        def \_recording\_thread(self):
            """录音工作线程"""
            # 在 \_is\_recording 为 True 期间，持续从音频流中读取数据
            while self.\_is\_recording:
                try:
                    # 使用 exception\_on\_overflow=False 避免因缓冲区溢出而崩溃
                    data = self.stream.read(self.chunk\_size, exception\_on\_overflow=False)
                    self.frames.append(data)
                except (IOError, OSError) as e:
                    # 当流被关闭时，读取操作可能会引发错误
                    print(f"录音流读取错误，可能已关闭: {e}")
                    break
        def start(self):
            """开始录音"""
            if self.\_is\_recording:
                print("录音已在进行中。")
                return
            self.frames = \[]
            self.\_is\_recording = True
            try:
                self.pyaudio\_instance = pyaudio.PyAudio()
                self.stream = self.pyaudio\_instance.open(
                    format=pyaudio.paInt16,
                    channels=self.channels,
                    rate=self.sample\_rate,
                    input=True,
                    frames\_per\_buffer=self.chunk\_size
                )
                self.\_record\_thread = threading.Thread(target=self.\_recording\_thread)
                self.\_record\_thread.daemon = True
                self.\_record\_thread.start()
                print("麦克风录音已开始...")
            except Exception as e:
                print(f"启动麦克风失败: {e}")
                self.\_is\_recording = False
                self.\_cleanup()
                raise
        def stop(self):
            """停止录音并返回音频数据"""
            if not self.\_is\_recording:
                return None
            self.\_is\_recording = False
            # 等待录音线程安全退出
            if self.\_record\_thread:
                self.\_record\_thread.join(timeout=1.0)
            self.\_cleanup()
            print("麦克风录音已停止。")
            return b''.join(self.frames)
        def \_cleanup(self):
            """安全地清理 PyAudio 资源"""
            if self.stream:
                try:
                    if self.stream.is\_active():
                        self.stream.stop\_stream()
                    self.stream.close()
                except Exception as e:
                    print(f"关闭音频流时出错: {e}")
            if self.pyaudio\_instance:
                try:
                    self.pyaudio\_instance.terminate()
                except Exception as e:
                    print(f"终止 PyAudio 实例时出错: {e}")
            self.stream = None
            self.pyaudio\_instance = None
    async def interactive\_test():
        """
        交互式测试脚本：允许多轮连续对话，每轮可以发送音频和图片。
        """
        # ------------------- 1. 初始化和连接 (一次性) -------------------
        api\_key = os.environ.get("DASHSCOPE\_API\_KEY")
        if not api\_key:
            print("请设置DASHSCOPE\_API\_KEY环境变量")
            return
        print("--- 实时多轮音视频对话客户端 ---")
        print("正在初始化音频播放器和客户端...")
        audio\_player = AudioPlayer()
        audio\_player.start()
        def on\_audio\_received(audio\_data):
            audio\_player.add\_audio\_data(audio\_data)
        def on\_response\_done(event):
            print("\\n(收到响应结束标记)")
            audio\_player.stop\_receiving\_data()
        realtime\_client = OmniRealtimeClient(
            base\_url="wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
            api\_key=api\_key,
            model="qwen3.5-omni-plus-realtime",
            voice="Ethan",
            instructions="你是个人助理小云，请你准确且友好地解答用户的问题，始终以乐于助人的态度回应。", # 设定模型角色
            on\_text\_delta=lambda text: print(f"助手回复: {text}", end="", flush=True),
            on\_audio\_delta=on\_audio\_received,
            turn\_detection\_mode=TurnDetectionMode.MANUAL,
            extra\_event\_handlers={"response.done": on\_response\_done}
        )
        message\_handler\_task = None
        try:
            await realtime\_client.connect()
            print("已连接到服务器。输入 'q' 或 'quit' 可随时退出程序。")
            message\_handler\_task = asyncio.create\_task(realtime\_client.handle\_messages())
            await asyncio.sleep(0.5)
            turn\_counter = 1
            # ------------------- 2. 多轮对话循环 -------------------
            while True:
                print(f"\\n--- 第 {turn\_counter} 轮对话 ---")
                audio\_player.prepare\_for\_next\_turn()
                recorded\_audio = None
                image\_paths = \[]
                # --- 获取用户输入：从麦克风录音 ---
                loop = asyncio.get\_event\_loop()
                recorder = MicrophoneRecorder(sample\_rate=16000) # 推荐使用16k采样率进行语音识别
                print("准备录音。按 Enter 键开始录音 (或输入 'q' 退出)...")
                user\_input = await loop.run\_in\_executor(None, input)
                if user\_input.strip().lower() in \['q', 'quit']:
                    print("用户请求退出...")
                    return
                try:
                    recorder.start()
                except Exception:
                    print("无法启动录音，请检查您的麦克风权限和设备。跳过本轮。")
                    continue
                print("录音中... 再次按 Enter 键停止录音。")
                await loop.run\_in\_executor(None, input)
                recorded\_audio = recorder.stop()
                if not recorded\_audio or len(recorded\_audio) == 0:
                    print("未录制到有效音频，请重新开始本轮对话。")
                    continue
                # --- 获取图片输入 (可选) ---
                # 以下图片输入功能已被注释，暂时禁用。若需启用请取消下方代码注释。
                # print("\\n请逐行输入【图片文件】的绝对路径 (可选)。完成后，输入 's' 或按 Enter 发送请求。")
                # while True:
                #     path = input("图片路径: ").strip()
                #     if path.lower() == 's' or path == '':
                #         break
                #     if path.lower() in \['q', 'quit']:
                #         print("用户请求退出...")
                #         return
                #
                #     if not os.path.isabs(path):
                #         print("错误: 请输入绝对路径。")
                #         continue
                #     if not os.path.exists(path):
                #         print(f"错误: 文件不存在 -> {path}")
                #         continue
                #     image\_paths.append(path)
                #     print(f"已添加图片: {os.path.basename(path)}")
                # --- 3. 发送数据并获取响应 ---
                print("\\n--- 输入确认 ---")
                print(f"待处理音频: 1个 (来自麦克风), 图片: {len(image\_paths)}个")
                print("------------------")
                # 3.1 发送录制的音频
                try:
                    print(f"发送麦克风录音 ({len(recorded\_audio)}字节)")
                    await realtime\_client.stream\_audio(recorded\_audio)
                    await asyncio.sleep(0.1)
                except Exception as e:
                    print(f"发送麦克风录音失败: {e}")
                    continue
                # 3.2 发送所有图片文件
                # 以下图片发送代码已被注释，暂时禁用。
                # for i, path in enumerate(image\_paths):
                #     try:
                #         with open(path, "rb") as f:
                #             data = f.read()
                #         print(f"发送图片 {i+1}: {os.path.basename(path)} ({len(data)}字节)")
                #         await realtime\_client.append\_image(data)
                #         await asyncio.sleep(0.1)
                #     except Exception as e:
                #         print(f"发送图片 {os.path.basename(path)} 失败: {e}")
                # 3.3 提交并等待响应
                print("提交所有输入，请求服务器响应...")
                await realtime\_client.commit\_audio\_buffer()
                await realtime\_client.create\_response()
                print("等待并播放服务器响应音频...")
                start\_time = time.time()
                max\_wait\_time = 60
                while not audio\_player.is\_finished\_playing():
                    if time.time() - start\_time > max\_wait\_time:
                        print(f"\\n等待超时 ({max\_wait\_time}秒), 进入下一轮。")
                        break
                    await asyncio.sleep(0.2)
                print("\\n本轮音频播放完成！")
                turn\_counter += 1
        except (asyncio.CancelledError, KeyboardInterrupt):
            print("\\n程序被中断。")
        except Exception as e:
            print(f"发生未处理的错误: {e}")
        finally:
            # ------------------- 4. 清理资源 -------------------
            print("\\n正在关闭连接并清理资源...")
            if message\_handler\_task and not message\_handler\_task.done():
                message\_handler\_task.cancel()
            if 'realtime\_client' in locals() and realtime\_client.ws and not realtime\_client.ws.close:
                await realtime\_client.close()
                print("连接已关闭。")
            audio\_player.stop()
            print("程序退出。")
    if \_\_name\_\_ == "\_\_main\_\_":
        try:
            asyncio.run(interactive\_test())
        except KeyboardInterrupt:
            print("\\n程序被用户强制退出。")
    ```

    运行`manual\_mode.py`，按 Enter 键开始说话，再按一次获取模型响应的音频。
\## WebSocket（Python）
在 `session.update` 的 JSON 中添加 `enable\_search` 和 `search\_options` 字段：

```
import json
import os
import websocket
import base64
import pyaudio
import threading
API\_KEY = os.getenv("DASHSCOPE\_API\_KEY")
API\_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3.5-omni-plus-realtime"
pya = pyaudio.PyAudio()
out\_stream = pya.open(format=pyaudio.paInt16, channels=1, rate=24000, output=True)
def on\_open(ws):
    ws.send(json.dumps({
        "type": "session.update",
        "session": {
            "modalities": \["text", "audio"],
            "voice": "Tina",
            "instructions": "你是个人助理小云",
            "input\_audio\_format": "pcm",
            "output\_audio\_format": "pcm",
            "enable\_search": True,
            "search\_options": {
                "enable\_source": True
            }
        }
    }))
    print("联网搜索已启用，对着麦克风说话...")
    def send\_audio():
        mic = pya.open(format=pyaudio.paInt16, channels=1, rate=16000, input=True)
        try:
            while True:
                audio = mic.read(3200, exception\_on\_overflow=False)
                ws.send(json.dumps({
                    "type": "input\_audio\_buffer.append",
                    "audio": base64.b64encode(audio).decode()
                }))
        except Exception:
            mic.close()
    threading.Thread(target=send\_audio, daemon=True).start()
def on\_message(ws, message):
    event = json.loads(message)
    if event\["type"] == "response.audio.delta":
        out\_stream.write(base64.b64decode(event\["delta"]))
    elif event\["type"] == "response.audio\_transcript.done":
        print(f"\[LLM] {event\['transcript']}")
    elif event\["type"] == "response.done":
        usage = event.get("response", {}).get("usage", {})
        plugins = usage.get("plugins", {})
        if plugins.get("search"):
            print(f"\[Search] count={plugins\['search']\['count']}, strategy={plugins\['search']\['strategy']}")
def on\_error(ws, error):
    print(f"Error: {error}")
headers = \["Authorization: Bearer " + API\_KEY]
ws = websocket.WebSocketApp(API\_URL, header=headers, on\_open=on\_open, on\_message=on\_message, on\_error=on\_error)
ws.run\_forever()
```

\## \*\*API 参考\*\*
\-   \[客户端事件](https://help.aliyun.com/zh/model-studio/client-events)
\-   \[服务端事件](https://help.aliyun.com/zh/model-studio/server-events)
\## \*\*计费与限流\*\*
\### \*\*计费规则\*\*
Qwen-Omni-Realtime 模型根据不同模态（音频、图像）对应的Token数计费。计费详情请参见百炼控制台。
\*\*音频、图片转换为Token数的规则\*\*
\## 音频
\-   `Qwen3.5-Omni-Realtime：`
    -   输入音频计算公式：`总 Token 数 = 音频时长（单位：秒）\* 7`
    -   输出音频计算公式：`总 Tokens 数 = 音频时长（单位：秒）\* 12.5`
\-   `Qwen3-Omni-Flash-Realtime：`输入与输出音频的计算公式均为`总 Token 数 = 音频时长（单位：秒）\* 12.5`
\-   `Qwen-Omni-Turbo-Realtime：`输入与输出音频的计算公式均为`总 Token 数 = 音频时长（单位：秒）\* 25`
    若音频时长不足1秒，则按 1 秒计算。
---
*← 返回 [README](./README.md)*
