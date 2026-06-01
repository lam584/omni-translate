> 来源：`录音文件识别-Fun-ASR-Paraformer-SenseVoice.md`
\## SenseVoice
由于音视频文件的尺寸通常较大，文件传输和语音识别处理均需要时间，文件转写API通过异步调用方式来提交任务。开发者需要通过查询接口，在文件转写完成后获得语音识别结果。
Python

```
\# For prerequisites running the following sample, visit https://help.aliyun.com/document\_detail/611472.html
import re
import json
from urllib import request
from http import HTTPStatus
import os
import dashscope
\# 获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
\# 若没有配置环境变量，请用百炼API Key将下行替换为：dashscope.api\_key = "sk-xxx"
dashscope.api\_key = os.environ.get('DASHSCOPE\_API\_KEY')
def parse\_sensevoice\_result(data, keep\_trans=True, keep\_emotions=True, keep\_events=True):
    '''
    本工具用于解析 sensevoice 识别结果
    keep\_trans: 是否保留转写文本，默认为True
    keep\_emotions: 是否保留情感标签，默认为True
    keep\_events: 是否保留事件标签，默认为True
    '''
    # 定义要保留的标签
    emotion\_list = \['NEUTRAL', 'HAPPY', 'ANGRY', 'SAD']
    event\_list = \['Speech', 'Applause', 'BGM', 'Laughter']
    # 所有支持的标签
    all\_tags = \['Speech', 'Applause', 'BGM', 'Laughter',
                'NEUTRAL', 'HAPPY', 'ANGRY', 'SAD', 'SPECIAL\_TOKEN\_1']
    tags\_to\_cleanup = \[]
    for tag in all\_tags:
        tags\_to\_cleanup.append(f'<|{tag}|> ')
        tags\_to\_cleanup.append(f'<|/{tag}|>')
        tags\_to\_cleanup.append(f'<|{tag}|>')
    def get\_clean\_text(text: str):
        for tag in tags\_to\_cleanup:
            text = text.replace(tag, '')
        pattern = r"\\s{2,}"
        text = re.sub(pattern, " ", text).strip()
        return text
    for item in data\['transcripts']:
        for sentence in item\['sentences']:
            if keep\_emotions:
                # 提取 emotion
                emotions\_pattern = r'<\\|(' + '|'.join(emotion\_list) + r')\\|>'
                emotions = re.findall(emotions\_pattern, sentence\['text'])
                sentence\['emotion'] = list(set(emotions))
                if not sentence\['emotion']:
                    sentence.pop('emotion', None)
            if keep\_events:
                # 提取 event
                events\_pattern = r'<\\|(' + '|'.join(event\_list) + r')\\|>'
                events = re.findall(events\_pattern, sentence\['text'])
                sentence\['event'] = list(set(events))
                if not sentence\['event']:
                    sentence.pop('event', None)
            if keep\_trans:
                # 提取纯文本
                sentence\['text'] = get\_clean\_text(sentence\['text'])
            else:
                sentence.pop('text', None)
        if keep\_trans:
            item\['text'] = get\_clean\_text(item\['text'])
        else:
            item.pop('text', None)
        item\['sentences'] = list(filter(lambda x: 'text' in x or 'emotion' in x or 'event' in x, item\['sentences']))
    return data
task\_response = dashscope.audio.asr.Transcription.async\_call(
    model='sensevoice-v1',
    file\_urls=\[
        'https://dashscope.oss-cn-beijing.aliyuncs.com/samples/audio/sensevoice/rich\_text\_example\_1.wav'],
    language\_hints=\['en'], ) # language\_hints为可选参数，用于指定待识别音频的语言代码。取值范围请参见API参考文档。
print('task\_id: ', task\_response.output.task\_id)
transcription\_response = dashscope.audio.asr.Transcription.wait(
    task=task\_response.output.task\_id)
if transcription\_response.status\_code == HTTPStatus.OK:
    for transcription in transcription\_response.output\['results']:
        if transcription\['subtask\_status'] == 'SUCCEEDED':
            url = transcription\['transcription\_url']
            result = json.loads(request.urlopen(url).read().decode('utf8'))
            print(json.dumps(parse\_sensevoice\_result(result, keep\_trans=False, keep\_emotions=False), indent=4,
                            ensure\_ascii=False))
        else:
            print('transcription failed!')
            print(transcription)
    print('transcription done!')
else:
    print('Error: ', transcription\_response.output.message)
```

Java

```
package org.example.recognition;
import com.alibaba.dashscope.audio.asr.transcription.\*;
import com.google.gson.\*;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.Stream;
class SenseVoiceParser {
    private static final List<String> EMOTION\_LIST = Arrays.asList("NEUTRAL", "HAPPY", "ANGRY", "SAD");
    private static final List<String> EVENT\_LIST = Arrays.asList("Speech", "Applause", "BGM", "Laughter");
    private static final List<String> ALL\_TAGS = Arrays.asList(
            "Speech", "Applause", "BGM", "Laughter", "NEUTRAL", "HAPPY", "ANGRY", "SAD", "SPECIAL\_TOKEN\_1");
    /\*\*
     \* 本工具用于解析 sensevoice 识别结果
     \* @param data json格式的sensevoice转写结果
     \* @param keepTrans 是否保留转写文本
     \* @param keepEmotions 是否保留情感标签
     \* @param keepEvents 是否保留事件标签
     \* @return
     \*/
    public static JsonObject parseSenseVoiceResult(JsonObject data, boolean keepTrans, boolean keepEmotions, boolean keepEvents) {
        List<String> tagsToCleanup = ALL\_TAGS.stream()
                .flatMap(tag -> Stream.of("<|" + tag + "|> ", "<|/" + tag + "|>", "<|" + tag + "|>"))
                .collect(Collectors.toList());
        JsonArray transcripts = data.getAsJsonArray("transcripts");
        for (JsonElement transcriptElement : transcripts) {
            JsonObject transcript = transcriptElement.getAsJsonObject();
            JsonArray sentences = transcript.getAsJsonArray("sentences");
            for (JsonElement sentenceElement : sentences) {
                JsonObject sentence = sentenceElement.getAsJsonObject();
                String text = sentence.get("text").getAsString();
                if (keepEmotions) {
                    extractTags(sentence, text, EMOTION\_LIST, "emotion");
                }
                if (keepEvents) {
                    extractTags(sentence, text, EVENT\_LIST, "event");
                }
                if (keepTrans) {
                    String cleanText = getCleanText(text, tagsToCleanup);
                    sentence.addProperty("text", cleanText);
                } else {
                    sentence.remove("text");
                }
            }
            if (keepTrans) {
                transcript.addProperty("text", getCleanText(transcript.get("text").getAsString(), tagsToCleanup));
            } else {
                transcript.remove("text");
            }
            JsonArray filteredSentences = new JsonArray();
            for (JsonElement sentenceElement : sentences) {
                JsonObject sentence = sentenceElement.getAsJsonObject();
                if (sentence.has("text") || sentence.has("emotion") || sentence.has("event")) {
                    filteredSentences.add(sentence);
                }
            }
            transcript.add("sentences", filteredSentences);
        }
        return data;
    }
    private static void extractTags(JsonObject sentence, String text, List<String> tagList, String key) {
        String pattern = "<\\\\|(" + String.join("|", tagList) + ")\\\\|>";
        Pattern compiledPattern = Pattern.compile(pattern);
        Matcher matcher = compiledPattern.matcher(text);
        Set<String> tags = new HashSet<>();
        while (matcher.find()) {
            tags.add(matcher.group(1));
        }
        if (!tags.isEmpty()) {
            JsonArray tagArray = new JsonArray();
            tags.forEach(tagArray::add);
            sentence.add(key, tagArray);
        } else {
            sentence.remove(key);
        }
    }
    private static String getCleanText(String text, List<String> tagsToCleanup) {
        for (String tag : tagsToCleanup) {
            text = text.replace(tag, "");
        }
        return text.replaceAll("\\\\s{2,}", " ").trim();
    }
}
public class Main {
    public static void main(String\[] args) {
        // 创建转写请求参数，需要用真实apikey替换your-dashscope-api-key
        TranscriptionParam param =
                TranscriptionParam.builder()
                        // 获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
                        // 若没有配置环境变量，请用百炼API Key将下行替换为：.apiKey("sk-xxx")
                        .apiKey(System.getenv("DASHSCOPE\_API\_KEY"))
                        .model("sensevoice-v1")
                        .fileUrls(
                                Arrays.asList(
                                        "https://dashscope.oss-cn-beijing.aliyuncs.com/samples/audio/sensevoice/rich\_text\_example\_1.wav"))
                        // language\_hints为可选参数，用于指定待识别音频的语言代码。取值范围请参见API参考文档。
                        .parameter("language\_hints", new String\[] {"en"})
                        .build();
        try {
            Transcription transcription = new Transcription();
            // 提交转写请求
            TranscriptionResult result = transcription.asyncCall(param);
            System.out.println("requestId: " + result.getRequestId());
            // 等待转写完成
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
                    System.out.println(gson.toJson(SenseVoiceParser.parseSenseVoiceResult(jsonResult.getAsJsonObject(), true, true, true)));
                }
            }
        } catch (Exception e) {
            System.out.println("error: " + e);
        }
        System.exit(0);
    }
}
```

完整的识别结果会以JSON格式打印在控制台。完整结果包含转换后的文本以及文本在音视频文件中的起始、结束时间（以毫秒为单位）。本示例中，还检测到了说话声事件（`<|Speech|>`与`<|/Speech|>`分别代表说话声事件的起始与结束），情绪（`<|ANGRY|>`）。

```
{
    "file\_url": "https://dashscope.oss-cn-beijing.aliyuncs.com/samples/audio/sensevoice/rich\_text\_example\_1.wav",
    "properties": {
        "audio\_format": "pcm\_s16le",
        "channels": \[
            0
        ],
        "original\_sampling\_rate": 16000,
        "original\_duration\_in\_milliseconds": 17645
    },
    "transcripts": \[
        {
            "channel\_id": 0,
            "content\_duration\_in\_milliseconds": 12710,
            "text": "<|Speech|> Senior staff, Principal Doris Jackson, Wakefield faculty, and of course, my fellow classmates. <|/Speech|> <|ANGRY|><|Speech|> I am honored to have been chosen to speak before my classmates, as well as the students across America today. <|/Speech|>",
            "sentences": \[
                {
                    "begin\_time": 0,
                    "end\_time": 7060,
                    "text": "<|Speech|> Senior staff, Principal Doris Jackson, Wakefield faculty, and of course, my fellow classmates. <|/Speech|> <|ANGRY|>"
                },
                {
                    "begin\_time": 11980,
                    "end\_time": 17630,
                    "text": "<|Speech|> I am honored to have been chosen to speak before my classmates, as well as the students across America today. <|/Speech|>"
                }
            ]
        }
    ]
}
```

---
*← 返回 [README](./README.md)*
