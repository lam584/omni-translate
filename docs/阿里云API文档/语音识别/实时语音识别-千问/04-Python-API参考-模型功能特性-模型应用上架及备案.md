> 来源：`实时语音识别-千问.md`
\## Python
1\.  \[安装SDK](https://help.aliyun.com/zh/model-studio/install-sdk)，确保DashScope SDK版本不低于1.25.6。
2\.  \[获取API Key](https://help.aliyun.com/zh/model-studio/get-api-key)，推荐使用环境变量配置 API Key，以避免在代码中硬编码。
3\.  运行示例代码。
    更多示例代码请参见\[Github](https://github.com/aliyun/alibabacloud-bailian-speech-demo/tree/master/samples/speech-recognition/recognize\_speech\_from\_microphone\_with\_qwen3\_asr\_flash\_realtime)。

    ```
    import logging
    import os
    import base64
    import signal
    import sys
    import time
    import dashscope
    from dashscope.audio.qwen\_omni import \*
    from dashscope.audio.qwen\_omni.omni\_realtime import TranscriptionParams
    def setup\_logging():
        """配置日志输出"""
        logger = logging.getLogger('dashscope')
        logger.setLevel(logging.DEBUG)
        handler = logging.StreamHandler(sys.stdout)
        handler.setLevel(logging.DEBUG)
        formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
        handler.setFormatter(formatter)
        logger.addHandler(handler)
        logger.propagate = False
        return logger
    def init\_api\_key():
        """初始化 API Key"""
        # 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
        # 若没有配置环境变量，请用百炼API Key将下行替换为：dashscope.api\_key = "sk-xxx"
        dashscope.api\_key = os.environ.get('DASHSCOPE\_API\_KEY', 'YOUR\_API\_KEY')
        if dashscope.api\_key == 'YOUR\_API\_KEY':
            print('\[Warning] Using placeholder API key, set DASHSCOPE\_API\_KEY environment variable.')
    class MyCallback(OmniRealtimeCallback):
        """实时识别回调处理"""
        def \_\_init\_\_(self, conversation):
            self.conversation = conversation
            self.handlers = {
                'session.created': self.\_handle\_session\_created,
                'conversation.item.input\_audio\_transcription.completed': self.\_handle\_final\_text,
                'conversation.item.input\_audio\_transcription.text': self.\_handle\_transcription\_text,
                'input\_audio\_buffer.speech\_started': lambda r: print('======Speech Start======'),
                'input\_audio\_buffer.speech\_stopped': lambda r: print('======Speech Stop======')
            }
        def on\_open(self):
            print('Connection opened')
        def on\_close(self, code, msg):
            print(f'Connection closed, code: {code}, msg: {msg}')
        def on\_event(self, response):
            try:
                handler = self.handlers.get(response\['type'])
                if handler:
                    handler(response)
            except Exception as e:
                print(f'\[Error] {e}')
        def \_handle\_session\_created(self, response):
            print(f"Start session: {response\['session']\['id']}")
        def \_handle\_final\_text(self, response):
            print(f"Final recognized text: {response\['transcript']}")
        def \_handle\_transcription\_text(self, response):
            print(f"Got transcription result: {response\['text'] + response\['stash']}")
    def read\_audio\_chunks(file\_path, chunk\_size=3200):
        """按块读取音频文件"""
        with open(file\_path, 'rb') as f:
            while chunk := f.read(chunk\_size):
                yield chunk
    def send\_audio(conversation, file\_path, delay=0.1):
        """发送音频数据"""
        if not os.path.exists(file\_path):
            raise FileNotFoundError(f"Audio file {file\_path} does not exist.")
        print("Processing audio file... Press 'Ctrl+c' to stop.")
        for chunk in read\_audio\_chunks(file\_path):
            audio\_b64 = base64.b64encode(chunk).decode('ascii')
            conversation.append\_audio(audio\_b64)
            time.sleep(delay)
    def main():
        setup\_logging()
        init\_api\_key()
        audio\_file\_path = "./your\_audio\_file.pcm"
        conversation = OmniRealtimeConversation(
            model='qwen3-asr-flash-realtime',
            # 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime
            url='wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
            callback=MyCallback(conversation=None)  # 暂时传None，稍后注入
        )
        # 注入自身到回调
        conversation.callback.conversation = conversation
        def handle\_exit(sig, frame):
            print('Ctrl+c pressed, exiting...')
            conversation.close()
            sys.exit(0)
        signal.signal(signal.SIGINT, handle\_exit)
        conversation.connect()
        transcription\_params = TranscriptionParams(
            language='zh',
            sample\_rate=16000,
            input\_audio\_format="pcm"
        )
        conversation.update\_session(
            output\_modalities=\[MultiModality.TEXT],
            enable\_input\_audio\_transcription=True,
            transcription\_params=transcription\_params
        )
        try:
            send\_audio(conversation, audio\_file\_path)
            # send session.finish and wait for finished and close
            conversation.end\_session()
        except Exception as e:
            print(f"Error occurred: {e}")
        finally:
            conversation.close()
            print("Audio processing completed.")
    if \_\_name\_\_ == '\_\_main\_\_':
        main()
    ```

\## \*\*API参考\*\*
\[实时语音识别-千问API参考](https://help.aliyun.com/zh/model-studio/qwen-asr-realtime-api/)
\## \*\*模型功能特性\*\*

| \*\*功能/特性\*\* | \*\*qwen3-asr-flash-realtime、qwen3-asr-flash-realtime-2026-02-10、qwen3-asr-flash-realtime-2025-10-27\*\* |
| --- | --- |
| \*\*支持语言\*\* | 中文（普通话、四川话、闽南语、吴语、粤语）、英语、日语、德语、韩语、俄语、法语、葡萄牙语、阿拉伯语、意大利语、西班牙语、印地语、印尼语、泰语、土耳其语、乌克兰语、越南语、捷克语、丹麦语、菲律宾语、芬兰语、冰岛语、马来语、挪威语、波兰语、瑞典语 |
| \*\*支持的音频格式\*\* | pcm、opus |
| \*\*采样率\*\* | 8kHz、16kHz |
| \*\*声道\*\* | 单声道 |
| \*\*输入形式\*\* | 二进制音频流 |
| \*\*音频大小/时长\*\* | 不限  |
| \*\*情感识别\*\* | 支持 固定开启 |
| \*\*敏感词过滤\*\* | 不支持 |
| \*\*说话人分离\*\* | 不支持 |
| \*\*语气词过滤\*\* | 不支持 |
| \*\*时间戳\*\* | 不支持 |
| \*\*标点符号预测\*\* | 支持 固定开启 |
| \*\*热词\*\* | 不支持 |
| \*\*ITN（Inverse Text Normalization，逆文本正则化）\*\* | 不支持 |
| \*\*VAD（Voice Activity Detection，语音活动检测）\*\* | 支持 固定开启 |
| \*\*限流（RPS）\*\* | 20  |
| \*\*接入方式\*\* | Java/Python SDK、WebSocket API |
| \*\*价格\*\* | 中国内地：0.00033元/秒 国际：0.00066元/秒 |

\## \*\*模型应用上架及备案\*\*
参见\[应用合规备案](https://help.aliyun.com/zh/model-studio/compliance-and-launch-filing-guide-for-ai-apps-powered-by-the-tongyi-model)。
 span.aliyun-docs-icon { color: transparent !important; font-size: 0 !important; } span.aliyun-docs-icon:before { color: black; font-size: 16px; } span.aliyun-docs-icon.icon-size-20:before { font-size: 20px; } span.aliyun-docs-icon.icon-size-22:before { font-size: 22px; } span.aliyun-docs-icon.icon-size-24:before { font-size: 24px; } span.aliyun-docs-icon.icon-size-26:before { font-size: 26px; } span.aliyun-docs-icon.icon-size-28:before { font-size: 28px; }
---
*← 返回 [README](./README.md)*
