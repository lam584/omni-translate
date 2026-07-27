> 来源：`录音文件识别-Fun-ASR-Paraformer-SenseVoice.md`
\## Java

```
import com.alibaba.dashscope.audio.asr.transcription.\*;
import com.alibaba.dashscope.utils.Constants;
import com.google.gson.\*;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Arrays;
import java.util.List;
public class Main {
    public static void main(String\[] args) {
        // 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：https://dashscope-intl.aliyuncs.com/api/v1
        Constants.baseHttpApiUrl = "https://dashscope.aliyuncs.com/api/v1";
        // 创建转写请求参数。
        TranscriptionParam param =
                TranscriptionParam.builder()
                        // 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
                        // 若没有配置环境变量，请用百炼API Key将下行替换为：.apiKey("sk-xxx")
                        .apiKey(System.getenv("DASHSCOPE\_API\_KEY"))
                        .model("fun-asr")
                        // language\_hints为可选参数，用于指定待识别音频的语言代码。取值范围请参见API参考文档。
                        .parameter("language\_hints", new String\[]{"zh", "en"})
                        .fileUrls(
                                Arrays.asList(
                                        "https://dashscope.oss-cn-beijing.aliyuncs.com/samples/audio/paraformer/hello\_world\_female2.wav",
                                        "https://dashscope.oss-cn-beijing.aliyuncs.com/samples/audio/paraformer/hello\_world\_male2.wav"))
                        .build();
        try {
            Transcription transcription = new Transcription();
            // 提交转写请求
            TranscriptionResult result = transcription.asyncCall(param);
            System.out.println("RequestId: " + result.getRequestId());
            // 阻塞等待任务完成并获取结果
            result = transcription.wait(
                    TranscriptionQueryParam.FromTranscriptionParam(param, result.getTaskId()));
            // 获取转写结果
            List<TranscriptionTaskResult> taskResultList = result.getResults();
            if (taskResultList != null \&\& taskResultList.size() > 0) {
                for (TranscriptionTaskResult taskResult : taskResultList) {
                    String transcriptionUrl = taskResult.getTranscriptionUrl();
                    HttpURLConnection connection =
                            (HttpURLConnection) new URL(transcriptionUrl).openConnection();
                    connection.setRequestMethod("GET");
                    connection.connect();
                    BufferedReader reader =
                            new BufferedReader(new InputStreamReader(connection.getInputStream()));
                    Gson gson = new GsonBuilder().setPrettyPrinting().create();
                    JsonElement jsonResult = gson.fromJson(reader, JsonObject.class);
                    System.out.println(gson.toJson(jsonResult));
                }
            }
        } catch (Exception e) {
            System.out.println("error: " + e);
        }
        System.exit(0);
    }
}
```

完整的识别结果会以JSON格式打印在控制台。完整结果包含转换后的文本以及文本在音视频文件中的起始、结束时间（以毫秒为单位）。
\-   第一个结果

    ```
    {
        "file\_url": "https://dashscope.oss-cn-beijing.aliyuncs.com/samples/audio/paraformer/hello\_world\_female2.wav",
        "properties": {
            "audio\_format": "pcm\_s16le",
            "channels": \[
                0
            ],
            "original\_sampling\_rate": 16000,
            "original\_duration\_in\_milliseconds": 3834
        },
        "transcripts": \[
            {
                "channel\_id": 0,
                "content\_duration\_in\_milliseconds": 2480,
                "text": "Hello World，这里是阿里巴巴语音实验室。",
                "sentences": \[
                    {
                        "begin\_time": 760,
                        "end\_time": 3240,
                        "text": "Hello World，这里是阿里巴巴语音实验室。",
                        "sentence\_id": 1,
                        "words": \[
                            {
                                "begin\_time": 760,
                                "end\_time": 1000,
                                "text": "Hello",
                                "punctuation": ""
                            },
                            {
                                "begin\_time": 1000,
                                "end\_time": 1120,
                                "text": " World",
                                "punctuation": "，"
                            },
                            {
                                "begin\_time": 1400,
                                "end\_time": 1920,
                                "text": "这里是",
                                "punctuation": ""
                            },
                            {
                                "begin\_time": 1920,
                                "end\_time": 2520,
                                "text": "阿里巴巴",
                                "punctuation": ""
                            },
                            {
                                "begin\_time": 2520,
                                "end\_time": 2840,
                                "text": "语音",
                                "punctuation": ""
                            },
                            {
                                "begin\_time": 2840,
                                "end\_time": 3240,
                                "text": "实验室",
                                "punctuation": "。"
                            }
                        ]
                    }
                ]
            }
        ]
    }
    ```

\-   第二个结果

    ```
    {
        "file\_url": "https://dashscope.oss-cn-beijing.aliyuncs.com/samples/audio/paraformer/hello\_world\_male2.wav",
        "properties": {
            "audio\_format": "pcm\_s16le",
            "channels": \[
                0
            ],
            "original\_sampling\_rate": 16000,
            "original\_duration\_in\_milliseconds": 4726
        },
        "transcripts": \[
            {
                "channel\_id": 0,
                "content\_duration\_in\_milliseconds": 3800,
                "text": "Hello World，这里是阿里巴巴语音实验室。",
                "sentences": \[
                    {
                        "begin\_time": 680,
                        "end\_time": 4480,
                        "text": "Hello World，这里是阿里巴巴语音实验室。",
                        "sentence\_id": 1,
                        "words": \[
                            {
                                "begin\_time": 680,
                                "end\_time": 960,
                                "text": "Hello",
                                "punctuation": ""
                            },
                            {
                                "begin\_time": 960,
                                "end\_time": 1080,
                                "text": " World",
                                "punctuation": "，"
                            },
                            {
                                "begin\_time": 1480,
                                "end\_time": 2160,
                                "text": "这里是",
                                "punctuation": ""
                            },
                            {
                                "begin\_time": 2160,
                                "end\_time": 3080,
                                "text": "阿里巴巴",
                                "punctuation": ""
                            },
                            {
                                "begin\_time": 3080,
                                "end\_time": 3520,
                                "text": "语音",
                                "punctuation": ""
                            },
                            {
                                "begin\_time": 3520,
                                "end\_time": 4480,
                                "text": "实验室",
                                "punctuation": "。"
                            }
                        ]
                    }
                ]
            }
        ]
    }
    ```

---
*← 返回 [README](./README.md)*
