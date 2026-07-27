> 来源：`语音合成-千问.md`
\## Gradle
在`build.gradle`中添加如下内容：

```
// https://mvnrepository.com/artifact/com.google.code.gson/gson
implementation("com.google.code.gson:gson:2.13.1")
```

```
import com.alibaba.dashscope.aigc.multimodalconversation.AudioParameters;
import com.alibaba.dashscope.aigc.multimodalconversation.MultiModalConversation;
import com.alibaba.dashscope.aigc.multimodalconversation.MultiModalConversationParam;
import com.alibaba.dashscope.aigc.multimodalconversation.MultiModalConversationResult;
import com.alibaba.dashscope.exception.ApiException;
import com.alibaba.dashscope.exception.NoApiKeyException;
import com.alibaba.dashscope.exception.UploadFileException;
import com.alibaba.dashscope.protocol.Protocol;
import com.alibaba.dashscope.utils.Constants;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.URL;
public class Main {
    // 如需使用指令控制功能，请将MODEL替换为qwen3-tts-instruct-flash
    private static final String MODEL = "qwen3-tts-flash";
    public static void call() throws ApiException, NoApiKeyException, UploadFileException {
        MultiModalConversation conv = new MultiModalConversation();
        MultiModalConversationParam param = MultiModalConversationParam.builder()
                // 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
                // 若没有配置环境变量，请用百炼API Key将下行替换为：.apiKey("sk-xxx")
                .apiKey(System.getenv("DASHSCOPE\_API\_KEY"))
                .model(MODEL)
                .text("Today is a wonderful day to build something people love!")
                .voice(AudioParameters.Voice.CHERRY)
                .languageType("English") // 建议与文本语种一致，以获得正确的发音和自然的语调。
                // 如需使用指令控制功能，请取消下方注释，并将model替换为qwen3-tts-instruct-flash
                // .parameter("instructions","语速较快，带有明显的上扬语调，适合介绍时尚产品。")
                // .parameter("optimize\_instructions",true)
                .build();
        MultiModalConversationResult result = conv.call(param);
        String audioUrl = result.getOutput().getAudio().getUrl();
        System.out.print(audioUrl);
        // 下载音频文件到本地
        try (InputStream in = new URL(audioUrl).openStream();
             FileOutputStream out = new FileOutputStream("downloaded\_audio.wav")) {
            byte\[] buffer = new byte\[1024];
            int bytesRead;
            while ((bytesRead = in.read(buffer)) != -1) {
                out.write(buffer, 0, bytesRead);
            }
            System.out.println("\\n音频文件已下载到本地: downloaded\_audio.wav");
        } catch (Exception e) {
            System.out.println("\\n下载音频文件时出错: " + e.getMessage());
        }
    }
    public static void main(String\[] args) {
        try {
            // 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：https://dashscope-intl.aliyuncs.com/api/v1
            Constants.baseHttpApiUrl = "https://dashscope.aliyuncs.com/api/v1";
            call();
        } catch (ApiException | NoApiKeyException | UploadFileException e) {
            System.out.println(e.getMessage());
        }
        System.exit(0);
    }
}
```

---
*← 返回 [README](./README.md)*
