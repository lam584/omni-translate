> 来源：`实时(Qwen-Omni-Realtime).md`
Qwen-Omni-Realtime 是千问推出的实时音视频聊天模型。能同时理解流式的音频与图像输入（例如从视频流中实时抽取的连续图像帧），并实时输出高质量的文本与音频。
\*\*支持的地域：\*\*北京、新加坡，需使用各地域的 \[API Key](https://help.aliyun.com/zh/model-studio/get-api-key)。
\*\*在线体验：\*\*请参见\[如何在线体验 Qwen-Omni-Realtime 模型？](#14a119f447ehf)
\## WebSocket 原生连接
连接时需要以下配置项：

| \*\*配置项\*\* | \*\*说明\*\* |
| --- | --- |
| 调用地址 | 中国内地（北京）：wss://dashscope.aliyuncs.com/api-ws/v1/realtime 国际（新加坡）：wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime |
| 查询参数 | 查询参数为model，需指定为访问的模型名。示例：`?model=qwen3.5-omni-plus-realtime` |
| 请求头 | 使用 Bearer Token 鉴权：Authorization: Bearer DASHSCOPE\\\\\_API\\\\\_KEY > DASHSCOPE\\\\\_API\\\\\_KEY 是您在百炼上申请的\[API Key](https://help.aliyun.com/zh/model-studio/get-api-key)。 |

```
\# pip install websocket-client
import json
import websocket
import os
API\_KEY=os.getenv("DASHSCOPE\_API\_KEY")
API\_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3.5-omni-plus-realtime"
headers = \[
    "Authorization: Bearer " + API\_KEY
]
def on\_open(ws):
    print(f"Connected to server: {API\_URL}")
def on\_message(ws, message):
    data = json.loads(message)
    print("Received event:", json.dumps(data, indent=2))
def on\_error(ws, error):
    print("Error:", error)
ws = websocket.WebSocketApp(
    API\_URL,
    header=headers,
    on\_open=on\_open,
    on\_message=on\_message,
    on\_error=on\_error
)
ws.run\_forever()
```

---
*← 返回 [README](./README.md)*
