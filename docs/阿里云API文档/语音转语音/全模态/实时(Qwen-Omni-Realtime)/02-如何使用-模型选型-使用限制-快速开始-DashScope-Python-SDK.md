> 来源：`实时(Qwen-Omni-Realtime).md`
\## \*\*如何使用\*\*
\### \*\*1\\. 建立连接\*\*
Qwen-Omni-Realtime 模型通过 WebSocket 协议接入，可通过以下 Python 示例代码建立连接。也可通过DashScope SDK 建立连接。
\## \*\*模型选型\*\*
Qwen3.5-Omni-Realtime 是千问最新推出的实时多模态模型，相比于上一代的 Qwen3-Omni-Flash-Realtime：
\-   \*\*智能水平\*\*
    模型智力大幅提升，与 Qwen3.5-Plus 智能水平相当。
\-   \*\*联网搜索\*\*
    原生支持联网搜索（WebSearch），模型可自主判断是否需要搜索来回应即时问题。详见\[联网搜索](#a8b2c3d4e5s6h)。
\-   \*\*工具调用\*\*
    支持 Function Calling，模型可自主判断是否需要调用外部工具，实现与外部系统的交互。详见\[Qwen-Omni-Realtime 系列](https://help.aliyun.com/zh/model-studio/qwen-function-calling#rt02realtime01)。
\-   \*\*语义打断\*\*
    自动识别对话意图，避免附和声和无意义背景音触发打断。
\-   \*\*语音控制\*\*
    通过语音指令控制声音大小、语速和情绪，如“语速快一些”、“声音大一些”、“用开心的语气”等。
\-   \*\*支持的语言\*\*
    支持 \[113 种语种和方言](https://help.aliyun.com/zh/model-studio/qwen-omni#model-comparison-table)的语音识别，以及 \[36 种语种和方言](https://help.aliyun.com/zh/model-studio/qwen-omni#model-comparison-table)的语音生成。
\-   \*\*支持的音色\*\*
    支持 55 种音色（47 种多语言 + 8 种方言），具体可查看\[音色列表](#f4c9fd97f221z)。
\-   \*\*声音复刻\*\*
    qwen3.5-omni-plus-realtime 和 qwen3.5-omni-flash-realtime 支持声音复刻功能，可使用自定义音色进行实时对话。详见\[声音复刻](https://help.aliyun.com/zh/model-studio/qwen-omni-voice-cloning)。
> 模型的名称、上下文、价格、快照版本等信息请参见百炼控制台；并发限流条件请参考\[限流](https://help.aliyun.com/zh/model-studio/rate-limit)。
\## \*\*使用限制\*\*
\-   联网搜索和工具调用不兼容，不可同时开启。
\-   单次 WebSocket 会话最长可持续 \*\*120 分钟\*\*，达到此上限后服务将主动关闭连接。
\-   模型会维护对话历史上下文，当对话轮次或累计时长超过以下限制时，将自动丢弃更早的历史信息。\*\*最大时长\*\*指模型上下文中能保留的音频或视频（图像帧）累计时长上限。
    > 由于视频以抽帧方式输入（建议 1 帧/秒），视频最大时长即模型能保留的图像帧累计时长。例如 240 秒表示模型最多保留最近 240 秒内收到的帧，超过后更早的帧将被丢弃。
    > qwen3-omni-flash-realtime 最大轮次为 8 轮，一般会先触及轮次限制，时长限制为模型的上下文长度限制，不再单独列出。

    | \*\*模型\*\* | \*\*音频最大轮次\*\* | \*\*视频最大轮次\*\* | \*\*音频最大时长\*\* | \*\*视频最大时长\*\* |
    | --- | --- | --- | --- | --- |
    | qwen3.5-omni-plus-realtime | 100轮 | 50轮 | 600秒 | 240秒 |
    | qwen3.5-omni-flash-realtime | 80轮 | 50轮 | 480秒 | 120秒 |
    | qwen3-omni-flash-realtime | 8轮  | 8轮  | —   | —   |

\## \*\*快速开始\*\*
您需要\[获取API Key](https://help.aliyun.com/zh/model-studio/get-api-key)并\[配置API Key到环境变量](https://help.aliyun.com/zh/model-studio/configure-api-key-through-environment-variables)。
请选择您熟悉的编程语言，通过以下步骤快速体验与 Realtime 模型实时对话的功能。
\## DashScope Python SDK
\-   \*\*准备运行环境\*\*
您的 Python 版本需要不低于 3.10。
首先根据您的操作系统安装 pyaudio。
\## macOS

```
brew install portaudio \&\& pip install pyaudio
```

\## Debian/Ubuntu
\-   \*\*若未使用虚拟环境\*\*，可直接通过系统包管理器安装：

    ```
    sudo apt-get install python3-pyaudio
    ```

\-   \*\*若使用虚拟环境\*\*，需先安装编译依赖：

    ```
    sudo apt update
    sudo apt install -y python3-dev portaudio19-dev
    ```

    然后在已激活的虚拟环境中使用 pip 安装：

    ```
    pip install pyaudio
    ```

\## CentOS

```
sudo yum install -y portaudio portaudio-devel \&\& pip install pyaudio
```

---
*← 返回 [README](./README.md)*
