> 来源：`语音合成-千问.md`
\## 使用声音设计音色进行语音合成
使用声音设计功能时，服务会返回预览音频数据。建议先试听该预览音频，确认效果符合预期后再用于语音合成，降低调用成本。
1\.  生成专属音色并试听效果，若对效果满意，进行下一步；否则重新生成。

    ### Python

    ```
    import requests
    import base64
    import os
    def create\_voice\_and\_play():
        # 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
        # 若没有配置环境变量，请用百炼API Key将下行替换为：api\_key = "sk-xxx"
        api\_key = os.getenv("DASHSCOPE\_API\_KEY")
        if not api\_key:
            print("错误: 未找到DASHSCOPE\_API\_KEY环境变量，请先设置API Key")
            return None, None, None
        # 准备请求数据
        headers = {
            "Authorization": f"Bearer {api\_key}",
            "Content-Type": "application/json"
        }
        data = {
            "model": "qwen-voice-design",
            "input": {
                "action": "create",
                "target\_model": "qwen3-tts-vd-2026-01-26",
                "voice\_prompt": "沉稳的中年男性播音员，音色低沉浑厚，富有磁性，语速平稳，吐字清晰，适合用于新闻播报或纪录片解说。",
                "preview\_text": "各位听众朋友，大家好，欢迎收听晚间新闻。",
                "preferred\_name": "announcer",
                "language": "zh"
            },
            "parameters": {
                "sample\_rate": 24000,
                "response\_format": "wav"
            }
        }
        # 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：https://dashscope-intl.aliyuncs.com/api/v1/services/audio/tts/customization
        url = "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization"
        try:
            # 发送请求
            response = requests.post(
                url,
                headers=headers,
                json=data,
                timeout=60  # 添加超时设置
            )
            if response.status\_code == 200:
                result = response.json()
                # 获取音色名称
                voice\_name = result\["output"]\["voice"]
                print(f"音色名称: {voice\_name}")
                # 获取预览音频数据
                base64\_audio = result\["output"]\["preview\_audio"]\["data"]
                # 解码Base64音频数据
                audio\_bytes = base64.b64decode(base64\_audio)
                # 保存音频文件到本地
                filename = f"{voice\_name}\_preview.wav"
                # 将音频数据写入本地文件
                with open(filename, 'wb') as f:
                    f.write(audio\_bytes)
                print(f"音频已保存到本地文件: {filename}")
                print(f"文件路径: {os.path.abspath(filename)}")
                return voice\_name, audio\_bytes, filename
            else:
                print(f"请求失败，状态码: {response.status\_code}")
                print(f"响应内容: {response.text}")
                return None, None, None
        except requests.exceptions.RequestException as e:
            print(f"网络请求发生错误: {e}")
            return None, None, None
        except KeyError as e:
            print(f"响应数据格式错误，缺少必要的字段: {e}")
            print(f"响应内容: {response.text if 'response' in locals() else 'No response'}")
            return None, None, None
        except Exception as e:
            print(f"发生未知错误: {e}")
            return None, None, None
    if \_\_name\_\_ == "\_\_main\_\_":
        print("开始创建语音...")
        voice\_name, audio\_data, saved\_filename = create\_voice\_and\_play()
        if voice\_name:
            print(f"\\n成功创建音色 '{voice\_name}'")
            print(f"音频文件已保存: '{saved\_filename}'")
            print(f"文件大小: {os.path.getsize(saved\_filename)} 字节")
        else:
            print("\\n音色创建失败")
    ```

    ### Java

    需要导入Gson依赖，若是使用Maven或者Gradle，添加依赖方式如下：

    #### Maven

    在`pom.xml`中添加如下内容：

    ```
    <!-- https://mvnrepository.com/artifact/com.google.code.gson/gson -->
    <dependency>
        <groupId>com.google.code.gson</groupId>
        <artifactId>gson</artifactId>
        <version>2.13.1</version>
    </dependency>
    ```

    #### Gradle

    在`build.gradle`中添加如下内容：

    ```
    // https://mvnrepository.com/artifact/com.google.code.gson/gson
    implementation("com.google.code.gson:gson:2.13.1")
    ```

    \*\*重要\*\*
    使用声音设计生成的专属音色进行语音合成时，必须按照如下方式设置音色：

    ```
    MultiModalConversationParam param = MultiModalConversationParam.builder()
                    .parameter("voice", "your\_voice") // 将voice参数替换为声音设计生成的专属音色
                    .build();
    ```

    ```
    import com.google.gson.JsonObject;
    import com.google.gson.JsonParser;
    import java.io.\*;
    import java.net.HttpURLConnection;
    import java.net.URL;
    import java.util.Base64;
    public class Main {
        public static void main(String\[] args) {
            Main example = new Main();
            example.createVoice();
        }
        public void createVoice() {
            // 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
            // 若没有配置环境变量，请用百炼API Key将下行替换为：String apiKey = "sk-xxx"
            String apiKey = System.getenv("DASHSCOPE\_API\_KEY");
            // 创建JSON请求体字符串
            String jsonBody = "{\\n" +
                    "    \\"model\\": \\"qwen-voice-design\\",\\n" +
                    "    \\"input\\": {\\n" +
                    "        \\"action\\": \\"create\\",\\n" +
                    "        \\"target\_model\\": \\"qwen3-tts-vd-2026-01-26\\",\\n" +
                    "        \\"voice\_prompt\\": \\"沉稳的中年男性播音员，音色低沉浑厚，富有磁性，语速平稳，吐字清晰，适合用于新闻播报或纪录片解说。\\",\\n" +
                    "        \\"preview\_text\\": \\"各位听众朋友，大家好，欢迎收听晚间新闻。\\",\\n" +
                    "        \\"preferred\_name\\": \\"announcer\\",\\n" +
                    "        \\"language\\": \\"zh\\"\\n" +
                    "    },\\n" +
                    "    \\"parameters\\": {\\n" +
                    "        \\"sample\_rate\\": 24000,\\n" +
                    "        \\"response\_format\\": \\"wav\\"\\n" +
                    "    }\\n" +
                    "}";
            HttpURLConnection connection = null;
            try {
                // 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：https://dashscope-intl.aliyuncs.com/api/v1/services/audio/tts/customization
                URL url = new URL("https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization");
                connection = (HttpURLConnection) url.openConnection();
                // 设置请求方法和头部
                connection.setRequestMethod("POST");
                connection.setRequestProperty("Authorization", "Bearer " + apiKey);
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setDoOutput(true);
                connection.setDoInput(true);
                // 发送请求体
                try (OutputStream os = connection.getOutputStream()) {
                    byte\[] input = jsonBody.getBytes("UTF-8");
                    os.write(input, 0, input.length);
                    os.flush();
                }
                // 获取响应
                int responseCode = connection.getResponseCode();
                if (responseCode == HttpURLConnection.HTTP\_OK) {
                    // 读取响应内容
                    StringBuilder response = new StringBuilder();
                    try (BufferedReader br = new BufferedReader(
                            new InputStreamReader(connection.getInputStream(), "UTF-8"))) {
                        String responseLine;
                        while ((responseLine = br.readLine()) != null) {
                            response.append(responseLine.trim());
                        }
                    }
                    // 解析JSON响应
                    JsonObject jsonResponse = JsonParser.parseString(response.toString()).getAsJsonObject();
                    JsonObject outputObj = jsonResponse.getAsJsonObject("output");
                    JsonObject previewAudioObj = outputObj.getAsJsonObject("preview\_audio");
                    // 获取音色名称
                    String voiceName = outputObj.get("voice").getAsString();
                    System.out.println("音色名称: " + voiceName);
                    // 获取Base64编码的音频数据
                    String base64Audio = previewAudioObj.get("data").getAsString();
                    // 解码Base64音频数据
                    byte\[] audioBytes = Base64.getDecoder().decode(base64Audio);
                    // 保存音频到本地文件
                    String filename = voiceName + "\_preview.wav";
                    saveAudioToFile(audioBytes, filename);
                    System.out.println("音频已保存到本地文件: " + filename);
                } else {
                    // 读取错误响应
                    StringBuilder errorResponse = new StringBuilder();
                    try (BufferedReader br = new BufferedReader(
                            new InputStreamReader(connection.getErrorStream(), "UTF-8"))) {
                        String responseLine;
                        while ((responseLine = br.readLine()) != null) {
                            errorResponse.append(responseLine.trim());
                        }
                    }
                    System.out.println("请求失败，状态码: " + responseCode);
                    System.out.println("错误响应: " + errorResponse.toString());
                }
            } catch (Exception e) {
                System.err.println("请求发生错误: " + e.getMessage());
                e.printStackTrace();
            } finally {
                if (connection != null) {
                    connection.disconnect();
                }
            }
        }
        private void saveAudioToFile(byte\[] audioBytes, String filename) {
            try {
                File file = new File(filename);
                try (FileOutputStream fos = new FileOutputStream(file)) {
                    fos.write(audioBytes);
                }
                System.out.println("音频已保存到: " + file.getAbsolutePath());
            } catch (IOException e) {
                System.err.println("保存音频文件时发生错误: " + e.getMessage());
                e.printStackTrace();
            }
        }
    }
    ```

2\.  使用上一步生成的专属音色进行语音合成（非流式合成）。
    这里参考了使用系统音色进行语音合成DashScope SDK的“非流式输出”示例代码，将`voice`参数替换为声音设计生成的专属音色进行语音合成。单向流式合成请参见\[语音合成-千问](https://help.aliyun.com/zh/model-studio/qwen-tts#c204937c02gsb)。
    \*\*关键原则\*\*：声音设计时使用的模型 (`target\_model`) 必须与后续进行语音合成时使用的模型 (`model`) 保持一致，否则会导致合成失败。

    ### Python

    ```
    import os
    import dashscope
    if \_\_name\_\_ == '\_\_main\_\_':
        # 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：https://dashscope-intl.aliyuncs.com/api/v1
        dashscope.base\_http\_api\_url = 'https://dashscope.aliyuncs.com/api/v1'
        text = "今天天气怎么样？"
        # SpeechSynthesizer接口使用方法：dashscope.audio.qwen\_tts.SpeechSynthesizer.call(...)
        response = dashscope.MultiModalConversation.call(
            model="qwen3-tts-vd-2026-01-26",
            # 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
            # 若没有配置环境变量，请用百炼API Key将下行替换为：api\_key = "sk-xxx"
            api\_key=os.getenv("DASHSCOPE\_API\_KEY"),
            text=text,
            voice="myvoice", # 将voice参数替换为声音设计生成的专属音色
            stream=False
        )
        print(response)
    ```

    ### Java

    ```
    import com.alibaba.dashscope.aigc.multimodalconversation.MultiModalConversation;
    import com.alibaba.dashscope.aigc.multimodalconversation.MultiModalConversationParam;
    import com.alibaba.dashscope.aigc.multimodalconversation.MultiModalConversationResult;
    import com.alibaba.dashscope.exception.ApiException;
    import com.alibaba.dashscope.exception.NoApiKeyException;
    import com.alibaba.dashscope.exception.UploadFileException;
    import com.alibaba.dashscope.utils.Constants;
    import java.io.FileOutputStream;
    import java.io.InputStream;
    import java.net.URL;
    public class Main {
        private static final String MODEL = "qwen3-tts-vd-2026-01-26";
        public static void call() throws ApiException, NoApiKeyException, UploadFileException {
            MultiModalConversation conv = new MultiModalConversation();
            MultiModalConversationParam param = MultiModalConversationParam.builder()
                    // 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
                    // 若没有配置环境变量，请用百炼API Key将下行替换为：.apiKey("sk-xxx")
                    .apiKey(System.getenv("DASHSCOPE\_API\_KEY"))
                    .model(MODEL)
                    .text("Today is a wonderful day to build something people love!")
                    .parameter("voice", "myvoice") // 将voice参数替换为声音设计生成的专属音色
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

\## \*\*API 参考\*\*
\[语音合成-千问API参考](https://help.aliyun.com/zh/model-studio/qwen-tts-api)
\[声音复刻-API参考](https://help.aliyun.com/zh/model-studio/qwen-tts-voice-cloning)
\[声音设计-API参考](https://help.aliyun.com/zh/model-studio/qwen-tts-voice-design)
\## \*\*模型功能特性对比\*\*

| \*\*功能/特性\*\* | \*\*千问3-TTS-Instruct-Flash\*\* | \*\*千问3-TTS-VD\*\* | \*\*千问3-TTS-VC\*\* | \*\*千问3-TTS-Flash\*\* | \*\*千问-TTS\*\* |
| --- | --- | --- | --- | --- | --- |
| \*\*支持语言\*\* | 因\[音色](#bac280ddf5a1u)而异：中文（普通话）、英文、西班牙语、俄语、意大利语、法语、韩语、日语、德语、葡萄牙语 | 中文（普通话）、英文、西班牙语、俄语、意大利语、法语、韩语、日语、德语、葡萄牙语 |   | 因\[音色](#bac280ddf5a1u)而异：中文（普通话、上海话、北京话、四川话、南京话、陕西话、闽南语、天津话）、粤语、英文、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | 因\[音色](#bac280ddf5a1u)而异：中文（普通话、上海话、北京话、四川话）、英文 |
| \*\*音频格式\*\* | - wav：非流式输出时 - pcm：流式输出时，Base64编码 |   |   |   |   |
| \*\*音频采样率\*\* | 24kHz |   |   |   |   |
| \*\*声音复刻\*\* | 不支持 |   | 支持  | 不支持 |   |
| \*\*声音设计\*\* | 不支持 | 支持  | 不支持 |   |   |
| \*\*SSML\*\* | 不支持 |   |   |   |   |
| \*\*LaTeX\*\* | 不支持 |   |   |   |   |
| \*\*音量调节\*\* | 支持 > 可通过\[指令控制](#12884a10929p9)调节 | 不支持 |   |   |   |
| \*\*语速调节\*\* | 支持 > 可通过\[指令控制](#12884a10929p9)调节 | 不支持 |   |   |   |
| \*\*语调（音高）调节\*\* | 支持 > 可通过\[指令控制](#12884a10929p9)调节 | 不支持 |   |   |   |
| \*\*码率调节\*\* | 不支持 |   |   |   |   |
| \*\*时间戳\*\* | 不支持 |   |   |   |   |
| \*\*指令控制（Instruct）\*\* | 支持  | 不支持 |   |   |   |
| \*\*流式输入\*\* | 不支持 |   |   |   |   |
| \*\*流式输出\*\* | 支持  |   |   |   |   |
| \*\*限流\*\* | 每分钟调用次数（RPM）：180 | 每分钟调用次数（RPM）：180 | 每分钟调用次数（RPM）：180 | 每分钟调用次数（RPM）因模型而异： - qwen3-tts-flash、qwen3-tts-flash-2025-11-27：180 - qwen3-tts-flash-2025-09-18：10 | 每分钟调用次数（RPM）：10 每分钟消耗Token数（TPM，含输入与输出Token）：100,000 |
| \*\*接入方式\*\* | Java/Python SDK、WebSocket API |   |   |   |   |
| \*\*价格\*\* | 中国内地：0.8元/万字符 国际：0.8元/万字符 | 中国内地：0.8元/万字符 国际：0.8元/万字符 | 中国内地：0.8元/万字符 国际：0.8元/万字符 | 中国内地：0.8元/万字符 国际：0.733924元/万字符 | 中国内地： - 输入成本：0.0016元/千Token - 输出成本：0.01元/千Token 音频转换为 Token 的规则：每1秒的音频对应 50个 Token ;若音频时长不足1秒，则按 50个 Token 计算 |

\## \*\*支持的系统音色\*\*
不同模型支持的音色有所差异，使用时将请求参数`voice`设置为音色列表中\*\*voice参数\*\*列对应的值。

| `\*\*voice\*\*`\*\*参数\*\* | \*\*详情\*\* | \*\*支持语种\*\* | \*\*支持模型\*\* |
| `Cherry` | \*\*音色名\*\*：芊悦 \*\*描述\*\*：阳光积极、亲切自然小姐姐（女性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash\*\*：qwen3-tts-instruct-flash、qwen3-tts-instruct-flash-2026-01-26 - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27、qwen3-tts-flash-2025-09-18 - \*\*千问-TTS\*\*：qwen-tts、qwen-tts-2025-04-10、qwen-tts-latest、qwen-tts-2025-05-22 |
| `Serena` | \*\*音色名\*\*：苏瑶 \*\*描述\*\*：温柔小姐姐（女性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash\*\*：qwen3-tts-instruct-flash、qwen3-tts-instruct-flash-2026-01-26 - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27 - \*\*千问-TTS\*\*：qwen-tts、qwen-tts-2025-04-10、qwen-tts-latest、qwen-tts-2025-05-22 |
| `Ethan` | \*\*音色名\*\*：晨煦 \*\*描述\*\*：标准普通话，带部分北方口音。阳光、温暖、活力、朝气（男性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash\*\*：qwen3-tts-instruct-flash、qwen3-tts-instruct-flash-2026-01-26 - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27、qwen3-tts-flash-2025-09-18 - \*\*千问-TTS\*\*：qwen-tts、qwen-tts-2025-04-10、qwen-tts-latest、qwen-tts-2025-05-22 |
| `Chelsie` | \*\*音色名\*\*：千雪 \*\*描述\*\*：二次元虚拟女友（女性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash\*\*：qwen3-tts-instruct-flash、qwen3-tts-instruct-flash-2026-01-26 - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27 - \*\*千问-TTS\*\*：qwen-tts、qwen-tts-2025-04-10、qwen-tts-latest、qwen-tts-2025-05-22 |
| `Momo` | \*\*音色名\*\*：茉兔 \*\*描述\*\*：撒娇搞怪，逗你开心（女性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash\*\*：qwen3-tts-instruct-flash、qwen3-tts-instruct-flash-2026-01-26 - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27 |
| `Vivian` | \*\*音色名\*\*：十三 \*\*描述\*\*：拽拽的、可爱的小暴躁（女性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash\*\*：qwen3-tts-instruct-flash、qwen3-tts-instruct-flash-2026-01-26 - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27 |
| `Moon` | \*\*音色名\*\*：月白 \*\*描述\*\*：率性帅气的月白（男性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash\*\*：qwen3-tts-instruct-flash、qwen3-tts-instruct-flash-2026-01-26 - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27 |
| `Maia` | \*\*音色名\*\*：四月 \*\*描述\*\*：知性与温柔的碰撞（女性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash\*\*：qwen3-tts-instruct-flash、qwen3-tts-instruct-flash-2026-01-26 - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27 |
| `Kai` | \*\*音色名\*\*：凯 \*\*描述\*\*：耳朵的一场SPA（男性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash\*\*：qwen3-tts-instruct-flash、qwen3-tts-instruct-flash-2026-01-26 - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27 |
| `Nofish` | \*\*音色名\*\*：不吃鱼 \*\*描述\*\*：不会翘舌音的设计师（男性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash\*\*：qwen3-tts-instruct-flash、qwen3-tts-instruct-flash-2026-01-26 - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27、qwen3-tts-flash-2025-09-18 |
| `Bella` | \*\*音色名\*\*：萌宝 \*\*描述\*\*：喝酒不打醉拳的小萝莉（女性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash\*\*：qwen3-tts-instruct-flash、qwen3-tts-instruct-flash-2026-01-26 - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27 |
| `Jennifer` | \*\*音色名\*\*：詹妮弗 \*\*描述\*\*：品牌级、电影质感般美语女声（女性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27、qwen3-tts-flash-2025-09-18 |
| `Ryan` | \*\*音色名\*\*：甜茶 \*\*描述\*\*：节奏拉满，戏感炸裂，真实与张力共舞（男性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27、qwen3-tts-flash-2025-09-18 |
| `Katerina` | \*\*音色名\*\*：卡捷琳娜 \*\*描述\*\*：御姐音色，韵律回味十足（女性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27、qwen3-tts-flash-2025-09-18 |
| `Aiden` | \*\*音色名\*\*：艾登 \*\*描述\*\*：精通厨艺的美语大男孩（男性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27 |
| `Eldric Sage` | \*\*音色名\*\*：沧明子 \*\*描述\*\*：沉稳睿智的老者，沧桑如松却心明如镜（男性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash\*\*：qwen3-tts-instruct-flash、qwen3-tts-instruct-flash-2026-01-26 - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27 |
| `Mia` | \*\*音色名\*\*：乖小妹 \*\*描述\*\*：温顺如春水，乖巧如初雪（女性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash\*\*：qwen3-tts-instruct-flash、qwen3-tts-instruct-flash-2026-01-26 - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27 |
| `Mochi` | \*\*音色名\*\*：沙小弥 \*\*描述\*\*：聪明伶俐的小大人，童真未泯却早慧如禅（男性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash\*\*：qwen3-tts-instruct-flash、qwen3-tts-instruct-flash-2026-01-26 - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27 |
| `Bellona` | \*\*音色名\*\*：燕铮莺 \*\*描述\*\*：声音洪亮，吐字清晰，人物鲜活，听得人热血沸腾；金戈铁马入梦来，字正腔圆间尽显千面人声的江湖（女性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash\*\*：qwen3-tts-instruct-flash、qwen3-tts-instruct-flash-2026-01-26 - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27 |
| `Vincent` | \*\*音色名\*\*：田叔 \*\*描述\*\*：一口独特的沙哑烟嗓，一开口便道尽了千军万马与江湖豪情（男性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash\*\*：qwen3-tts-instruct-flash、qwen3-tts-instruct-flash-2026-01-26 - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27 |
| `Bunny` | \*\*音色名\*\*：萌小姬 \*\*描述\*\*：“萌属性”爆棚的小萝莉（女性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash\*\*：qwen3-tts-instruct-flash、qwen3-tts-instruct-flash-2026-01-26 - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27 |
| `Neil` | \*\*音色名\*\*：阿闻 \*\*描述\*\*：平直的基线语调，字正腔圆的咬字发音，这就是最专业的新闻主持人（男性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash\*\*：qwen3-tts-instruct-flash、qwen3-tts-instruct-flash-2026-01-26 - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27 |
| `Elias` | \*\*音色名\*\*：墨讲师 \*\*描述\*\*：既保持学科严谨性，又通过叙事技巧将复杂知识转化为可消化的认知模块（女性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash\*\*：qwen3-tts-instruct-flash、qwen3-tts-instruct-flash-2026-01-26 - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27、qwen3-tts-flash-2025-09-18 |
| `Arthur` | \*\*音色名\*\*：徐大爷 \*\*描述\*\*：被岁月和旱烟浸泡过的质朴嗓音，不疾不徐地摇开了满村的奇闻异事（男性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash\*\*：qwen3-tts-instruct-flash、qwen3-tts-instruct-flash-2026-01-26 - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27 |
| `Nini` | \*\*音色名\*\*：邻家妹妹 \*\*描述\*\*：糯米糍一样又软又黏的嗓音，那一声声拉长了的“哥哥”，甜得能把人的骨头都叫酥了（女性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash\*\*：qwen3-tts-instruct-flash、qwen3-tts-instruct-flash-2026-01-26 - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27 |
| `Seren` | \*\*音色名\*\*：小婉 \*\*描述\*\*：温和舒缓的声线，助你更快地进入睡眠，晚安，好梦（女性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash\*\*：qwen3-tts-instruct-flash、qwen3-tts-instruct-flash-2026-01-26 - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27 |
| `Pip` | \*\*音色名\*\*：顽屁小孩 \*\*描述\*\*：调皮捣蛋却充满童真的他来了，这是你记忆中的小新吗（男性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash\*\*：qwen3-tts-instruct-flash、qwen3-tts-instruct-flash-2026-01-26 - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27 |
| `Stella` | \*\*音色名\*\*：少女阿月 \*\*描述\*\*：平时是甜到发腻的迷糊少女音，但在喊出“代表月亮消灭你”时，瞬间充满不容置疑的爱与正义（女性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Instruct-Flash\*\*：qwen3-tts-instruct-flash、qwen3-tts-instruct-flash-2026-01-26 - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27 |
| `Bodega` | \*\*音色名\*\*：博德加 \*\*描述\*\*：热情的西班牙大叔（男性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27 |
| `Sonrisa` | \*\*音色名\*\*：索尼莎 \*\*描述\*\*：热情开朗的拉美大姐（女性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27 |
| `Alek` | \*\*音色名\*\*：阿列克 \*\*描述\*\*：一开口，是战斗民族的冷，也是毛呢大衣下的暖（男性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27 |
| `Dolce` | \*\*音色名\*\*：多尔切 \*\*描述\*\*：慵懒的意大利大叔（男性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27 |
| `Sohee` | \*\*音色名\*\*：素熙 \*\*描述\*\*：温柔开朗，情绪丰富的韩国欧尼（女性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27 |
| `Ono Anna` | \*\*音色名\*\*：小野杏 \*\*描述\*\*：鬼灵精怪的青梅竹马（女性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27 |
| `Lenn` | \*\*音色名\*\*：莱恩 \*\*描述\*\*：理性是底色，叛逆藏在细节里——穿西装也听后朋克的德国青年（男性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27 |
| `Emilien` | \*\*音色名\*\*：埃米尔安 \*\*描述\*\*：浪漫的法国大哥哥（男性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27 |
| `Andre` | \*\*音色名\*\*：安德雷 \*\*描述\*\*：声音磁性，自然舒服、沉稳男生（男性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27 |
| `Radio Gol` | \*\*音色名\*\*：拉迪奥·戈尔 \*\*描述\*\*：足球诗人Rádio Gol！今天我要用名字为你们解说足球（男性） | 中文（普通话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27 |
| `Jada` | \*\*音色名\*\*：上海-阿珍 \*\*描述\*\*：风风火火的沪上阿姐（女性） | 中文（上海话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27、qwen3-tts-flash-2025-09-18 - \*\*千问-TTS\*\*：qwen-tts-latest、qwen-tts-2025-05-22 |
| `Dylan` | \*\*音色名\*\*：北京-晓东 \*\*描述\*\*：北京胡同里长大的少年（男性） | 中文（北京话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27、qwen3-tts-flash-2025-09-18 - \*\*千问-TTS\*\*：qwen-tts-latest、qwen-tts-2025-05-22 |
| `Li` | \*\*音色名\*\*：南京-老李 \*\*描述\*\*：耐心的瑜伽老师（男性） | 中文（南京话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27、qwen3-tts-flash-2025-09-18 |
| `Marcus` | \*\*音色名\*\*：陕西-秦川 \*\*描述\*\*：面宽话短，心实声沉——老陕的味道（男性） | 中文（陕西话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27、qwen3-tts-flash-2025-09-18 |
| `Roy` | \*\*音色名\*\*：闽南-阿杰 \*\*描述\*\*：诙谐直爽、市井活泼的台湾哥仔形象（男性） | 中文（闽南语）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27、qwen3-tts-flash-2025-09-18 |
| `Peter` | \*\*音色名\*\*：天津-李彼得 \*\*描述\*\*：天津相声，专业捧哏（男性） | 中文（天津话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27、qwen3-tts-flash-2025-09-18 |
| `Sunny` | \*\*音色名\*\*：四川-晴儿 \*\*描述\*\*：甜到你心里的川妹子（女性） | 中文（四川话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27、qwen3-tts-flash-2025-09-18 - \*\*千问-TTS\*\*：qwen-tts-latest、qwen-tts-2025-05-22 |
| `Eric` | \*\*音色名\*\*：四川-程川 \*\*描述\*\*：一个跳脱市井的四川成都男子（男性） | 中文（四川话）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27、qwen3-tts-flash-2025-09-18 |
| `Rocky` | \*\*音色名\*\*：粤语-阿强 \*\*描述\*\*：幽默风趣的阿强，在线陪聊（男性） | 中文（粤语）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27、qwen3-tts-flash-2025-09-18 |
| `Kiki` | \*\*音色名\*\*：粤语-阿清 \*\*描述\*\*：甜美的港妹闺蜜（女性） | 中文（粤语）、英语、法语、德语、俄语、意大利语、西班牙语、葡萄牙语、日语、韩语 | - \*\*千问3-TTS-Flash\*\*：qwen3-tts-flash、qwen3-tts-flash-2025-11-27、qwen3-tts-flash-2025-09-18 |

\## \*\*常见问题\*\*
\### \*\*Q：音频文件链接的有效期是多久？\*\*
A：24小时后音频文件链接将失效。
/\\\* 让引用上下间距调小，避免内容显示过于稀疏 \\\*/ .unionContainer .markdown-body blockquote { margin: 4px 0; } .aliyun-docs-content table.qwen blockquote { border-left: none; /\\\* 添加这一行来移除表格里的引用文字的左侧边框 \\\*/ padding-left: 5px; /\\\* 左侧内边距 \\\*/ margin: 4px 0; } /\\\* 支持吸顶 \\\*/ div:has(.aliyun-docs-content), .aliyun-docs-content .markdown-body { overflow: visible; } .stick-top { position: sticky; top: 46px; }
 span.aliyun-docs-icon { color: transparent !important; font-size: 0 !important; } span.aliyun-docs-icon:before { color: black; font-size: 16px; } span.aliyun-docs-icon.icon-size-20:before { font-size: 20px; } span.aliyun-docs-icon.icon-size-22:before { font-size: 22px; } span.aliyun-docs-icon.icon-size-24:before { font-size: 24px; } span.aliyun-docs-icon.icon-size-26:before { font-size: 26px; } span.aliyun-docs-icon.icon-size-28:before { font-size: 28px; }
---
*← 返回 [README](./README.md)*
