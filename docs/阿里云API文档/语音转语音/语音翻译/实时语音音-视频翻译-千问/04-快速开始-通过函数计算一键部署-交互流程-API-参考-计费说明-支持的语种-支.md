> 来源：`实时语音音-视频翻译-千问.md`
\## \*\*快速开始\*\*
1\.  \*\*准备运行环境\*\*
    您的 Python 版本需要不低于 3.10。
    首先安装 pyaudio。

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

2\.  \*\*创建客户端\*\*
    在本地新建一个 Python 文件，命名为`livetranslate\_client.py`，并将以下代码复制进文件中：
    客户端代码-livetranslate\\\_client.py

    ```
    import os
    import time
    import base64
    import asyncio
    import json
    import websockets
    import pyaudio
    import queue
    import threading
    import traceback
    class LiveTranslateClient:
        def \_\_init\_\_(self, api\_key: str, target\_language: str = "en", voice: str | None = "Cherry", \*, audio\_enabled: bool = True):
            if not api\_key:
                raise ValueError("API key cannot be empty.")
            self.api\_key = api\_key
            self.target\_language = target\_language
            self.audio\_enabled = audio\_enabled
            self.voice = voice if audio\_enabled else "Cherry"
            self.ws = None
            self.api\_url = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-livetranslate-flash-realtime"
            # 音频输入配置 (来自麦克风)
            self.input\_rate = 16000
            self.input\_chunk = 1600
            self.input\_format = pyaudio.paInt16
            self.input\_channels = 1
            # 音频输出配置 (用于播放)
            self.output\_rate = 24000
            self.output\_chunk = 2400
            self.output\_format = pyaudio.paInt16
            self.output\_channels = 1
            # 状态管理
            self.is\_connected = False
            self.audio\_player\_thread = None
            self.audio\_playback\_queue = queue.Queue()
            self.pyaudio\_instance = pyaudio.PyAudio()
        async def connect(self):
            """建立到翻译服务的 WebSocket 连接。"""
            headers = {"Authorization": f"Bearer {self.api\_key}"}
            try:
                self.ws = await websockets.connect(self.api\_url, additional\_headers=headers)
                self.is\_connected = True
                print(f"成功连接到服务端: {self.api\_url}")
                await self.configure\_session()
            except Exception as e:
                print(f"连接失败: {e}")
                self.is\_connected = False
                raise
        async def configure\_session(self):
            """配置翻译会话，设置目标语言、声音等。"""
            config = {
                "event\_id": f"event\_{int(time.time() \* 1000)}",
                "type": "session.update",
                "session": {
                    # 'modalities' 控制输出类型。
                    # \["text", "audio"]: 同时返回翻译文本和合成音频（推荐）。
                    # \["text"]: 仅返回翻译文本。
                    "modalities": \["text", "audio"] if self.audio\_enabled else \["text"],
                    \*\*({"voice": self.voice} if self.audio\_enabled and self.voice else {}),
                    "input\_audio\_format": "pcm",
                    "output\_audio\_format": "pcm",
                    # 'input\_audio\_transcription' 配置源语言识别。
                    # 设置 'model' 为 'qwen3-asr-flash-realtime' 可同时输出源语言识别结果。
                    # "input\_audio\_transcription": {
                    #     "model": "qwen3-asr-flash-realtime",
                    #     "language": "zh"  # 源语言，默认 'en'
                    # },
                    "translation": {
                        "language": self.target\_language,
                        # 'corpus' 配置热词，用于提升特定词汇的翻译准确性。
                        # "corpus": {
                        #     "phrases": {
                        #         "人工智能": "Artificial Intelligence",
                        #         "机器学习": "Machine Learning"
                        #     }
                        # }
                    }
                }
            }
            print(f"发送会话配置: {json.dumps(config, indent=2, ensure\_ascii=False)}")
            await self.ws.send(json.dumps(config))
        async def send\_audio\_chunk(self, audio\_data: bytes):
            """将音频数据块编码并发送到服务端。"""
            if not self.is\_connected:
                return
            event = {
                "event\_id": f"event\_{int(time.time() \* 1000)}",
                "type": "input\_audio\_buffer.append",
                "audio": base64.b64encode(audio\_data).decode()
            }
            await self.ws.send(json.dumps(event))
        async def send\_image\_frame(self, image\_bytes: bytes, \*, event\_id: str | None = None):
            #将图像数据发送到服务端
            if not self.is\_connected:
                return
            if not image\_bytes:
                raise ValueError("image\_bytes 不能为空")
            # 编码为 Base64
            image\_b64 = base64.b64encode(image\_bytes).decode()
            event = {
                "event\_id": event\_id or f"event\_{int(time.time() \* 1000)}",
                "type": "input\_image\_buffer.append",
                "image": image\_b64,
            }
            await self.ws.send(json.dumps(event))
        def \_audio\_player\_task(self):
            stream = self.pyaudio\_instance.open(
                format=self.output\_format,
                channels=self.output\_channels,
                rate=self.output\_rate,
                output=True,
                frames\_per\_buffer=self.output\_chunk,
            )
            try:
                while self.is\_connected or not self.audio\_playback\_queue.empty():
                    try:
                        audio\_chunk = self.audio\_playback\_queue.get(timeout=0.1)
                        if audio\_chunk is None: # 结束信号
                            break
                        stream.write(audio\_chunk)
                        self.audio\_playback\_queue.task\_done()
                    except queue.Empty:
                        continue
            finally:
                stream.stop\_stream()
                stream.close()
        def start\_audio\_player(self):
            """启动音频播放线程（仅当启用音频输出时）。"""
            if not self.audio\_enabled:
                return
            if self.audio\_player\_thread is None or not self.audio\_player\_thread.is\_alive():
                self.audio\_player\_thread = threading.Thread(target=self.\_audio\_player\_task, daemon=True)
                self.audio\_player\_thread.start()
        async def handle\_server\_messages(self, on\_text\_received):
            """循环处理来自服务端的消息。"""
            try:
                async for message in self.ws:
                    event = json.loads(message)
                    event\_type = event.get("type")
                    if event\_type == "response.audio.delta" and self.audio\_enabled:
                        audio\_b64 = event.get("delta", "")
                        if audio\_b64:
                            audio\_data = base64.b64decode(audio\_b64)
                            self.audio\_playback\_queue.put(audio\_data)
                    elif event\_type == "response.done":
                        print("\\n\[INFO] 一轮响应完成。")
                        usage = event.get("response", {}).get("usage", {})
                        if usage:
                            print(f"\[INFO] Token 使用情况: {json.dumps(usage, indent=2, ensure\_ascii=False)}")
                    # 处理源语言识别结果（需启用 input\_audio\_transcription.model）
                    # elif event\_type == "conversation.item.input\_audio\_transcription.text":
                    #     stash = event.get("stash", "")  # 待确认的识别文本
                    #     print(f"\[识别中] {stash}")
                    # elif event\_type == "conversation.item.input\_audio\_transcription.completed":
                    #     transcript = event.get("transcript", "")  # 完整识别结果
                    #     print(f"\[源语言] {transcript}")
                    elif event\_type == "response.audio\_transcript.done":
                        print("\\n\[INFO] 翻译文本完成。")
                        text = event.get("transcript", "")
                        if text:
                            print(f"\[INFO] 翻译文本: {text}")
                    elif event\_type == "response.text.done":
                        print("\\n\[INFO] 翻译文本完成。")
                        text = event.get("text", "")
                        if text:
                            print(f"\[INFO] 翻译文本: {text}")
            except websockets.exceptions.ConnectionClosed as e:
                print(f"\[WARNING] 连接已关闭: {e}")
                self.is\_connected = False
            except Exception as e:
                print(f"\[ERROR] 消息处理时发生未知错误: {e}")
                traceback.print\_exc()
                self.is\_connected = False
        async def start\_microphone\_streaming(self):
            """从麦克风捕获音频并流式传输到服务端。"""
            stream = self.pyaudio\_instance.open(
                format=self.input\_format,
                channels=self.input\_channels,
                rate=self.input\_rate,
                input=True,
                frames\_per\_buffer=self.input\_chunk
            )
            print("麦克风已启动，请开始说话...")
            try:
                while self.is\_connected:
                    audio\_chunk = await asyncio.get\_event\_loop().run\_in\_executor(
                        None, stream.read, self.input\_chunk
                    )
                    await self.send\_audio\_chunk(audio\_chunk)
            finally:
                stream.stop\_stream()
                stream.close()
        async def close(self):
            """优雅地关闭连接和资源。"""
            self.is\_connected = False
            if self.ws:
                await self.ws.close()
                print("WebSocket 连接已关闭。")
            if self.audio\_player\_thread:
                self.audio\_playback\_queue.put(None) # 发送结束信号
                self.audio\_player\_thread.join(timeout=1)
                print("音频播放线程已停止。")
            self.pyaudio\_instance.terminate()
            print("PyAudio 实例已释放。")
    ```

3\.  \*\*与模型互动\*\*
    在`livetranslate\_client.py`的同级目录下新建另一个 Python 文件，命名为`main.py`，并将以下代码复制进文件中：
    \*\*main.py\*\*

    ```
    import os
    import asyncio
    from livetranslate\_client import LiveTranslateClient
    def print\_banner():
        print("=" \* 60)
        print("  基于千问 qwen3-livetranslate-flash-realtime")
        print("=" \* 60 + "\\n")
    def get\_user\_config():
        """获取用户配置"""
        print("请选择模式:")
        print("1. 语音+文本 \[默认] | 2. 仅文本")
        mode\_choice = input("请输入选项 (直接回车选择语音+文本): ").strip()
        audio\_enabled = (mode\_choice != "2")
        if audio\_enabled:
            lang\_map = {
                "1": "en", "2": "zh", "3": "ru", "4": "fr", "5": "de", "6": "pt",
                "7": "es", "8": "it", "9": "ko", "10": "ja", "11": "yue"
            }
            print("请选择翻译目标语言 (音频+文本 模式):")
            print("1. 英语 | 2. 中文 | 3. 俄语 | 4. 法语 | 5. 德语 | 6. 葡萄牙语 | 7. 西班牙语 | 8. 意大利语 | 9. 韩语 | 10. 日语 | 11. 粤语")
        else:
            lang\_map = {
                "1": "en", "2": "zh", "3": "ru", "4": "fr", "5": "de", "6": "pt", "7": "es", "8": "it",
                "9": "id", "10": "ko", "11": "ja", "12": "vi", "13": "th", "14": "ar",
                "15": "yue", "16": "hi", "17": "el", "18": "tr"
            }
            print("请选择翻译目标语言 (仅文本 模式):")
            print("1. 英语 | 2. 中文 | 3. 俄语 | 4. 法语 | 5. 德语 | 6. 葡萄牙语 | 7. 西班牙语 | 8. 意大利语 | 9. 印尼语 | 10. 韩语 | 11. 日语 | 12. 越南语 | 13. 泰语 | 14. 阿拉伯语 | 15. 粤语 | 16. 印地语 | 17. 希腊语 | 18. 土耳其语")
        choice = input("请输入选项 (默认取第一个): ").strip()
        target\_language = lang\_map.get(choice, next(iter(lang\_map.values())))
        voice = None
        if audio\_enabled:
            print("\\n请选择语音合成声音:")
            voice\_map = {"1": "Cherry", "2": "Nofish", "3": "Sunny", "4": "Jada", "5": "Dylan", "6": "Peter", "7": "Eric", "8": "Kiki"}
            print("1. Cherry (女声) \[默认] | 2. Nofish (男声) | 3. 晴儿 Sunny (四川女声) | 4. 阿珍 Jada (上海女声) | 5. 晓东 Dylan (北京男声) | 6. 李彼得 Peter (天津男声) | 7. 程川 Eric (四川男声) | 8. 阿清 Kiki (粤语女声)")
            voice\_choice = input("请输入选项 (直接回车选择Cherry): ").strip()
            voice = voice\_map.get(voice\_choice, "Cherry")
        return target\_language, voice, audio\_enabled
    async def main():
        """主程序入口"""
        print\_banner()
        api\_key = os.environ.get("DASHSCOPE\_API\_KEY")
        if not api\_key:
            print("\[ERROR] 请设置环境变量 DASHSCOPE\_API\_KEY")
            print("  例如: export DASHSCOPE\_API\_KEY='your\_api\_key\_here'")
            return
        target\_language, voice, audio\_enabled = get\_user\_config()
        print("\\n配置完成:")
        print(f"  - 目标语言: {target\_language}")
        if audio\_enabled:
            print(f"  - 合成声音: {voice}")
        else:
            print("  - 输出模式: 仅文本")
        client = LiveTranslateClient(api\_key=api\_key, target\_language=target\_language, voice=voice, audio\_enabled=audio\_enabled)
        # 定义回调函数
        def on\_translation\_text(text):
            print(text, end="", flush=True)
        try:
            print("正在连接到翻译服务...")
            await client.connect()
            # 根据模式启动音频播放
            client.start\_audio\_player()
            print("\\n" + "-" \* 60)
            print("连接成功！请对着麦克风说话。")
            print("程序将实时翻译您的语音并播放结果。按 Ctrl+c 退出。")
            print("-" \* 60 + "\\n")
            # 并发运行消息处理和麦克风录音
            message\_handler = asyncio.create\_task(client.handle\_server\_messages(on\_translation\_text))
            tasks = \[message\_handler]
            # 无论是否启用音频输出，都需要从麦克风捕获音频进行翻译
            microphone\_streamer = asyncio.create\_task(client.start\_microphone\_streaming())
            tasks.append(microphone\_streamer)
            await asyncio.gather(\*tasks)
        except KeyboardInterrupt:
            print("\\n\\n用户中断，正在退出...")
        except Exception as e:
            print(f"\\n发生严重错误: {e}")
        finally:
            print("\\n正在清理资源...")
            await client.close()
            print("程序已退出。")
    if \_\_name\_\_ == "\_\_main\_\_":
        asyncio.run(main())
    ```

    运行`main.py`，通过麦克风说出要翻译的句子，模型会实时返回翻译完成的音频与文本。系统会检测您的音频起始位置并自动发送到服务端，无需手动发送。
\## \*\*通过函数计算一键部署\*\*
控制台暂不支持体验。可通过以下方式一键部署：
1\.  打开我们写好的\[函数计算模板](https://fcnext.console.aliyun.com/applications/create?template=qwen-livetranslate-flash-realtime@0.0.1)，填入 API Key， 单击\*\*创建并部署默认环境\*\*即可在线体验。
2\.  等待约一分钟，在 \*\*环境详情 > 环境信息\*\* 中获取访问域名，\*\*将访问域名的\*\*`\*\*http\*\*`\*\*改成\*\*`\*\*https\*\*`（例如https://qwen-livetranslate-flash-realtime.fcv3.xxx.cn-hangzhou.fc.devsapp.net/），通过该链接与模型交互。
    \*\*重要\*\*
    此链接使用自签名证书，仅用于临时测试。首次访问时，浏览器会显示安全警告，这是预期行为，\*\*请勿在生产环境使用\*\*。如需继续，请按浏览器提示操作（如点击“高级” → “继续前往（不安全）”）。
> 如需开通访问控制权限，请跟随页面指引操作。
> 通过\*\*资源信息\*\*\\-\*\*函数资源\*\*查看项目源代码。
> \[函数计算](https://help.aliyun.com/zh/functioncompute/fc/product-overview/trial-quota-1)与\[阿里云百炼](https://help.aliyun.com/zh/model-studio/new-free-quota)均为新用户提供免费额度，可以覆盖简单调试所需成本，额度耗尽后按量计费。只有在访问的情况下会产生费用。
\## \*\*交互流程\*\*
实时语音翻译的交互流程遵循标准的 WebSocket 事件驱动模型，服务端自动检测语音起止并进行响应。

| \*\*生命周期\*\* | \*\*客户端事件\*\* | \*\*服务端事件\*\* |
| --- | --- | --- |
| 会话初始化 | session.update > 会话配置 | session.created > 会话已创建 session.updated > 会话配置已更新 |
| 用户音频输入 | input\\\\\_audio\\\\\_buffer.append > 添加音频到缓冲区 input\\\\\_image\\\\\_buffer.append > 添加图片到缓冲区 | 无   |
| 服务端音频输出 | 无   | response.created > 服务端开始生成响应 response.output\\\\\_item.added > 响应时有新的输出内容 response.content\\\\\_part.added > 新的输出内容添加到assistant message response.audio\\\\\_transcript.text > 增量生成的转录文字 response.audio.delta > 模型增量生成的音频 response.audio\\\\\_transcript.done > 文本转录完成 response.audio.done > 音频生成完成 response.content\\\\\_part.done > Assistant message 的文本或音频内容流式输出完成 response.output\\\\\_item.done > Assistant message 的整个输出项流式传输完成 response.done > 响应完成 |

\## \*\*API 参考\*\*
请参见\[实时音视频翻译（Qwen-Livetranslate-Realtime）](https://help.aliyun.com/zh/model-studio/live-translator-api/)。
\## \*\*计费说明\*\*
\-   \*\*音频\*\*：输入或输出每秒音频均消耗 12.5 Token。
\-   \*\*图片\*\*：每输入 28\\\*28 像素消耗 0.5 Token。
\-   \*\*文本\*\*：启用源语言语音识别功能后，服务除返回翻译结果外，还会返回输入音频的语音识别文本（即源语言原文），该识别文本将按输出文本的 Token 标准计费。
Token 费用请参见\[选择模型](https://help.aliyun.com/zh/model-studio/models)。
\## \*\*支持的语种\*\*
下表中的语种代码可用于指定源语种与目标语种。
> 部分目标语种仅支持输出文本，不支持输出音频。

| \*\*语种代码\*\* | \*\*语种\*\* | \*\*支持的输出模态\*\* |
| --- | --- | --- |
| en  | 英语  | 音频+文本 |
| zh  | 中文  | 音频+文本 |
| ru  | 俄语  | 音频+文本 |
| fr  | 法语  | 音频+文本 |
| de  | 德语  | 音频+文本 |
| pt  | 葡萄牙语 | 音频+文本 |
| es  | 西班牙语 | 音频+文本 |
| it  | 意大利语 | 音频+文本 |
| id  | 印尼语 | 文本  |
| ko  | 韩语  | 音频+文本 |
| ja  | 日语  | 音频+文本 |
| vi  | 越南语 | 文本  |
| th  | 泰语  | 文本  |
| ar  | 阿拉伯语 | 文本  |
| yue | 粤语  | 音频+文本 |
| hi  | 印地语 | 文本  |
| el  | 希腊语 | 文本  |
| tr  | 土耳其语 | 文本  |

\## \*\*支持的音色\*\*

| \*\*音色名\*\* | `\*\*voice\*\*`\*\*参数\*\* | \*\*音色效果\*\* | \*\*描述\*\* | \*\*支持的语种\*\* |
| --- | --- | --- | --- | --- |
| 芊悦  | Cherry |     | 阳光积极、亲切自然小姐姐。 | 中文、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 |
| 不吃鱼 | Nofish |     | 不会翘舌音的设计师。 | 中文、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 |
| 上海-阿珍 | Jada |     | 风风火火的沪上阿姐。 | 中文  |
| 北京-晓东 | Dylan |     | 北京胡同里长大的少年。 | 中文  |
| 四川-晴儿 | Sunny |     | 甜到你心里的川妹子。 | 中文  |
| 天津-李彼得 | Peter |     | 天津相声，专业捧人。 | 中文  |
| 粤语-阿清 | Kiki |     | 甜美的港妹闺蜜。 | 粤语  |
| 四川-程川 | Eric |     | 一个跳脱市井的四川成都男子。 | 中文  |

---
*← 返回 [README](./README.md)*
