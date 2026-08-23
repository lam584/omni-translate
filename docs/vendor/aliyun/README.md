# 阿里云百炼语音能力资料索引

本目录不再镜像阿里云帮助中心正文。原有 101 份网页快照容易过期，
也没有为第三方文档建立明确的再分发许可与同步机制。这里仅保留官方
入口和 Omni Translate 自身的接入约定；涉及模型、地域、端点、计费、
限流或事件字段时，以官方页面的当前内容为准。

## 官方资料

- [Realtime API 概述](https://help.aliyun.com/zh/model-studio/realtime-api-overview)：WebSocket、WebRTC 与 AOQ 的协议和模型支持范围。
- [全模态模型选型](https://help.aliyun.com/zh/model-studio/omni/) 与 [Qwen-Omni 实时模型](https://help.aliyun.com/zh/model-studio/realtime)：实时全模态理解和语音交互。
- [实时音视频翻译](https://help.aliyun.com/zh/model-studio/qwen3-5-livetranslate-flash-realtime)、[客户端事件参考](https://help.aliyun.com/zh/model-studio/live-translator-client-events) 与 [文件翻译](https://help.aliyun.com/zh/model-studio/qwen3-livetranslate-flash)：实时/非实时翻译协议。
- [语音识别模型选型](https://help.aliyun.com/zh/model-studio/asr-model)、[实时语音识别](https://help.aliyun.com/zh/model-studio/real-time-speech-recognition-user-guide) 与 [非实时语音识别](https://help.aliyun.com/zh/model-studio/non-realtime-speech-recognition-user-guide)：Fun-ASR、Qwen-ASR 与 Paraformer。
- [语音合成模型选型](https://help.aliyun.com/zh/model-studio/tts-model)、[实时语音合成](https://help.aliyun.com/zh/model-studio/realtime-tts-user-guide)、[非实时语音合成](https://help.aliyun.com/zh/model-studio/non-realtime-tts-user-guide) 与 [Qwen-Audio-TTS 音色列表](https://help.aliyun.com/zh/model-studio/qwen-audio-tts-voice-list)。
- [地域与接入域名](https://help.aliyun.com/en/model-studio/regions/)、[模型限流](https://help.aliyun.com/zh/model-studio/rate-limit) 与 [模型价格](https://help.aliyun.com/zh/model-studio/model-pricing)：发布或调整默认配置前必须重新核对。

## 项目内的稳定边界

- Provider 路由、模型类型和端点归一化由
  [`apps/desktop/src-tauri/src/provider/gateway.rs`](../../../apps/desktop/src-tauri/src/provider/gateway.rs)
  及其测试定义；不要从供应商网页复制一套并行实现。
- 基准工具的实时端点和事件解析由
  [`apps/desktop/src-tauri/src/benchmark`](../../../apps/desktop/src-tauri/src/benchmark)
  维护。
- Watch Mode 合成测试素材的模型、音色、seed 和后处理规则位于
  [`scripts/testing/fixtures`](../../../scripts/testing/fixtures)。凭据只从环境变量或未跟踪的本地集成配置读取。
- 北京与新加坡地域的 API Key、可用模型和域名不是可互换配置。仓库文档
  不固定抄录这些易变列表；运行时配置必须把地域、端点和凭据作为同一组
  来源管理。

## 来源、许可与更新规则

链接页面及其示例的版权和许可由阿里云及页面标示的权利人决定，
不受本仓库 Apache-2.0 许可证覆盖。本目录没有复制官方正文、图片或示例
附件，也不声明对其进行再分发的许可。

当 Provider 协议、默认模型或发布验证链路变化时，维护者应：

1. 重新检查上述官方页面及目标地域；
2. 只把项目需要长期稳定的结论写入代码、契约测试或项目文档；
3. 在同一变更中更新相关测试，不重新导入整页快照；
4. 若确需保存第三方材料，先记录原始 URL、抓取日期、适用版本和明确的再分发许可。

本索引最后复核日期：2026-08-24。
