> 来源：`录音文件识别-Fun-ASR-Paraformer-SenseVoice.md`
Fun-ASR/Paraformer/SenseVoice的录音文件识别模型能将录制好的音频转换为文本，支持单个文件识别和批量文件识别，适用于处理不需要即时返回结果的场景。
\## \*\*适用范围\*\*
\*\*支持的模型：\*\*
\## 中国内地
服务部署范围为\[中国内地](https://help.aliyun.com/zh/model-studio/regions/#080da663a75xh)时，模型推理计算资源仅限于中国内地；静态数据存储于您所选的地域。该部署范围支持的地域：华北2（北京）。
调用以下模型时，请选择北京地域的\[API Key](https://bailian.console.aliyun.com/?tab=model#/api-key)：
\-   \*\*Fun-ASR\*\*：fun-asr（稳定版，当前等同fun-asr-2025-11-07）、fun-asr-2025-11-07（快照版）、fun-asr-2025-08-25（快照版）、fun-asr-mtl（稳定版，当前等同fun-asr-mtl-2025-08-25）、fun-asr-mtl-2025-08-25（快照版）
\-   \*\*Paraformer\*\*：paraformer-v2、paraformer-8k-v2、paraformer-v1、paraformer-8k-v1、paraformer-mtl-v1
\-   \*\*SenseVoice（即将下线）\*\*：sensevoice-v1
\## 国际
服务部署范围为\[国际](https://help.aliyun.com/zh/model-studio/regions/#080da663a75xh)时，模型推理计算资源在全球范围内动态调度（不含中国内地）；静态数据存储于您所选的地域。该部署范围支持的地域：新加坡。
调用以下模型时，请选择新加坡地域的\[API Key](https://modelstudio.console.aliyun.com/?tab=dashboard#/api-key)：
\-   \*\*Fun-ASR\*\*：fun-asr（稳定版，当前等同fun-asr-2025-11-07）、fun-asr-2025-11-07（快照版）、fun-asr-2025-08-25（快照版）、fun-asr-mtl（稳定版，当前等同fun-asr-mtl-2025-08-25）、fun-asr-mtl-2025-08-25（快照版）
更多信息请参见\[选择模型](https://help.aliyun.com/zh/model-studio/models)
\## \*\*模型选型\*\*

| \*\*场景\*\* | \*\*推荐模型\*\* | \*\*理由\*\* |
| --- | --- | --- |
| 中文识别（会议/直播） | fun-asr | 针对中文深度优化，覆盖多种方言；远场VAD和噪声鲁棒性强，适合嘈杂或多人远距离发言的真实场景，准确率更高 |
| 多语种识别（国际会议） | fun-asr-mtl、paraformer-v2 | 一个模型即可应对多语言需求，简化开发和部署 |
| 文娱内容分析与字幕生成 | fun-asr | 具备独特的歌唱识别能力，能有效转写歌曲、直播中的演唱片段；结合其噪声鲁棒性，非常适合处理复杂的媒体音频 |
| 新闻/访谈节目字幕生成 | fun-asr、paraformer-v2 | 长音频+标点预测+时间戳，直接生成结构化字幕 |
| 智能硬件远场语音交互 | fun-asr | 远场VAD（语音活动检测）经过专门优化，能在家庭、车载等嘈杂环境下，更准确地捕捉和识别用户的远距离指令 |

更多说明请参见\[模型功能特性对比](#ea5edc7ae4cq7)
\## \*\*快速开始\*\*
下面是调用API的示例代码。
您需要已\[获取API Key](https://help.aliyun.com/zh/model-studio/get-api-key)并\[配置API Key到环境变量](https://help.aliyun.com/zh/model-studio/configure-api-key-through-environment-variables)。如果通过SDK调用，还需要\[安装DashScope SDK](https://help.aliyun.com/zh/model-studio/install-sdk)。
\## Fun-ASR
由于音视频文件的尺寸通常较大，文件传输和语音识别处理均需要时间，文件转写API通过异步调用方式来提交任务。开发者需要通过查询接口，在文件转写完成后获得语音识别结果。
\## Python

```
from http import HTTPStatus
from dashscope.audio.asr import Transcription
from urllib import request
import dashscope
import os
import json
\# 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：https://dashscope-intl.aliyuncs.com/api/v1
dashscope.base\_http\_api\_url = 'https://dashscope.aliyuncs.com/api/v1'
\# 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
\# 若没有配置环境变量，请用百炼API Key将下行替换为：dashscope.api\_key = "sk-xxx"
dashscope.api\_key = os.getenv("DASHSCOPE\_API\_KEY")
task\_response = Transcription.async\_call(
    model='fun-asr',
    file\_urls=\['https://dashscope.oss-cn-beijing.aliyuncs.com/samples/audio/paraformer/hello\_world\_female2.wav',
               'https://dashscope.oss-cn-beijing.aliyuncs.com/samples/audio/paraformer/hello\_world\_male2.wav'],
    language\_hints=\['zh', 'en']  # language\_hints为可选参数，用于指定待识别音频的语言代码。取值范围请参见API参考文档。
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
