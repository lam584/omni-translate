> 来源：`实时(Qwen-Omni-Realtime).md`
\## DashScope SDK
Python

```
\# SDK 版本不低于1.23.9
import os
import json
from dashscope.audio.qwen\_omni import OmniRealtimeConversation,OmniRealtimeCallback
import dashscope
\# 若没有配置 API Key，请将下行改为 dashscope.api\_key = "sk-xxx"
dashscope.api\_key = os.getenv("DASHSCOPE\_API\_KEY")
class PrintCallback(OmniRealtimeCallback):
    def on\_open(self) -> None:
        print("Connected Successfully")
    def on\_event(self, response: dict) -> None:
        print("Received event:")
        print(json.dumps(response, indent=2, ensure\_ascii=False))
    def on\_close(self, close\_status\_code: int, close\_msg: str) -> None:
        print(f"Connection closed (code={close\_status\_code}, msg={close\_msg}).")
callback = PrintCallback()
conversation = OmniRealtimeConversation(
    model="qwen3.5-omni-plus-realtime",
    callback=callback,
    # 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime
    url="wss://dashscope.aliyuncs.com/api-ws/v1/realtime"
)
try:
    conversation.connect()
    print("Conversation started. Press Ctrl+c to exit.")
    conversation.thread.join()
except KeyboardInterrupt:
    conversation.close()
```

Java

```
// SDK 版本不低于 2.20.9
import com.alibaba.dashscope.audio.omni.\*;
import com.alibaba.dashscope.exception.NoApiKeyException;
import com.google.gson.JsonObject;
import java.util.concurrent.CountDownLatch;
public class Main {
    public static void main(String\[] args) throws InterruptedException, NoApiKeyException {
        CountDownLatch latch = new CountDownLatch(1);
        OmniRealtimeParam param = OmniRealtimeParam.builder()
                .model("qwen3.5-omni-plus-realtime")
                .apikey(System.getenv("DASHSCOPE\_API\_KEY"))
                // 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime
                .url("wss://dashscope.aliyuncs.com/api-ws/v1/realtime")
                .build();
        OmniRealtimeConversation conversation = new OmniRealtimeConversation(param, new OmniRealtimeCallback() {
            @Override
            public void onOpen() {
                System.out.println("Connected Successfully");
            }
            @Override
            public void onEvent(JsonObject message) {
                System.out.println(message);
            }
            @Override
            public void onClose(int code, String reason) {
                System.out.println("connection closed code: " + code + ", reason: " + reason);
                latch.countDown();
            }
        });
        conversation.connect();
        latch.await();
        conversation.close(1000, "bye");
        System.exit(0);
    }
}
```

\### \*\*2\\. 配置会话\*\*
发送客户端事件\[session.update](https://help.aliyun.com/zh/model-studio/client-events#26a8302028sjm)：

```
{
    // 该事件的id，由客户端生成
    "event\_id": "event\_ToPZqeobitzUJnt3QqtWg",
    // 事件类型，固定为session.update
    "type": "session.update",
    // 会话配置
    "session": {
        // 输出模态，支持设置为\["text"]（仅输出文本）或\["text","audio"]（输出文本与音频）。
        "modalities": \[
            "text",
            "audio"
        ],
        // 输出音频的音色
        "voice": "Ethan",
        // 输入音频格式，当前仅支持设置为pcm。
        "input\_audio\_format": "pcm",
        // 输出音频格式，当前仅支持设置为pcm。
        "output\_audio\_format": "pcm",
        // 系统消息，用于设定模型的目标或角色。
        "instructions": "你是某五星级酒店的AI客服专员，请准确且友好地解答客户关于房型、设施、价格、预订政策的咨询。请始终以专业和乐于助人的态度回应，杜绝提供未经证实或超出酒店服务范围的信息。",
        // 是否开启语音活动检测。若需启用，需传入一个配置对象，服务端将据此自动检测语音起止。
        // 设置为null表示由客户端决定何时发起模型响应。
        "turn\_detection": {
            // VAD类型，取值为server\_vad或semantic\_vad。使用qwen3.5-omni-realtime模型时推荐设为semantic\_vad。
            "type": "semantic\_vad",
            // VAD检测阈值。建议在嘈杂的环境中增加，在安静的环境中降低。
            "threshold": 0.5,
            // 检测语音停止的静音持续时间，超过此值后会触发模型响应
            "silence\_duration\_ms": 800
        }
    }
}
```

\### \*\*3\\. 输入音频与图片\*\*
客户端通过\[input\\\_audio\\\_buffer.append](https://help.aliyun.com/zh/model-studio/client-events#2ea4b5e41fhjd)和 \[input\\\_image\\\_buffer.append](https://help.aliyun.com/zh/model-studio/client-events#c28ed38410nfw) 事件发送 Base64 编码的音频和图片数据到服务端缓冲区。音频输入是必需的；图片输入是可选的。
> 图片可以来自本地文件，或从视频流中实时采集。
> 启用服务端VAD时，服务端会在检测到语音结束时自动提交数据并触发响应。禁用VAD时（手动模式），客户端必须在发送完数据后，主动调用\[input\\\_audio\\\_buffer.commit](https://help.aliyun.com/zh/model-studio/client-events#1cbea5fa7fkfl)事件来提交。
\### \*\*4\\. 接收模型响应\*\*
模型的响应格式取决于配置的输出模态。
\-   \*\*仅输出文本\*\*
    通过\[response.text.delta](https://help.aliyun.com/zh/model-studio/server-events#0c54be63e0c3w)事件接收流式文本，\[response.text.done](https://help.aliyun.com/zh/model-studio/server-events#d675635a94jfb)事件获取完整文本。
\-   \*\*输出文本+音频\*\*
    -   \*\*文本\*\*：通过\[response.audio\\\_transcript.delta](https://help.aliyun.com/zh/model-studio/server-events#35396453cfood)事件接收流式文本，\[response.audio\\\_transcript.done](https://help.aliyun.com/zh/model-studio/server-events#f4d1698567bsm)事件获取完整文本。
    -   \*\*音频\*\*：通过\[response.audio.delta](https://help.aliyun.com/zh/model-studio/server-events#a25cc50a15car)事件获取 Base64 编码的流式输出音频数据。\[response.audio.done](https://help.aliyun.com/zh/model-studio/server-events#9e8eb59c67qnt)事件标志音频数据生成完成。
\## DashScope Java SDK
\*\*选择交互模式\*\*
\-   VAD 模式（Voice Activity Detection，自动检测语音起止）
    Realtime API 自动判断用户何时开始与停止说话并作出回应。
\-   Manual 模式（按下即说，松开即发送）
    客户端控制语音起止。用户说话结束后，客户端需主动发送消息至服务端。
---
*← 返回 [README](./README.md)*
