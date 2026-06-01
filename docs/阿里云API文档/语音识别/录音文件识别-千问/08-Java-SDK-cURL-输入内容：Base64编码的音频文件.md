> 来源：`录音文件识别-千问.md`
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
import io.reactivex.Flowable;
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
        Flowable<MultiModalConversationResult> resultFlowable = conv.streamCall(param);
        resultFlowable.blockingForEach(item -> {
            try {
                System.out.println(item.getOutput().getChoices().get(0).getMessage().getContent().get(0).get("text"));
            } catch (Exception e){
                System.exit(0);
            }
        });
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
\# 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions
\# 新加坡地域和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
\# === 执行时请删除该注释 ===
curl -X POST 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions' \\
\-H "Authorization: Bearer $DASHSCOPE\_API\_KEY" \\
\-H "Content-Type: application/json" \\
\-d '{
    "model": "qwen3-asr-flash",
    "messages": \[
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
    "stream":false,
    "asr\_options": {
        "enable\_itn": false
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

---
*← 返回 [README](./README.md)*
