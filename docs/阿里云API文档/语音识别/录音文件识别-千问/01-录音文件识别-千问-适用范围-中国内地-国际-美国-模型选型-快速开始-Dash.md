> 来源：`录音文件识别-千问.md`
千问系列的录音文件识别模型能将录制好的音频转换为文本，支持多语言识别、歌唱识别、噪声拒识等功能。
\## \*\*适用范围\*\*
\*\*支持的模型：\*\*
服务主要提供两大核心模型：
\-   \*\*千问3-ASR-Flash-Filetrans\*\*：专为长音频（最长12小时）的异步识别设计，适用于会议记录、访谈整理等场景。
\-   \*\*千问3-ASR-Flash\*\*：专为短音频（最长5分钟）的同步或流式识别设计，适用于语音消息、实时字幕等场景。
\## 中国内地
服务部署范围为\[中国内地](https://help.aliyun.com/zh/model-studio/regions/#080da663a75xh)时，数据存储位于\*\*北京接入地域\*\*，模型推理计算资源仅限于中国内地。
调用以下模型时，请选择北京地域的\[API Key](https://bailian.console.aliyun.com/?tab=model#/api-key)：
\-   \*\*千问3-ASR-Flash-Filetrans：\*\*qwen3-asr-flash-filetrans（稳定版，当前等同qwen3-asr-flash-filetrans-2025-11-17）、qwen3-asr-flash-filetrans-2025-11-17（快照版）
\-   \*\*千问3-ASR-Flash：\*\*qwen3-asr-flash（稳定版，当前等同qwen3-asr-flash-2025-09-08）、qwen3-asr-flash-2026-02-10（最新快照版）、qwen3-asr-flash-2025-09-08（快照版）
\## 国际
服务部署范围为\[国际](https://help.aliyun.com/zh/model-studio/regions/#080da663a75xh)时，数据存储位于\*\*新加坡接入地域\*\*，模型推理计算资源在全球范围内动态调度（不含中国内地）。
调用以下模型时，请选择新加坡地域的\[API Key](https://modelstudio.console.aliyun.com/?tab=dashboard#/api-key)：
\-   \*\*千问3-ASR-Flash-Filetrans：\*\*qwen3-asr-flash-filetrans（稳定版，当前等同qwen3-asr-flash-filetrans-2025-11-17）、qwen3-asr-flash-filetrans-2025-11-17（快照版）
\-   \*\*千问3-ASR-Flash：\*\*qwen3-asr-flash（稳定版，当前等同qwen3-asr-flash-2025-09-08）、qwen3-asr-flash-2026-02-10（最新快照版）、qwen3-asr-flash-2025-09-08（快照版）
\## 美国
服务部署范围为\[美国](https://help.aliyun.com/zh/model-studio/regions/#080da663a75xh)时，数据存储位于\*\*美国（弗吉尼亚）接入地域\*\*，模型推理计算资源仅限于美国境内。
调用以下模型时，请选择美国地域的\[API Key](https://modelstudio.console.aliyun.com/us-east-1?tab=dashboard#/api-key)：
\*\*千问3-ASR-Flash：\*\*qwen3-asr-flash-us（稳定版，当前等同qwen3-asr-flash-2025-09-08-us）、qwen3-asr-flash-2025-09-08-us（快照版）
\## \*\*模型选型\*\*

| \*\*场景\*\* | \*\*推荐模型\*\* | \*\*理由\*\* | \*\*注意事项\*\* |
| --- | --- | --- | --- |
| \*\*长音频识别\*\* | qwen3-asr-flash-filetrans | 支持最长12小时录音，具备情感识别与句/字级别时间戳功能，适合后期索引与分析 | 音频文件大小不超过2GB，且时长不超过12小时 |
| \*\*短音频识别\*\* | qwen3-asr-flash或qwen3-asr-flash-us | 短音频识别，低延迟 | 音频文件大小不超过10MB，且时长不超过5分钟 |
| \*\*客服质检\*\* | qwen3-asr-flash-filetrans、qwen3-asr-flash或qwen3-asr-flash-us | 可分析客户情绪 | 不支持敏感词过滤；无说话人分离；根据音频时长选择合适的模型 |
| \*\*新闻/访谈节目字幕生成\*\* | qwen3-asr-flash-filetrans | 长音频+标点预测+时间戳，直接生成结构化字幕 | 需后处理生成标准字幕文件；根据音频时长选择合适的模型 |
| \*\*多语种视频本地化\*\* | qwen3-asr-flash-filetrans、qwen3-asr-flash或qwen3-asr-flash-us | 覆盖多种语言+方言，适合跨语种字幕制作 | 根据音频时长选择合适的模型 |
| \*\*歌唱类音频分析\*\* | qwen3-asr-flash-filetrans、qwen3-asr-flash或qwen3-asr-flash-us | 识别歌词并分析情绪，适用于歌曲索引与推荐 | 根据音频时长选择合适的模型 |

更多说明请参见\[模型功能特性对比](#ea5edc7ae4cq7)。
\## \*\*快速开始\*\*
API 使用前提：已\[获取API Key](https://help.aliyun.com/zh/model-studio/get-api-key)。如果通过SDK调用，需要\[安装最新版SDK](https://help.aliyun.com/zh/model-studio/install-sdk#8833b9274f4v8)。
\## DashScope
\## 千问3-ASR-Flash-Filetrans
千问3-ASR-Flash-Filetrans模型专为音频文件的异步转写设计，支持最长12小时录音。该模型要求输入为公网可访问的音频文件URL，不支持直接上传本地文件。此外，它是一个非流式接口，会在任务完成后一次性返回全部识别结果。
\## cURL
使用 cURL 进行语音识别时，需先提交任务获取任务ID（task\\\_id），再通过该ID获取任务执行结果。
\## 提交任务

```
\# ======= 重要提示 =======
\# 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：https://dashscope-intl.aliyuncs.com/api/v1/services/audio/asr/transcription
\# 新加坡地域和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
\# === 执行时请删除该注释 ===
curl -X POST 'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription' \\
\-H "Authorization: Bearer $DASHSCOPE\_API\_KEY" \\
\-H "Content-Type: application/json" \\
\-H "X-DashScope-Async: enable" \\
\-d '{
    "model": "qwen3-asr-flash-filetrans",
    "input": {
        "file\_url": "https://dashscope.oss-cn-beijing.aliyuncs.com/audios/welcome.mp3"
    },
    "parameters": {
        "channel\_id":\[
            0
        ],
        "enable\_itn": false,
        "enable\_words": true
    }
}'
```

\## 获取任务执行结果

```
\# ======= 重要提示 =======
\# 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：https://dashscope-intl.aliyuncs.com/api/v1/tasks/{task\_id}，注意，将{task\_id}替换为待查询任务ID
\# 新加坡地域和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
\# === 执行时请删除该注释 ===
curl -X GET 'https://dashscope.aliyuncs.com/api/v1/tasks/{task\_id}' \\
\-H "Authorization: Bearer $DASHSCOPE\_API\_KEY" \\
\-H "X-DashScope-Async: enable" \\
\-H "Content-Type: application/json"
```

\## 完整示例
---
*← 返回 [README](./README.md)*
