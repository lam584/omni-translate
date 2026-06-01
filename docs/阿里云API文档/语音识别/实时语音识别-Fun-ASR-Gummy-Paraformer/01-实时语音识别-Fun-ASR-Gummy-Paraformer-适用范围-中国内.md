> 来源：`实时语音识别-Fun-ASR-Gummy-Paraformer.md`
实时语音识别服务可将音频流实时转换为带标点的文本，实现“边说边出文字”的效果。无论是麦克风语音、会议录音还是本地音频文件，都能轻松转录。服务广泛应用于会议实时记录、直播字幕、语音聊天、智能客服等场景。
\## \*\*适用范围\*\*
\*\*支持的模型：\*\*
\## 中国内地
服务部署范围为\[中国内地](https://help.aliyun.com/zh/model-studio/regions/#080da663a75xh)时，数据存储位于\*\*北京接入地域\*\*，模型推理计算资源仅限于中国内地。
调用以下模型时，请选择北京地域的\[API Key](https://bailian.console.aliyun.com/?tab=model#/api-key)：
\-   \*\*Fun-ASR\*\*：
    -   fun-asr-realtime（稳定版，当前等同fun-asr-realtime-2025-11-07）、fun-asr-realtime-2026-02-28（最新快照版）、fun-asr-realtime-2025-11-07（快照版）、fun-asr-realtime-2025-09-15（快照版）
    -   fun-asr-flash-8k-realtime（稳定版，当前等同fun-asr-flash-8k-realtime-2026-01-28）、fun-asr-flash-8k-realtime-2026-01-28
\-   \*\*Gummy：\*\*gummy-realtime-v1、gummy-chat-v1
\-   \*\*Paraformer\*\*：paraformer-realtime-v2、paraformer-realtime-v1、paraformer-realtime-8k-v2、paraformer-realtime-8k-v1
\## 国际
服务部署范围为\[国际](https://help.aliyun.com/zh/model-studio/regions/#080da663a75xh)时，数据存储位于\*\*新加坡接入地域\*\*，模型推理计算资源在全球范围内动态调度（不含中国内地）。
调用以下模型时，请选择新加坡地域的\[API Key](https://modelstudio.console.aliyun.com/?tab=dashboard#/api-key)：
\-   \*\*Fun-ASR\*\*：fun-asr-realtime（稳定版，当前等同fun-asr-realtime-2025-11-07）、fun-asr-realtime-2025-11-07（快照版）
更多信息请参见模型列表
\## \*\*模型选型\*\*

| \*\*场景\*\* | \*\*推荐模型\*\* | \*\*理由\*\* |
| --- | --- | --- |
| \*\*中文普通话识别（会议/直播）\*\* | fun-asr-realtime、fun-asr-realtime-2026-02-28、paraformer-realtime-v2 | 多格式兼容，高采样率支持，稳定延迟 |
| \*\*多语种识别（跨境客服、国际会议）\*\* | gummy-realtime-v1、paraformer-realtime-v2 | 支持跨境场景与多语种自由切换 |
| \*\*中文方言识别（客服/政务）\*\* | fun-asr-realtime-2026-02-28、paraformer-realtime-v2 | 覆盖多地方言 |
| \*\*中英日混合识别（课堂/演讲）\*\* | fun-asr-realtime、fun-asr-realtime-2025-11-07 | 中英日识别优化 |
| \*\*短音频快速交互（智能客服）\*\* | gummy-chat-v1 | 1分钟内音频，低成本，支持多语种 |
| \*\*低带宽电话录音转写\*\* | fun-asr-flash-8k-realtime | 专为中文电话客服场景设计 |
| \*\*热词定制场景（品牌名/专有术语）\*\* | Fun-ASR、Gummy、Paraformer最新版本模型 | 热词可开关，易于迭代配置 |

更多说明请参见\[模型功能特性对比](#ea5edc7ae4cq7)。
\## \*\*快速开始\*\*
下面是调用API的示例代码。更多常用场景的代码示例，请参见\[GitHub](https://github.com/aliyun/alibabacloud-bailian-speech-demo)。
您需要已\[获取API Key](https://help.aliyun.com/zh/model-studio/get-api-key)并\[配置API Key到环境变量](https://help.aliyun.com/zh/model-studio/configure-api-key-through-environment-variables)。如果通过SDK调用，还需要\[安装DashScope SDK](https://help.aliyun.com/zh/model-studio/install-sdk)。
\## Fun-ASR
\## 识别传入麦克风的语音
实时语音识别可以识别麦克风中传入的语音并输出识别结果，达到“边说边出文字”的效果。
---
*← 返回 [README](./README.md)*
