> 来源：`语音合成-千问.md`
\## \*\*核心功能\*\*
\-   支持流式输出，可以边合成边播放
\-   覆盖多种语言，包含中文方言
\-   提供丰富音色，满足场景需求
\-   提供\[声音复刻](https://help.aliyun.com/zh/model-studio/qwen-tts-voice-cloning)与\[声音设计](https://help.aliyun.com/zh/model-studio/qwen-tts-voice-design)两种音色定制方式
\-   支持\[指令控制](#12884a10929p9)，可通过自然语言指令控制语音表现力
\## cURL

```
\# ======= 重要提示 =======
\# 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
\# 新加坡地域和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
\# === 执行时请删除该注释 ===
curl -X POST 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation' \\
\-H "Authorization: Bearer $DASHSCOPE\_API\_KEY" \\
\-H 'Content-Type: application/json' \\
\-d '{
    "model": "qwen3-tts-flash",
    "input": {
        "text": "那我来给大家推荐一款T恤，这款呢真的是超级好看，这个颜色呢很显气质，而且呢也是搭配的绝佳单品，大家可以闭眼入，真的是非常好看，对身材的包容性也很好，不管啥身材的宝宝呢，穿上去都是很好看的。推荐宝宝们下单哦。",
        "voice": "Cherry",
        "language\_type": "Chinese"
    }
}'
```

\## 流式输出
可以流式地将音频数据以 Base64 格式进行输出，此时最后一个数据包中包含完整音频的 URL。
---
*← 返回 [README](./README.md)*
