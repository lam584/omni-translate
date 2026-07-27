> 来源：`录音文件识别-Fun-ASR-Paraformer-SenseVoice.md`
\## \*\*核心功能\*\*
\-   \*\*多语种识别\*\*：支持识别中文（含多种方言）、英、日、韩、德、法、俄等多种语言。
\-   \*\*广泛格式兼容\*\*：支持任意采样率，并兼容aac、wav、mp3等多种主流音视频格式。
\-   \*\*长音频文件处理\*\*：支持对单个时长不超过12小时、体积不超过2GB的音频文件进行异步转写。如果启用说话人分离功能，建议音频时长不超过2小时。
\-   \*\*歌唱识别\*\*：即使在伴随背景音乐（BGM）的情况下，也能实现整首歌曲的转写（仅fun-asr和fun-asr-2025-11-07模型支持该功能）。
\-   \*\*丰富识别功能\*\*：提供说话人分离、敏感词过滤、句子/词语级时间戳、热词增强等可配置功能，满足个性化需求。
\## Paraformer
由于音视频文件的尺寸通常较大，文件传输和语音识别处理均需要时间，文件转写API通过异步调用方式来提交任务。开发者需要通过查询接口，在文件转写完成后获得语音识别结果。
\## Python

```
from http import HTTPStatus
from dashscope.audio.asr import Transcription
from urllib import request
import dashscope
import os
import json
\# 获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
\# 若没有配置环境变量，请用百炼API Key将下行替换为：dashscope.api\_key = "sk-xxx"
dashscope.api\_key = os.getenv("DASHSCOPE\_API\_KEY")
task\_response = Transcription.async\_call(
    model='paraformer-v2',
    file\_urls=\['https://dashscope.oss-cn-beijing.aliyuncs.com/samples/audio/paraformer/hello\_world\_female2.wav',
               'https://dashscope.oss-cn-beijing.aliyuncs.com/samples/audio/paraformer/hello\_world\_male2.wav'],
    language\_hints=\['zh', 'en']  # language\_hints为可选参数，用于指定待识别音频的语言代码。仅Paraformer系列的paraformer-v2模型支持该参数，取值范围请参见API参考文档。
)
transcription\_response = Transcription.wait(task=task\_response.output.task\_id)
if transcription\_response.status\_code == HTTPStatus.OK:
    for transcription in transcription\_response.output\['results']:
        if transcription\['subtask\_status'] == 'SUCCEEDED':
            url = transcription\['transcription\_url']
            result = json.loads(request.urlopen(url).read().decode('utf8'))
            print(json.dumps(result, indent=4,
                            ensure\_ascii=False))
        else:
            print('transcription failed!')
            print(transcription)
else:
    print('Error: ', transcription\_response.output.message)
```

---
*← 返回 [README](./README.md)*
