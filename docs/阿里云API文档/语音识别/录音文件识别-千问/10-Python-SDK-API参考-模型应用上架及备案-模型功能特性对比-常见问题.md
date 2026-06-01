> 来源：`录音文件识别-千问.md`
\## Python SDK
示例中用到的音频文件为：\[welcome.mp3](https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20260105/wotsae/welcome.mp3)。

```
import base64
from openai import OpenAI
import os
import pathlib
try:
    # 请替换为实际的音频文件路径
    file\_path = "welcome.mp3"
    # 请替换为实际的音频文件MIME类型
    audio\_mime\_type = "audio/mpeg"
    file\_path\_obj = pathlib.Path(file\_path)
    if not file\_path\_obj.exists():
        raise FileNotFoundError(f"音频文件不存在: {file\_path}")
    base64\_str = base64.b64encode(file\_path\_obj.read\_bytes()).decode()
    data\_uri = f"data:{audio\_mime\_type};base64,{base64\_str}"
    client = OpenAI(
        # 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
        # 若没有配置环境变量，请用百炼API Key将下行替换为：api\_key = "sk-xxx",
        api\_key=os.getenv("DASHSCOPE\_API\_KEY"),
        # 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：https://dashscope-intl.aliyuncs.com/compatible-mode/v1
        base\_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
    )
    stream\_enabled = False  # 是否开启流式输出
    completion = client.chat.completions.create(
        model="qwen3-asr-flash",
        messages=\[
            {
                "content": \[
                    {
                        "type": "input\_audio",
                        "input\_audio": {
                            "data": data\_uri
                        }
                    }
                ],
                "role": "user"
            }
        ],
        stream=stream\_enabled,
        # stream设为False时，不能设置stream\_options参数
        # stream\_options={"include\_usage": True},
        extra\_body={
            "asr\_options": {
                # "language": "zh",
                "enable\_itn": False
            }
        }
    )
    if stream\_enabled:
        full\_content = ""
        print("流式输出内容为：")
        for chunk in completion:
            # 如果stream\_options.include\_usage为True，则最后一个chunk的choices字段为空列表，需要跳过（可以通过chunk.usage获取 Token 使用量）
            print(chunk)
            if chunk.choices and chunk.choices\[0].delta.content:
                full\_content += chunk.choices\[0].delta.content
        print(f"完整内容为：{full\_content}")
    else:
        print(f"非流式输出内容为：{completion.choices\[0].message.content}")
except Exception as e:
    print(f"错误信息：{e}")
```

\## \*\*API参考\*\*
\[录音文件识别-千问API参考](https://help.aliyun.com/zh/model-studio/qwen-asr-api-reference)
\## \*\*模型应用上架及备案\*\*
参见\[应用合规备案](https://help.aliyun.com/zh/model-studio/compliance-and-launch-filing-guide-for-ai-apps-powered-by-the-tongyi-model)。
\## \*\*模型功能特性对比\*\*
下表中qwen3-asr-flash和qwen3-asr-flash-2025-09-08模型的功能特性同样适用于美国（弗吉尼亚）地域对应的qwen3-asr-flash-us和qwen3-asr-flash-2025-09-08-us模型。

| \*\*功能/特性\*\* | \*\*qwen3-asr-flash-filetrans、qwen3-asr-flash-filetrans-2025-11-17\*\* | \*\*qwen3-asr-flash、qwen3-asr-flash-2026-02-10、qwen3-asr-flash-2025-09-08\*\* |
| --- | --- | --- |
| \*\*支持语言\*\* | 中文（普通话、四川话、闽南语、吴语、粤语）、英语、日语、德语、韩语、俄语、法语、葡萄牙语、阿拉伯语、意大利语、西班牙语、印地语、印尼语、泰语、土耳其语、乌克兰语、越南语、捷克语、丹麦语、菲律宾语、芬兰语、冰岛语、马来语、挪威语、波兰语、瑞典语 |   |
| \*\*支持的音频格式\*\* | aac、amr、avi、flac、flv、m4a、mkv、mov、mp3、mp4、mpeg、ogg、opus、wav、webm、wma、wmv | aac、amr、avi、aiff、flac、flv、mkv、mp3、mpeg、ogg、opus、wav、webm、wma、wmv |
| \*\*采样率\*\* | 因音频格式而异： - pcm格式音频：16kHz - 其他格式音频：任意（服务端会先将音频重采样为 16 kHz，再进行识别） |   |
| \*\*声道\*\* | 任意 不同模型在处理多声道音频时方式存在差异： - 千问3-ASR-Flash-Filetrans：需通过`channel\_id`参数指定音轨索引 - 千问3-ASR-Flash：无需额外处理，模型会对多声道音频做均值合并后再处理 |   |
| \*\*输入形式\*\* | 公网可访问的待识别文件URL | Base64编码的文件、本地文件绝对路径、公网可访问的待识别文件URL |
| \*\*音频大小/时长\*\* | 音频文件大小不超过2GB，且时长不超过12小时 | 音频文件大小不超过10MB，且时长不超过5分钟 |
| \*\*情感识别\*\* | 支持 固定开启，可通过响应参数`emotion`查看结果 |   |
| \*\*时间戳\*\* | 支持 固定开启，可通过请求参数`enable\_words`控制时间戳级别 > 字级别时间戳仅支持以下语种：中文、英语、日语、韩语、德语、法语、西班牙语、意大利语、葡萄牙语、俄语，其他语种可能无法保证准确性 | 不支持 |
| \*\*标点符号预测\*\* | 支持 固定开启 |   |
| \*\*热词\*\* | 不支持 |   |
| \*\*ITN\*\* | 支持 默认关闭，可开启，仅适用于中、英文 |   |
| \*\*歌唱识别\*\* | 支持 固定开启 |   |
| \*\*噪声拒识\*\* | 支持 固定开启 |   |
| \*\*敏感词过滤\*\* | 不支持 |   |
| \*\*说话人分离\*\* | 不支持 |   |
| \*\*语气词过滤\*\* | 不支持 |   |
| \*\*VAD\*\* | 支持 固定开启 | 不支持 |
| \*\*限流（RPM）\*\* | 100 |   |
| \*\*接入方式\*\* | DashScope：Java/Python SDK、RESTful API | DashScope：Java/Python SDK、RESTful API OpenAI：Python/Node.js SDK、RESTful API |
| \*\*价格\*\* | 中国内地：0.00022元/秒 美国：0.000035元/秒 国际：0.00026元/秒 |   |

\## 常见问题
\### \*\*Q：如何为API提供公网可访问的音频URL？\*\*
推荐使用\[阿里云对象存储OSS](https://help.aliyun.com/zh/oss/user-guide/simple-upload#a632b50f190j8)，它提供了高可用、高可靠的存储服务，并且可以方便地生成公网访问URL。
\*\*在公网环境下验证生成的 URL 可正常访问：\*\*可在浏览器或通过 curl 命令访问该 URL，确保音频文件能够成功下载或播放（HTTP状态码为200）。
\### \*\*Q：如何检查音频格式是否符合要求？\*\*
可以使用开源工具\[ffprobe](https://ffmpeg.org/ffprobe.html)快速获取音频的详细信息：

```
\# 查询音频的容器格式(format\_name)、编码(codec\_name)、采样率(sample\_rate)、声道数(channels)
ffprobe -v error -show\_entries format=format\_name -show\_entries stream=codec\_name,sample\_rate,channels -of default=noprint\_wrappers=1 your\_audio\_file.mp3
```

\### \*\*Q：\*\*如何处理音频以满足模型要求？
可以使用开源工具\[FFmpeg](https://ffmpeg.en.lo4d.com/download)对音频进行裁剪或格式转换：
\-   \*\*音频裁剪：从长音频中截取片段\*\*

    ```
    # -i: 输入文件
    # -ss 00:01:30: 设置裁剪的起始时间 (从1分30秒开始)
    # -t 00:02:00: 设置裁剪的持续时长 (裁剪2分钟)
    # -c copy: 直接复制音频流，不重新编码，速度快
    # output\_clip.wav: 输出文件
    ffmpeg -i long\_audio.wav -ss 00:01:30 -t 00:02:00 -c copy output\_clip.wav
    ```

\-   \*\*格式转换\*\*
    例如，将任意音频转换为16kHz、16-bit、单声道WAV文件

    ```
    # -i: 输入文件
    # -ac 1: 设置声道数为1 (单声道)
    # -ar 16000: 设置采样率为16000Hz (16kHz)
    # -sample\_fmt s16: 设置采样格式为16-bit signed integer PCM
    # output.wav: 输出文件
    ffmpeg -i input.mp3 -ac 1 -ar 16000 -sample\_fmt s16 output.wav
    ```

/\\\* 让引用上下间距调小，避免内容显示过于稀疏 \\\*/ .unionContainer .markdown-body blockquote { margin: 4px 0; } .aliyun-docs-content table.qwen blockquote { border-left: none; /\\\* 添加这一行来移除表格里的引用文字的左侧边框 \\\*/ padding-left: 5px; /\\\* 左侧内边距 \\\*/ margin: 4px 0; }
 span.aliyun-docs-icon { color: transparent !important; font-size: 0 !important; } span.aliyun-docs-icon:before { color: black; font-size: 16px; } span.aliyun-docs-icon.icon-size-20:before { font-size: 20px; } span.aliyun-docs-icon.icon-size-22:before { font-size: 22px; } span.aliyun-docs-icon.icon-size-24:before { font-size: 24px; } span.aliyun-docs-icon.icon-size-26:before { font-size: 26px; } span.aliyun-docs-icon.icon-size-28:before { font-size: 28px; }
---
*← 返回 [README](./README.md)*
