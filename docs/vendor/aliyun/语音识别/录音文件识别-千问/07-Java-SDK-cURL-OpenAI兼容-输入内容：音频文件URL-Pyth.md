> 来源：`录音文件识别-千问.md`
\## Java SDK
示例中用到的音频文件为：\[welcome.mp3](https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20260105/wotsae/welcome.mp3)。

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
        // 请用您本地文件的绝对路径替换掉ABSOLUTE\_PATH/welcome.mp3
        String localFilePath = "file://ABSOLUTE\_PATH/welcome.mp3";
        MultiModalConversation conv = new MultiModalConversation();
        MultiModalMessage userMessage = MultiModalMessage.builder()
                .role(Role.USER.getValue())
                .content(Arrays.asList(
                        Collections.singletonMap("audio", localFilePath)))
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
\-H "X-DashScope-SSE: enable" \\
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
        "incremental\_output": true,
        "asr\_options": {
            "enable\_itn": false
        }
    }
}'
```

\## OpenAI兼容
仅千问3-ASR-Flash系列模型支持OpenAI兼容方式调用。OpenAI兼容方式仅允许输入公网可访问的音频文件URL，不支持输入本地音频文件绝对路径。
OpenAI Python SDK 版本应不低于1.52.0， Node.js SDK 版本应不低于 4.68.0。
`asr\_options`非OpenAI标准参数，若使用OpenAI SDK，请通过`extra\_body`传入。
\## 输入内容：音频文件URL
\## Python SDK

```
from openai import OpenAI
import os
try:
    client = OpenAI(
        # 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
        # 若没有配置环境变量，请用百炼API Key将下行替换为：api\_key = "sk-xxx",
        api\_key=os.getenv("DASHSCOPE\_API\_KEY"),
        # 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：https://dashscope-intl.aliyuncs.com/compatible-mode/v1
        base\_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
    )
    stream\_enabled = False  # 是否开启流式输出
    completion = client.chat.completions.create(
        model="qwen3-asr-flash",
        messages=\[
            {
                "content": \[
                    {
                        "type": "input\_audio",
                        "input\_audio": {
                            "data": "https://dashscope.oss-cn-beijing.aliyuncs.com/audios/welcome.mp3"
                        }
                    }
                ],
                "role": "user"
            }
        ],
        stream=stream\_enabled,
        # stream设为False时，不能设置stream\_options参数
        # stream\_options={"include\_usage": True},
        extra\_body={
            "asr\_options": {
                # "language": "zh",
                "enable\_itn": False
            }
        }
    )
    if stream\_enabled:
        full\_content = ""
        print("流式输出内容为：")
        for chunk in completion:
            # 如果stream\_options.include\_usage为True，则最后一个chunk的choices字段为空列表，需要跳过（可以通过chunk.usage获取 Token 使用量）
            print(chunk)
            if chunk.choices and chunk.choices\[0].delta.content:
                full\_content += chunk.choices\[0].delta.content
        print(f"完整内容为：{full\_content}")
    else:
        print(f"非流式输出内容为：{completion.choices\[0].message.content}")
except Exception as e:
    print(f"错误信息：{e}")
```

---
*← 返回 [README](./README.md)*
