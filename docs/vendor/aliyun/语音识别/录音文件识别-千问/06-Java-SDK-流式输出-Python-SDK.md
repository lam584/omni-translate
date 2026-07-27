> 来源：`录音文件识别-千问.md`
\## Java SDK
示例中用到的音频文件为：\[welcome.mp3](https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20260105/wotsae/welcome.mp3)。

```
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.\*;
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
    // 请替换为实际的音频文件路径
    private static final String AUDIO\_FILE = "welcome.mp3";
    // 请替换为实际的音频文件MIME类型
    private static final String AUDIO\_MIME\_TYPE = "audio/mpeg";
    public static void simpleMultiModalConversationCall()
            throws ApiException, NoApiKeyException, UploadFileException, IOException {
        MultiModalConversation conv = new MultiModalConversation();
        MultiModalMessage userMessage = MultiModalMessage.builder()
                .role(Role.USER.getValue())
                .content(Arrays.asList(
                        Collections.singletonMap("audio", toDataUrl())))
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
        } catch (ApiException | NoApiKeyException | UploadFileException | IOException e) {
            System.out.println(e.getMessage());
        }
        System.exit(0);
    }
    // 生成 data URI
    public static String toDataUrl() throws IOException {
        byte\[] bytes = Files.readAllBytes(Paths.get(AUDIO\_FILE));
        String encoded = Base64.getEncoder().encodeToString(bytes);
        return "data:" + AUDIO\_MIME\_TYPE + ";base64," + encoded;
    }
}
```

\## 流式输出
模型并不是一次性生成最终结果，而是逐步地生成中间结果，最终结果由中间结果拼接而成。使用非流式输出方式需要等待模型生成结束后再将生成的中间结果拼接后返回，而流式输出可以实时地将中间结果返回，您可以在模型进行输出的同时进行阅读，减少等待模型回复的时间。您可以根据调用方式来设置不同的参数以实现流式输出：
\-   DashScope Python SDK方式：设置`stream`参数为true。
\-   DashScope Java SDK方式：需要通过`streamCall`接口调用。
\-   DashScope HTTP方式：需要在Header中指定`X-DashScope-SSE`为`enable`。
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
    },
    stream=True
)
for response in response:
    try:
        print(response\["output"]\["choices"]\[0]\["message"].content\[0]\["text"])
    except:
        pass
```

---
*← 返回 [README](./README.md)*
