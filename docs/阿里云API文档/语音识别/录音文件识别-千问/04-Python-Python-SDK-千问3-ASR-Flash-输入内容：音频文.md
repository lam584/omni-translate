> 来源：`录音文件识别-千问.md`
\## Python

```
import os
import time
import requests
import json
\# 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：https://dashscope-intl.aliyuncs.com/api/v1/services/audio/asr/transcription
API\_URL\_SUBMIT = "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription"
\# 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：https://dashscope-intl.aliyuncs.com/api/v1/tasks/
API\_URL\_QUERY\_BASE = "https://dashscope.aliyuncs.com/api/v1/tasks/"
def main():
    # 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
    # 若没有配置环境变量，请用百炼API Key将下行替换为：api\_key = "sk-xxx"
    api\_key = os.getenv("DASHSCOPE\_API\_KEY")
    headers = {
        "Authorization": f"Bearer {api\_key}",
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable"
    }
    # 1. 提交任务
    payload = {
        "model": "qwen3-asr-flash-filetrans",
        "input": {
            "file\_url": "https://dashscope.oss-cn-beijing.aliyuncs.com/audios/welcome.mp3"
        },
        "parameters": {
            "channel\_id": \[0],
            # "language": "zh",
            "enable\_itn": False,
            "enable\_words": True
        }
    }
    print("提交 ASR 转写任务...")
    try:
        submit\_resp = requests.post(API\_URL\_SUBMIT, headers=headers, data=json.dumps(payload))
    except requests.RequestException as e:
        print(f"请求提交任务失败: {e}")
        return
    if submit\_resp.status\_code != 200:
        print(f"任务提交失败! HTTP code: {submit\_resp.status\_code}")
        print(submit\_resp.text)
        return
    resp\_data = submit\_resp.json()
    output = resp\_data.get("output")
    if not output or "task\_id" not in output:
        print("提交返回内容异常:", resp\_data)
        return
    task\_id = output\["task\_id"]
    print(f"任务已提交，task\_id: {task\_id}")
    # 2. 轮询任务状态
    finished = False
    while not finished:
        time.sleep(2)  # 等待 2 秒再查询
        query\_url = API\_URL\_QUERY\_BASE + task\_id
        try:
            query\_resp = requests.get(query\_url, headers=headers)
        except requests.RequestException as e:
            print(f"请求查询任务失败: {e}")
            return
        if query\_resp.status\_code != 200:
            print(f"查询任务失败! HTTP code: {query\_resp.status\_code}")
            print(query\_resp.text)
            return
        query\_data = query\_resp.json()
        output = query\_data.get("output")
        if output and "task\_status" in output:
            status = output\["task\_status"]
            print(f"当前任务状态: {status}")
            if status.upper() in ("SUCCEEDED", "FAILED", "UNKNOWN"):
                finished = True
                print("任务完成，最终结果如下：")
                print(json.dumps(query\_data, indent=2, ensure\_ascii=False))
        else:
            print("查询返回内容:", query\_data)
if \_\_name\_\_ == "\_\_main\_\_":
    main()
```

\## Python SDK

```
import json
import os
import sys
from http import HTTPStatus
import dashscope
from dashscope.audio.qwen\_asr import QwenTranscription
from dashscope.api\_entities.dashscope\_response import TranscriptionResponse
\# run the transcription script
if \_\_name\_\_ == '\_\_main\_\_':
    # 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
    # 若没有配置环境变量，请用百炼API Key将下行替换为：dashscope.api\_key = "sk-xxx"
    dashscope.api\_key = os.getenv("DASHSCOPE\_API\_KEY")
    # 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：https://dashscope-intl.aliyuncs.com/api/v1
    dashscope.base\_http\_api\_url = 'https://dashscope.aliyuncs.com/api/v1'
    task\_response = QwenTranscription.async\_call(
        model='qwen3-asr-flash-filetrans',
        file\_url='https://dashscope.oss-cn-beijing.aliyuncs.com/samples/audio/sensevoice/rich\_text\_example\_1.wav',
        #language="",
        enable\_itn=False,
        enable\_words=True
    )
    print(f'task\_response: {task\_response}')
    print(task\_response.output.task\_id)
    query\_response = QwenTranscription.fetch(task=task\_response.output.task\_id)
    print(f'query\_response: {query\_response}')
    task\_result = QwenTranscription.wait(task=task\_response.output.task\_id)
    print(f'task\_result: {task\_result}')
```

\## 千问3-ASR-Flash
千问3-ASR-Flash模型支持最长5分钟录音。该模型可输入公网可访问的音频文件URL或直接上传本地文件。此外，它可流式返回识别结果。
\## 输入内容：音频文件URL
\## Python SDK

```
import os
import dashscope
\# 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：https://dashscope-intl.aliyuncs.com/api/v1，若使用美国地域的模型，需将url替换为：https://dashscope-us.aliyuncs.com/api/v1
dashscope.base\_http\_api\_url = 'https://dashscope.aliyuncs.com/api/v1'
messages = \[
    {"role": "user", "content": \[{"audio": "https://dashscope.oss-cn-beijing.aliyuncs.com/audios/welcome.mp3"}]}
]
response = dashscope.MultiModalConversation.call(
    # 新加坡/美国地域和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
    # 若没有配置环境变量，请用百炼API Key将下行替换为：api\_key = "sk-xxx"
    api\_key=os.getenv("DASHSCOPE\_API\_KEY"),
    # 若使用美国地域的模型，需在模型后面加上“-us”后缀，例如qwen3-asr-flash-us
    model="qwen3-asr-flash",
    messages=messages,
    result\_format="message",
    asr\_options={
        # "language": "zh", # 可选，若已知音频的语种，可通过该参数指定待识别语种，以提升识别准确率
        "enable\_itn":False
    }
)
print(response)
```

\## Java SDK

```
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import com.alibaba.dashscope.aigc.multimodalconversation.MultiModalConversation;
import com.alibaba.dashscope.aigc.multimodalconversation.MultiModalConversationParam;
import com.alibaba.dashscope.aigc.multimodalconversation.MultiModalConversationResult;
import com.alibaba.dashscope.common.MultiModalMessage;
import com.alibaba.dashscope.common.Role;
import com.alibaba.dashscope.exception.ApiException;
import com.alibaba.dashscope.exception.NoApiKeyException;
import com.alibaba.dashscope.exception.UploadFileException;
import com.alibaba.dashscope.utils.Constants;
import com.alibaba.dashscope.utils.JsonUtils;
public class Main {
    public static void simpleMultiModalConversationCall()
            throws ApiException, NoApiKeyException, UploadFileException {
        MultiModalConversation conv = new MultiModalConversation();
        MultiModalMessage userMessage = MultiModalMessage.builder()
                .role(Role.USER.getValue())
                .content(Arrays.asList(
                        Collections.singletonMap("audio", "https://dashscope.oss-cn-beijing.aliyuncs.com/audios/welcome.mp3")))
                .build();
        Map<String, Object> asrOptions = new HashMap<>();
        asrOptions.put("enable\_itn", false);
        // asrOptions.put("language", "zh"); // 可选，若已知音频的语种，可通过该参数指定待识别语种，以提升识别准确率
        MultiModalConversationParam param = MultiModalConversationParam.builder()
                // 新加坡/美国地域和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
                // 若没有配置环境变量，请用百炼API Key将下行替换为：.apiKey("sk-xxx")
                .apiKey(System.getenv("DASHSCOPE\_API\_KEY"))
                // 若使用美国地域的模型，需在模型后面加上“-us”后缀，例如qwen3-asr-flash-us
                .model("qwen3-asr-flash")
                .message(userMessage)
                .parameter("asr\_options", asrOptions)
                .build();
        MultiModalConversationResult result = conv.call(param);
        System.out.println(JsonUtils.toJson(result));
    }
    public static void main(String\[] args) {
        try {
            // 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：https://dashscope-intl.aliyuncs.com/api/v1，若使用美国地域的模型，需将url替换为：https://dashscope-us.aliyuncs.com/api/v1
            Constants.baseHttpApiUrl = "https://dashscope.aliyuncs.com/api/v1";
            simpleMultiModalConversationCall();
        } catch (ApiException | NoApiKeyException | UploadFileException e) {
            System.out.println(e.getMessage());
        }
        System.exit(0);
    }
}
```

\## cURL

```
\# ======= 重要提示 =======
\# 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation，若使用美国地域的模型，需将url替换为：https://dashscope-us.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
\# 新加坡/美国地域和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
\# 若使用美国地域的模型，需要加us后缀
\# === 执行时请删除该注释 ===
curl -X POST "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation" \\
\-H "Authorization: Bearer $DASHSCOPE\_API\_KEY" \\
\-H "Content-Type: application/json" \\
\-d '{
    "model": "qwen3-asr-flash",
    "input": {
        "messages": \[
            {
                "content": \[
                    {
                        "text": ""
                    }
                ],
                "role": "system"
            },
            {
                "content": \[
                    {
                        "audio": "https://dashscope.oss-cn-beijing.aliyuncs.com/audios/welcome.mp3"
                    }
                ],
                "role": "user"
            }
        ]
    },
    "parameters": {
        "asr\_options": {
            "enable\_itn": false
        }
    }
}'
```

\## 输入内容：Base64编码的音频文件
可输入Base64编码数据（\[Data URL](https://www.rfc-editor.org/rfc/rfc2397)），格式为：`data:<mediatype>;base64,<data>`。
\-   `<mediatype>`：MIME类型
    因音频格式而异，例如：
    -   WAV：`audio/wav`
    -   MP3：`audio/mpeg`
\-   `<data>`：音频转成的Base64编码的字符串
    Base64编码会增大体积，请控制原文件大小，确保编码后仍符合输入音频大小限制（10MB）
\-   示例：`data:audio/wav;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4LjI5LjEwMAAAAAAAAAAAAAAA//PAxABQ/BXRbMPe4IQAhl9`
    \*\*点击查看示例代码\*\*
    Python

    ```
    import base64, pathlib
    # input.mp3为用于声音复刻的本地音频文件，请替换为自己的音频文件路径，确保其符合音频要求
    file\_path = pathlib.Path("input.mp3")
    base64\_str = base64.b64encode(file\_path.read\_bytes()).decode()
    data\_uri = f"data:audio/mpeg;base64,{base64\_str}"
    ```

    Java

    ```
    import java.nio.file.\*;
    import java.util.Base64;
    public class Main {
        /\*\*
         \* filePath为用于声音复刻的本地音频文件，请替换为自己的音频文件路径，确保其符合音频要求
         \*/
        public static String toDataUrl(String filePath) throws Exception {
            byte\[] bytes = Files.readAllBytes(Paths.get(filePath));
            String encoded = Base64.getEncoder().encodeToString(bytes);
            return "data:audio/mpeg;base64," + encoded;
        }
        // 使用示例
        public static void main(String\[] args) throws Exception {
            System.out.println(toDataUrl("input.mp3"));
        }
    }
    ```

\## Python SDK
示例中用到的音频文件为：\[welcome.mp3](https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20260105/wotsae/welcome.mp3)。

```
import base64
import dashscope
import os
import pathlib
\# 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：https://dashscope-intl.aliyuncs.com/api/v1，若使用美国地域的模型，需将url替换为：https://dashscope-us.aliyuncs.com/api/v1
dashscope.base\_http\_api\_url = 'https://dashscope.aliyuncs.com/api/v1'
\# 请替换为实际的音频文件路径
file\_path = "welcome.mp3"
\# 请替换为实际的音频文件MIME类型
audio\_mime\_type = "audio/mpeg"
file\_path\_obj = pathlib.Path(file\_path)
if not file\_path\_obj.exists():
    raise FileNotFoundError(f"音频文件不存在: {file\_path}")
base64\_str = base64.b64encode(file\_path\_obj.read\_bytes()).decode()
data\_uri = f"data:{audio\_mime\_type};base64,{base64\_str}"
messages = \[
    {"role": "user", "content": \[{"audio": data\_uri}]}
]
response = dashscope.MultiModalConversation.call(
    # 新加坡/美国地域和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
    # 若没有配置环境变量，请用百炼API Key将下行替换为：api\_key = "sk-xxx",
    api\_key=os.getenv("DASHSCOPE\_API\_KEY"),
    # 若使用美国地域的模型，需在模型后面加上“-us”后缀，例如qwen3-asr-flash-us
    model="qwen3-asr-flash",
    messages=messages,
    result\_format="message",
    asr\_options={
        # "language": "zh", # 可选，若已知音频的语种，可通过该参数指定待识别语种，以提升识别准确率
        "enable\_itn":False
    }
)
print(response)
```

---
*← 返回 [README](./README.md)*
