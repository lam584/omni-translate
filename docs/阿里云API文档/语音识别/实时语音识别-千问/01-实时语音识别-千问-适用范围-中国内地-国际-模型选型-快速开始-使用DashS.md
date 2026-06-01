> 来源：`实时语音识别-千问.md`
在直播、在线会议、语音聊天或智能助手等场景中，需要将连续的音频流实时转化为文字，以提供即时字幕、生成会议记录或响应语音指令。千问实时语音识别服务能够接收音频流并实时转写。
\## \*\*适用范围\*\*
\*\*支持的模型：\*\*
\## 中国内地
服务部署范围为\[中国内地](https://help.aliyun.com/zh/model-studio/regions/#080da663a75xh)时，数据存储位于\*\*北京接入地域\*\*，模型推理计算资源仅限于中国内地。
调用以下模型时，请选择北京地域的\[API Key](https://bailian.console.aliyun.com/?tab=model#/api-key)：
\*\*千问3-ASR-Flash-Realtime\*\*：qwen3-asr-flash-realtime（稳定版，当前等同qwen3-asr-flash-realtime-2025-10-27）、qwen3-asr-flash-realtime-2026-02-10（最新快照版）、qwen3-asr-flash-realtime-2025-10-27（快照版）
\## 国际
服务部署范围为\[国际](https://help.aliyun.com/zh/model-studio/regions/#080da663a75xh)时，数据存储位于\*\*新加坡接入地域\*\*，模型推理计算资源在全球范围内动态调度（不含中国内地）。
调用以下模型时，请选择新加坡地域的\[API Key](https://modelstudio.console.aliyun.com/?tab=dashboard#/api-key)：
\*\*千问3-ASR-Flash-Realtime\*\*：qwen3-asr-flash-realtime（稳定版，当前等同qwen3-asr-flash-realtime-2025-10-27）、qwen3-asr-flash-realtime-2026-02-10（最新快照版）、qwen3-asr-flash-realtime-2025-10-27（快照版）
\## \*\*模型选型\*\*

| \*\*场景\*\* | \*\*推荐模型\*\* | \*\*理由\*\* |
| --- | --- | --- |
| \*\*智能客服质检\*\* | qwen3-asr-flash-realtime-2026-02-10 | 实时分析通话内容与客户情绪，辅助坐席并进行服务质量监控 |
| \*\*直播/短视频\*\* | 为直播内容生成实时字幕，覆盖多语种观众 |
| \*\*在线会议/访谈\*\* | 实时记录会议发言，快速生成文字纪要，提高信息整理效率 |

更多说明请参见\[模型功能特性](#ea5edc7ae4cq7)。
\## \*\*快速开始\*\*
\## 使用DashScope SDK
---
*← 返回 [README](./README.md)*
