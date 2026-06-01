> 来源：`实时(Qwen-Omni-Realtime).md`
\## Windows

```
pip install pyaudio
```

安装完成后，通过 pip 安装依赖：

```
pip install websocket-client dashscope
```

\-   \*\*选择交互模式\*\*
    -   VAD 模式（Voice Activity Detection，自动检测语音起止）
        服务端自动判断用户何时开始与停止说话并作出回应。
    -   Manual 模式（按下即说，松开即发送）
        客户端控制语音起止。用户说话结束后，客户端需主动发送消息至服务端。

    ## VAD 模式

    新建一个 python 文件，命名为vad\\\_dash.py，并将以下代码复制到文件中：
    vad\\\_dash.py

    ```
    # 依赖：dashscope >= 1.23.9，pyaudio
    import os
    import base64
    import time
    import pyaudio
    from dashscope.audio.qwen\_omni import MultiModality, AudioFormat,OmniRealtimeCallback,OmniRealtimeConversation
    import dashscope
    # 配置参数：地址、API Key、音色、模型、模型角色
    # 指定地域，设为cn表示中国内地（北京），设为intl表示国际（新加坡）
    region = 'cn'
    base\_domain = 'dashscope.aliyuncs.com' if region == 'cn' else 'dashscope-intl.aliyuncs.com'
    url = f'wss://{base\_domain}/api-ws/v1/realtime'
    # 配置 API Key，若没有设置环境变量，请用 API Key 将下行替换为 dashscope.api\_key = "sk-xxx"
    dashscope.api\_key = os.getenv('DASHSCOPE\_API\_KEY')
    # 指定音色
    voice = 'Ethan'
    # 指定模型
    model = 'qwen3.5-omni-plus-realtime'
    # 指定模型角色
    instructions = "你是个人助理小云，请用幽默风趣的方式回答用户的问题"
    class SimpleCallback(OmniRealtimeCallback):
        def \_\_init\_\_(self, pya):
            self.pya = pya
            self.out = None
        def on\_open(self):
            # 初始化音频输出流
            self.out = self.pya.open(
                format=pyaudio.paInt16,
                channels=1,
                rate=24000,
                output=True
            )
        def on\_event(self, response):
            if response\['type'] == 'response.audio.delta':
                # 播放音频
                self.out.write(base64.b64decode(response\['delta']))
            elif response\['type'] == 'conversation.item.input\_audio\_transcription.completed':
                # 打印转录文本
                print(f"\[User] {response\['transcript']}")
            elif response\['type'] == 'response.audio\_transcript.done':
                # 打印助手回复文本
                print(f"\[LLM] {response\['transcript']}")
    # 1. 初始化音频设备
    pya = pyaudio.PyAudio()
    # 2. 创建回调函数和会话
    callback = SimpleCallback(pya)
    conv = OmniRealtimeConversation(model=model, callback=callback, url=url)
    # 3. 建立连接并配置会话
    conv.connect()
    conv.update\_session(output\_modalities=\[MultiModality.AUDIO, MultiModality.TEXT], voice=voice, instructions=instructions)
    # 4. 初始化音频输入流
    mic = pya.open(format=pyaudio.paInt16, channels=1, rate=16000, input=True)
    # 5. 主循环处理音频输入
    print("对话已开始，对着麦克风说话 (Ctrl+c 退出)...")
    try:
        while True:
            audio\_data = mic.read(3200, exception\_on\_overflow=False)
            conv.append\_audio(base64.b64encode(audio\_data).decode())
            time.sleep(0.01)
    except KeyboardInterrupt:
        # 清理资源
        conv.close()
        mic.close()
        callback.out.close()
        pya.terminate()
        print("\\n对话结束")
    ```

    运行`vad\_dash.py`，通过麦克风即可与 Qwen-Omni-Realtime 模型实时对话，系统会检测您的音频起始位置并自动发送到服务器，无需您手动发送。

    ## Manual 模式

    新建一个 python 文件，命名为`manual\_dash.py`，并将以下代码复制进文件中：
    manual\\\_dash.py

    ```
    # 依赖：dashscope >= 1.23.9，pyaudio。
    import os
    import base64
    import sys
    import threading
    import pyaudio
    from dashscope.audio.qwen\_omni import \*
    import dashscope
    # 如果没有设置环境变量，请用您的 API Key 将下行替换为 dashscope.api\_key = "sk-xxx"
    dashscope.api\_key = os.getenv('DASHSCOPE\_API\_KEY')
    voice = 'Ethan'
    class MyCallback(OmniRealtimeCallback):
        """最简回调：建立连接时初始化扬声器，事件中直接播放返回音频。"""
        def \_\_init\_\_(self, ctx):
            super().\_\_init\_\_()
            self.ctx = ctx
        def on\_open(self) -> None:
            # 连接建立后初始化 PyAudio 与扬声器(24k/mono/16bit)
            print('connection opened')
            try:
                self.ctx\['pya'] = pyaudio.PyAudio()
                self.ctx\['out'] = self.ctx\['pya'].open(
                    format=pyaudio.paInt16,
                    channels=1,
                    rate=24000,
                    output=True
                )
                print('audio output initialized')
            except Exception as e:
                print('\[Error] audio init failed: {}'.format(e))
        def on\_close(self, close\_status\_code, close\_msg) -> None:
            print('connection closed with code: {}, msg: {}'.format(close\_status\_code, close\_msg))
            sys.exit(0)
        def on\_event(self, response: str) -> None:
            try:
                t = response\['type']
                handlers = {
                    'session.created': lambda r: print('start session: {}'.format(r\['session']\['id'])),
                    'conversation.item.input\_audio\_transcription.completed': lambda r: print('question: {}'.format(r\['transcript'])),
                    'response.audio\_transcript.delta': lambda r: print('llm text: {}'.format(r\['delta'])),
                    'response.audio.delta': self.\_play\_audio,
                    'response.done': self.\_response\_done,
                }
                h = handlers.get(t)
                if h:
                    h(response)
            except Exception as e:
                print('\[Error] {}'.format(e))
        def \_play\_audio(self, response):
            # 直接解码base64并写入输出流进行播放
            if self.ctx\['out'] is None:
                return
            try:
                data = base64.b64decode(response\['delta'])
                self.ctx\['out'].write(data)
            except Exception as e:
                print('\[Error] audio playback failed: {}'.format(e))
        def \_response\_done(self, response):
            # 标记本轮对话完成，用于主循环等待
            if self.ctx\['conv'] is not None:
                print('\[Metric] response: {}, first text delay: {}, first audio delay: {}'.format(
                    self.ctx\['conv'].get\_last\_response\_id(),
                    self.ctx\['conv'].get\_last\_first\_text\_delay(),
                    self.ctx\['conv'].get\_last\_first\_audio\_delay(),
                ))
            if self.ctx\['resp\_done'] is not None:
                self.ctx\['resp\_done'].set()
    def shutdown\_ctx(ctx):
        """安全释放音频与PyAudio资源。"""
        try:
            if ctx\['out'] is not None:
                ctx\['out'].close()
                ctx\['out'] = None
        except Exception:
            pass
        try:
            if ctx\['pya'] is not None:
                ctx\['pya'].terminate()
                ctx\['pya'] = None
        except Exception:
            pass
    def record\_until\_enter(pya\_inst: pyaudio.PyAudio, sample\_rate=16000, chunk\_size=3200):
        """按 Enter 停止录音，返回PCM字节。"""
        frames = \[]
        stop\_evt = threading.Event()
        stream = pya\_inst.open(
            format=pyaudio.paInt16,
            channels=1,
            rate=sample\_rate,
            input=True,
            frames\_per\_buffer=chunk\_size
        )
        def \_reader():
            while not stop\_evt.is\_set():
                try:
                    frames.append(stream.read(chunk\_size, exception\_on\_overflow=False))
                except Exception:
                    break
        t = threading.Thread(target=\_reader, daemon=True)
        t.start()
        input()  # 用户再次按 Enter 停止录音
        stop\_evt.set()
        t.join(timeout=1.0)
        try:
            stream.close()
        except Exception:
            pass
        return b''.join(frames)
    if \_\_name\_\_  == '\_\_main\_\_':
        print('Initializing ...')
        # 运行时上下文：存放音频与会话句柄
        ctx = {'pya': None, 'out': None, 'conv': None, 'resp\_done': threading.Event()}
        callback = MyCallback(ctx)
        conversation = OmniRealtimeConversation(
            model='qwen3.5-omni-plus-realtime',
            callback=callback,
            # 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime
            url="wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
        )
        try:
            conversation.connect()
        except Exception as e:
            print('\[Error] connect failed: {}'.format(e))
            sys.exit(1)
        ctx\['conv'] = conversation
        # 会话配置：启用文本+音频输出（禁用服务端VAD，改为手动录音）
        conversation.update\_session(
            output\_modalities=\[MultiModality.AUDIO, MultiModality.TEXT],
            voice=voice,
            enable\_input\_audio\_transcription=True,
            input\_audio\_transcription\_model='qwen3-asr-flash-realtime',
            enable\_turn\_detection=False,
            instructions="你是个人助理小云，请你准确且友好地解答用户的问题，始终以乐于助人的态度回应。"
        )
        try:
            turn = 1
            while True:
                print(f"\\n--- 第 {turn} 轮对话 ---")
                print("按 Enter 开始录音（输入 q 回车退出）...")
                user\_input = input()
                if user\_input.strip().lower() in \['q', 'quit']:
                    print("用户请求退出...")
                    break
                print("录音中... 再次按 Enter 停止录音。")
                if ctx\['pya'] is None:
                    ctx\['pya'] = pyaudio.PyAudio()
                recorded = record\_until\_enter(ctx\['pya'])
                if not recorded:
                    print("未录制到有效音频，请重试。")
                    continue
                print(f"成功录制音频: {len(recorded)} 字节，发送中...")
                # 以3200字节为块发送（对应16k/16bit/100ms）
                chunk\_size = 3200
                for i in range(0, len(recorded), chunk\_size):
                    chunk = recorded\[i:i+chunk\_size]
                    conversation.append\_audio(base64.b64encode(chunk).decode('ascii'))
                print("发送完成，等待模型响应...")
                ctx\['resp\_done'].clear()
                conversation.commit()
                conversation.create\_response()
                ctx\['resp\_done'].wait()
                print('播放音频完成')
                turn += 1
        except KeyboardInterrupt:
            print("\\n程序被用户中断")
        finally:
            shutdown\_ctx(ctx)
            print("程序退出")
    ```

    运行`manual\_dash.py`，按 Enter 键开始说话，再按一次获取模型响应的音频。
---
*← 返回 [README](./README.md)*
