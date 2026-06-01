> 来源：`录音文件识别-Fun-ASR-Paraformer-SenseVoice.md`
\## Java

```
import com.alibaba.dashscope.audio.asr.transcription.\*;
import com.google.gson.\*;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Arrays;
import java.util.List;
public class Main {
    public static void main(String\[] args) {
        // 创建转写请求参数
        TranscriptionParam param =
                TranscriptionParam.builder()
                        // 获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
                        // 若没有配置环境变量，请用百炼API Key将下行替换为：.apiKey("sk-xxx")
                        .apiKey(System.getenv("DASHSCOPE\_API\_KEY"))
                        .model("paraformer-v2")
                        // language\_hints为可选参数，用于指定待识别音频的语言代码。仅Paraformer系列的paraformer-v2模型支持该参数，取值范围请参见API参考文档。
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
                "content\_duration\_in\_milliseconds": 4720,
                "text": "Hello world, 这里是阿里巴巴语音实验室。",
                "sentences": \[
                    {
                        "begin\_time": 0,
                        "end\_time": 4720,
                        "text": "Hello world, 这里是阿里巴巴语音实验室。",
                        "sentence\_id": 1,
                        "words": \[
                            {
                                "begin\_time": 0,
                                "end\_time": 629,
                                "text": "Hello ",
                                "punctuation": ""
                            },
                            {
                                "begin\_time": 629,
                                "end\_time": 944,
                                "text": "world",
                                "punctuation": ", "
                            },
                            {
                                "begin\_time": 944,
                                "end\_time": 1258,
                                "text": "这",
                                "punctuation": ""
                            },
                            {
                                "begin\_time": 1258,
                                "end\_time": 1573,
                                "text": "里",
                                "punctuation": ""
                            },
                            {
                                "begin\_time": 1573,
                                "end\_time": 1888,
                                "text": "是",
                                "punctuation": ""
                            },
                            {
                                "begin\_time": 1888,
                                "end\_time": 2202,
                                "text": "阿",
                                "punctuation": ""
                            },
                            {
                                "begin\_time": 2202,
                                "end\_time": 2517,
                                "text": "里",
                                "punctuation": ""
                            },
                            {
                                "begin\_time": 2517,
                                "end\_time": 2832,
                                "text": "巴",
                                "punctuation": ""
                            },
                            {
                                "begin\_time": 2832,
                                "end\_time": 3146,
                                "text": "巴",
                                "punctuation": ""
                            },
                            {
                                "begin\_time": 3146,
                                "end\_time": 3461,
                                "text": "语",
                                "punctuation": ""
                            },
                            {
                                "begin\_time": 3461,
                                "end\_time": 3776,
                                "text": "音",
                                "punctuation": ""
                            },
                            {
                                "begin\_time": 3776,
                                "end\_time": 4090,
                                "text": "实",
                                "punctuation": ""
                            },
                            {
                                "begin\_time": 4090,
                                "end\_time": 4405,
                                "text": "验",
                                "punctuation": ""
                            },
                            {
                                "begin\_time": 4405,
                                "end\_time": 4720,
                                "text": "室",
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
                "content\_duration\_in\_milliseconds": 3720,
                "text": "Hello word, 这里是阿里巴巴语音实验室。",
                "sentences": \[
                    {
                        "begin\_time": 100,
                        "end\_time": 3820,
                        "text": "Hello word, 这里是阿里巴巴语音实验室。",
                        "sentence\_id": 1,
                        "words": \[
                            {
                                "begin\_time": 100,
                                "end\_time": 596,
                                "text": "Hello ",
                                "punctuation": ""
                            },
                            {
                                "begin\_time": 596,
                                "end\_time": 844,
                                "text": "word",
                                "punctuation": ", "
                            },
                            {
                                "begin\_time": 844,
                                "end\_time": 1092,
                                "text": "这",
                                "punctuation": ""
                            },
                            {
                                "begin\_time": 1092,
                                "end\_time": 1340,
                                "text": "里",
                                "punctuation": ""
                            },
                            {
                                "begin\_time": 1340,
                                "end\_time": 1588,
                                "text": "是",
                                "punctuation": ""
                            },
                            {
                                "begin\_time": 1588,
                                "end\_time": 1836,
                                "text": "阿",
                                "punctuation": ""
                            },
                            {
                                "begin\_time": 1836,
                                "end\_time": 2084,
                                "text": "里",
                                "punctuation": ""
                            },
                            {
                                "begin\_time": 2084,
                                "end\_time": 2332,
                                "text": "巴",
                                "punctuation": ""
                            },
                            {
                                "begin\_time": 2332,
                                "end\_time": 2580,
                                "text": "巴",
                                "punctuation": ""
                            },
                            {
                                "begin\_time": 2580,
                                "end\_time": 2828,
                                "text": "语",
                                "punctuation": ""
                            },
                            {
                                "begin\_time": 2828,
                                "end\_time": 3076,
                                "text": "音",
                                "punctuation": ""
                            },
                            {
                                "begin\_time": 3076,
                                "end\_time": 3324,
                                "text": "实",
                                "punctuation": ""
                            },
                            {
                                "begin\_time": 3324,
                                "end\_time": 3572,
                                "text": "验",
                                "punctuation": ""
                            },
                            {
                                "begin\_time": 3572,
                                "end\_time": 3820,
                                "text": "室",
                                "punctuation": "。"
                            }
                        ]
                    }
                ]
            }
        ]
    }
    ```

\## \*\*API参考\*\*
\-   \[Fun-ASR录音文件识别API参考](https://help.aliyun.com/zh/model-studio/fun-asr-recorded-speech-recognition-api-reference/)
\-   \[Paraformer录音文件识别API参考](https://help.aliyun.com/zh/model-studio/paraformer-recorded-speech-recognition-api-reference/)
\-   \[SenseVoice录音文件识别API参考](https://help.aliyun.com/zh/model-studio/sensevoice-speech-recognition/)
\## \*\*模型应用上架及备案\*\*
参见\[应用合规备案](https://help.aliyun.com/zh/model-studio/compliance-and-launch-filing-guide-for-ai-apps-powered-by-the-tongyi-model)。
\## \*\*模型功能特性对比\*\*

| \*\*功能/特性\*\* | \*\*Fun-ASR\*\* | \*\*Paraformer\*\* | \*\*SenseVoice（即将下线）\*\* |
| \*\*支持语言\*\* | 因模型而异： - fun-asr、fun-asr-2025-11-07：中文（普通话、粤语、吴语、闽南语、客家话、赣语、湘语、晋语；并支持中原、西南、冀鲁、江淮、兰银、胶辽、东北、北京、港台等，包括河南、陕西、湖北、四川、重庆、云南、贵州、广东、广西、河北、天津、山东、安徽、南京、江苏、杭州、甘肃、宁夏等地区官话口音）、英文、日语 - fun-asr-2025-08-25：中文（普通话）、英文 - fun-asr-mtl、fun-asr-mtl-2025-08-25：中文（普通话、粤语）、英文、日语、韩语、越南语、印尼语、泰语、马来语、菲律宾语、阿拉伯语、印地语、保加利亚语、克罗地亚语、捷克语、丹麦语、荷兰语、爱沙尼亚语、芬兰语、希腊语、匈牙利语、爱尔兰语、拉脱维亚语、立陶宛语、马耳他语、波兰语、葡萄牙语、罗马尼亚语、斯洛伐克语、斯洛文尼亚语、瑞典语 | 因模型而异： - paraformer-v2：中文（普通话、粤语、吴语、闽南语、东北话、甘肃话、贵州话、河南话、湖北话、湖南话、宁夏话、山西话、陕西话、山东话、四川话、天津话、江西话、云南话、上海话）、英文、日语、韩语、德语、法语、俄语 - paraformer-8k-v2：中文普通话 - paraformer-v1：中文普通话、英文 - paraformer-8k-v1：中文普通话 - paraformer-mtl-v1：中文（普通话、粤语、吴语、闽南语、东北话、甘肃话、贵州话、河南话、湖北话、湖南话、宁夏话、山西话、陕西话、山东话、四川话、天津话）、英文、日语、韩语、西班牙语、印尼语、法语、德语、意大利语、马来语 | - 重点语言：中文、英文、粤语、日语、韩语、俄语、法语、意大利语、德语、西班牙语 - 更多语言：加泰罗尼亚语、印度尼西亚语、泰语、荷兰语、葡萄牙语、捷克语、波兰语等，详情请参见\[语言列表](https://help.aliyun.com/zh/model-studio/sensevoice-recorded-speech-recognition-java-sdk#7a65158a77hpf) |
| \*\*支持的音频格式\*\* | aac、amr、avi、flac、flv、m4a、mkv、mov、mp3、mp4、mpeg、ogg、opus、wav、webm、wma、wmv | aac、amr、avi、flac、flv、m4a、mkv、mov、mp3、mp4、mpeg、ogg、opus、wav、webm、wma、wmv | aac、amr、avi、flac、flv、m4a、mkv、mov、mp3、mp4、mpeg、ogg、opus、wav、webm、wma、wmv |
| \*\*采样率\*\* | 任意  | 因模型而异： - paraformer-v2、paraformer-v1：任意 - paraformer-8k-v2、paraformer-8k-v1：8kHz - paraformer-mtl-v1：16kHz及以上 | 任意  |
| \*\*声道\*\* | 任意  |   |   |
| \*\*输入形式\*\* | 公网可访问的待识别文件URL，最多支持输入100个音频 |   |   |
| \*\*音频大小/时长\*\* | 每个音频文件大小不超过2GB，且时长不超过12小时 |   | 每个音频文件大小不超过2GB，时长无限制 |
| \*\*情感识别\*\* | 不支持 |   | 支持 固定开启 |
| \*\*时间戳\*\* | 支持 固定开启 | 支持 默认关闭，可开启 | 支持 固定开启 |
| \*\*标点符号预测\*\* | 支持 固定开启 |   |   |
| \*\*热词\*\* | 支持 可配置 \*\*重要\*\* 新加坡地域的子业务空间暂不支持热词功能。 |   | 不支持 |
| \*\*ITN\*\* | 支持 固定开启 |   |   |
| \*\*歌唱识别\*\* | 支持 仅fun-asr和fun-asr-2025-11-07支持该功能 | 不支持 |   |
| \*\*噪声拒识\*\* | 支持 固定开启 |   | 不支持 |
| \*\*敏感词过滤\*\* | 支持 默认过滤\[阿里云百炼敏感词表](https://dashscope.oss-cn-beijing.aliyuncs.com/samples/audio/paraformer/%E7%99%BE%E7%82%BC%E6%95%8F%E6%84%9F%E8%AF%8D%E5%88%97%E8%A1%A8\_20230716.words.txt)中的内容，更多内容过滤需自定义 |   | 不支持 |
| \*\*说话人分离\*\* | 支持 默认关闭，可开启 |   | 不支持 |
| \*\*语气词过滤\*\* | 不支持 | 支持 默认关闭，可开启 | 不支持 |
| \*\*VAD\*\* | 支持 固定开启 |   | 不支持 |
| \*\*限流（RPS）\*\* | 提交作业接口：10 任务查询接口：20 | 提交作业接口（因模型而异）： - paraformer-v2、paraformer-8k-v2：20 - paraformer-v1、paraformer-8k-v1、paraformer-mtl-v1：10 任务查询接口：20 | 提交作业接口：10 任务查询接口：20 |
| \*\*接入方式\*\* | DashScope：Java/Python/Android/iOS SDK、RESTful API |   | DashScope：Java/Python SDK、RESTful API |
| \*\*价格\*\* | 中国内地：0.00022元/秒 国际：0.00026元/秒 | 中国内地：0.00008元/秒 | 中国内地：0.0007 元/秒 |

\## 常见问题
\### \*\*Q：如何提升识别准确率？\*\*
需综合考虑影响因素并采取相应措施。
主要影响因素：
1\.  声音质量：录音设备、采样率及环境噪声影响清晰度（高质量音频是基础）
2\.  说话人特征：音调、语速、口音和方言差异（尤其少见方言或重口音）增加识别难度
3\.  语言和词汇：多语言混合、专业术语或俚语提升识别难度（热词配置可优化）
4\.  上下文理解：缺乏上下文易导致语义歧义（尤其在依赖前后文才能正确识别的语境中）
优化方法：
1\.  优化音频质量：使用高性能麦克风及推荐采样率设备；减少环境噪声与回声
2\.  适配说话人：针对显著口音/方言场景，选用支持方言的模型
3\.  配置热词：为专业术语、专有名词等设置热词（参见\[定制热词](https://help.aliyun.com/zh/model-studio/custom-hot-words/)）
4\.  保留上下文：避免过短音频分段
/\\\* 让引用上下间距调小，避免内容显示过于稀疏 \\\*/ .unionContainer .markdown-body blockquote { margin: 4px 0; } .aliyun-docs-content table.qwen blockquote { border-left: none; /\\\* 添加这一行来移除表格里的引用文字的左侧边框 \\\*/ padding-left: 5px; /\\\* 左侧内边距 \\\*/ margin: 4px 0; }
 span.aliyun-docs-icon { color: transparent !important; font-size: 0 !important; } span.aliyun-docs-icon:before { color: black; font-size: 16px; } span.aliyun-docs-icon.icon-size-20:before { font-size: 20px; } span.aliyun-docs-icon.icon-size-22:before { font-size: 22px; } span.aliyun-docs-icon.icon-size-24:before { font-size: 24px; } span.aliyun-docs-icon.icon-size-26:before { font-size: 26px; } span.aliyun-docs-icon.icon-size-28:before { font-size: 28px; }
---
*← 返回 [README](./README.md)*
