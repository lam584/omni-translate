> 来源：`录音文件识别-千问.md`
\## Java

```
import com.google.gson.Gson;
import com.google.gson.annotations.SerializedName;
import okhttp3.\*;
import java.io.IOException;
import java.util.concurrent.TimeUnit;
public class Main {
    // 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：https://dashscope-intl.aliyuncs.com/api/v1/services/audio/asr/transcription
    private static final String API\_URL\_SUBMIT = "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription";
    // 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：https://dashscope-intl.aliyuncs.com/api/v1/tasks/
    private static final String API\_URL\_QUERY = "https://dashscope.aliyuncs.com/api/v1/tasks/";
    private static final Gson gson = new Gson();
    public static void main(String\[] args) {
        // 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
        // 若没有配置环境变量，请用百炼API Key将下行替换为：String apiKey = "sk-xxx"
        String apiKey = System.getenv("DASHSCOPE\_API\_KEY");
        OkHttpClient client = new OkHttpClient();
        // 1. 提交任务
        /\*String payloadJson = """
                {
                    "model": "qwen3-asr-flash-filetrans",
                    "input": {
                        "file\_url": "https://dashscope.oss-cn-beijing.aliyuncs.com/audios/welcome.mp3"
                    },
                    "parameters": {
                        "channel\_id": \[0],
                        "enable\_itn": false,
                        "language": "zh"
                    }
                }
                """;\*/
        String payloadJson = """
                {
                    "model": "qwen3-asr-flash-filetrans",
                    "input": {
                        "file\_url": "https://dashscope.oss-cn-beijing.aliyuncs.com/audios/welcome.mp3"
                    },
                    "parameters": {
                        "channel\_id": \[0],
                        "enable\_itn": false,
                        "enable\_words": true
                    }
                }
                """;
        RequestBody body = RequestBody.create(payloadJson, MediaType.get("application/json; charset=utf-8"));
        Request submitRequest = new Request.Builder()
                .url(API\_URL\_SUBMIT)
                .addHeader("Authorization", "Bearer " + apiKey)
                .addHeader("Content-Type", "application/json")
                .addHeader("X-DashScope-Async", "enable")
                .post(body)
                .build();
        String taskId = null;
        try (Response response = client.newCall(submitRequest).execute()) {
            if (response.isSuccessful() \&\& response.body() != null) {
                String respBody = response.body().string();
                ApiResponse apiResp = gson.fromJson(respBody, ApiResponse.class);
                if (apiResp.output != null) {
                    taskId = apiResp.output.taskId;
                    System.out.println("任务已提交，task\_id: " + taskId);
                } else {
                    System.out.println("提交返回内容: " + respBody);
                    return;
                }
            } else {
                System.out.println("任务提交失败! HTTP code: " + response.code());
                if (response.body() != null) {
                    System.out.println(response.body().string());
                }
                return;
            }
        } catch (IOException e) {
            e.printStackTrace();
            return;
        }
        // 2. 轮询任务状态
        boolean finished = false;
        while (!finished) {
            try {
                TimeUnit.SECONDS.sleep(2);  // 等待 2 秒再查询
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
            String queryUrl = API\_URL\_QUERY + taskId;
            Request queryRequest = new Request.Builder()
                    .url(queryUrl)
                    .addHeader("Authorization", "Bearer " + apiKey)
                    .addHeader("X-DashScope-Async", "enable")
                    .addHeader("Content-Type", "application/json")
                    .get()
                    .build();
            try (Response response = client.newCall(queryRequest).execute()) {
                if (response.body() != null) {
                    String queryResponse = response.body().string();
                    ApiResponse apiResp = gson.fromJson(queryResponse, ApiResponse.class);
                    if (apiResp.output != null \&\& apiResp.output.taskStatus != null) {
                        String status = apiResp.output.taskStatus;
                        System.out.println("当前任务状态: " + status);
                        if ("SUCCEEDED".equalsIgnoreCase(status)
                                || "FAILED".equalsIgnoreCase(status)
                                || "UNKNOWN".equalsIgnoreCase(status)) {
                            finished = true;
                            System.out.println("任务完成，最终结果: ");
                            System.out.println(queryResponse);
                        }
                    } else {
                        System.out.println("查询返回内容: " + queryResponse);
                    }
                }
            } catch (IOException e) {
                e.printStackTrace();
                return;
            }
        }
    }
    static class ApiResponse {
        @SerializedName("request\_id")
        String requestId;
        Output output;
    }
    static class Output {
        @SerializedName("task\_id")
        String taskId;
        @SerializedName("task\_status")
        String taskStatus;
    }
}
```

---
*← 返回 [README](./README.md)*
