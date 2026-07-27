> 来源：`录音文件识别-千问.md`
\## Node.js SDK
示例中用到的音频文件为：\[welcome.mp3](https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20260105/wotsae/welcome.mp3)。

```
// 运行前的准备工作:
// Windows/Mac/Linux 通用:
// 1. 确保已安装 Node.js (建议版本 >= 14)
// 2. 运行以下命令安装必要的依赖: npm install openai
import OpenAI from "openai";
import { readFileSync } from 'fs';
const client = new OpenAI({
  // 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
  // 若没有配置环境变量，请用百炼API Key将下行替换为：apiKey: "sk-xxx",
  apiKey: process.env.DASHSCOPE\_API\_KEY,
  // 以下为北京地域url，若使用新加坡地域的模型，需将url替换为：https://dashscope-intl.aliyuncs.com/compatible-mode/v1
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
});
const encodeAudioFile = (audioFilePath) => {
    const audioFile = readFileSync(audioFilePath);
    return audioFile.toString('base64');
};
// 请替换为实际的音频文件路径
const dataUri = `data:audio/mpeg;base64,${encodeAudioFile("welcome.mp3")}`;
async function main() {
  try {
    const streamEnabled = false; // 是否开启流式输出
    const completion = await client.chat.completions.create({
      model: "qwen3-asr-flash",
      messages: \[
        {
          role: "user",
          content: \[
            {
              type: "input\_audio",
              input\_audio: {
                data: dataUri
              }
            }
          ]
        }
      ],
      stream: streamEnabled,
      // stream设为False时，不能设置stream\_options参数
      // stream\_options: {
      //   "include\_usage": true
      // },
      extra\_body: {
        asr\_options: {
          // language: "zh",
          enable\_itn: false
        }
      }
    });
    if (streamEnabled) {
      let fullContent = "";
      console.log("流式输出内容为：");
      for await (const chunk of completion) {
        console.log(JSON.stringify(chunk));
        if (chunk.choices \&\& chunk.choices.length > 0) {
          const delta = chunk.choices\[0].delta;
          if (delta \&\& delta.content) {
            fullContent += delta.content;
          }
        }
      }
      console.log(`完整内容为：${fullContent}`);
    } else {
      console.log(`非流式输出内容为：${completion.choices\[0].message.content}`);
    }
  } catch (err) {
    console.error(`错误信息：${err}`);
  }
}
main();
```

---
*← 返回 [README](./README.md)*
