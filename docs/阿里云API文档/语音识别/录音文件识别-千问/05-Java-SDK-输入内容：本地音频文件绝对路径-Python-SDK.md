> 来源：`录音文件识别-千问.md`
\## Java SDK

```
import com.alibaba.dashscope.audio.qwen\_asr.\*;
import com.alibaba.dashscope.utils.Constants;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashMap;
public class Main {
    public static void main(String\[] args) {
        // 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：https://dashscope-intl.aliyuncs.com/api/v1
        Constants.baseHttpApiUrl = "https://dashscope.aliyuncs.com/api/v1";
        QwenTranscriptionParam param =
                QwenTranscriptionParam.builder()
                        // 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
                        // 若没有配置环境变量，请用百炼API Key将下行替换为：.apiKey("sk-xxx")
                        .apiKey(System.getenv("DASHSCOPE\_API\_KEY"))
                        .model("qwen3-asr-flash-filetrans")
                        .fileUrl("https://dashscope.oss-cn-beijing.aliyuncs.com/samples/audio/sensevoice/rich\_text\_example\_1.wav")
                        //.parameter("language", "zh")
                        //.parameter("channel\_id", new ArrayList<String>(){{add("0");add("1");}})
                        .parameter("enable\_itn", false)
                        .parameter("enable\_words", true)
                        .build();
        try {
            QwenTranscription transcription = new QwenTranscription();
            // 提交任务
            QwenTranscriptionResult result = transcription.asyncCall(param);
            System.out.println("create task result: " + result);
            // 查询任务状态
            result = transcription.fetch(QwenTranscriptionQueryParam.FromTranscriptionParam(param, result.getTaskId()));
            System.out.println("task status: " + result);
            // 等待任务完成
            result =
                    transcription.wait(
                            QwenTranscriptionQueryParam.FromTranscriptionParam(param, result.getTaskId()));
            System.out.println("task result: " + result);
            // 获取语音识别结果
            QwenTranscriptionTaskResult taskResult = result.getResult();
            if (taskResult != null) {
                // 获取识别结果的url
                String transcriptionUrl = taskResult.getTranscriptionUrl();
                // 获取url内对应的结果
                HttpURLConnection connection =
                        (HttpURLConnection) new URL(transcriptionUrl).openConnection();
                connection.setRequestMethod("GET");
                connection.connect();
                BufferedReader reader =
                        new BufferedReader(new InputStreamReader(connection.getInputStream()));
                // 格式化输出json结果
                Gson gson = new GsonBuilder().setPrettyPrinting().create();
                System.out.println(gson.toJson(gson.fromJson(reader, JsonObject.class)));
            }
        } catch (Exception e) {
            System.out.println("error: " + e);
        }
    }
}
```

\## 输入内容：本地音频文件绝对路径
使用DashScope SDK处理本地图像文件时，需要传入文件路径。请您参考下表，结合您的使用方式与操作系统进行文件路径的创建。

| \*\*系统\*\* | \*\*SDK\*\* | \*\*传入的文件路径\*\* | \*\*示例\*\* |
| --- | --- | --- | --- |
| Linux或macOS系统 | Python SDK | file://{文件的绝对路径} | file:///home/images/test.png |
| Java SDK |
| Windows系统 | Python SDK | file://{文件的绝对路径} | file://D:/images/test.png |
| Java SDK | file:///{文件的绝对路径} | file:///D:images/test.png |

\*\*重要\*\*
使用本地文件时，接口调用上限为 100 QPS，且不支持扩容，请勿用于生产环境、高并发及压测场景；如需更高并发，建议将文件上传至 OSS 并通过录音文件 URL 方式调用。
\## Python SDK
示例中用到的音频文件为：\[welcome.mp3](https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20260105/wotsae/welcome.mp3)。

```
import os
import dashscope
\# 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：https://dashscope-intl.aliyuncs.com/api/v1，若使用美国地域的模型，需将url替换为：https://dashscope-us.aliyuncs.com/api/v1
dashscope.base\_http\_api\_url = 'https://dashscope.aliyuncs.com/api/v1'
\# 请用您的本地音频的绝对路径替换 ABSOLUTE\_PATH/welcome.mp3
audio\_file\_path = "file://ABSOLUTE\_PATH/welcome.mp3"
messages = \[
    {"role": "user", "content": \[{"audio": audio\_file\_path}]}
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
