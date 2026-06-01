> 来源：`非实时(Qwen-Omni).md`
Qwen-Omni 模型能够接收多模态输入并生成文本或语音形式的回复，提供多种拟人音色，支持多语言和方言的语音输出，可应用于内容审核、文本创作、视觉识别、音视频交互助手等场景。
\*\*支持的地域：\*\*北京、新加坡，需使用各地域的 \[API Key](https://help.aliyun.com/zh/model-studio/get-api-key)。
\## \*\*模型选型\*\*
\-   \*\*Qwen3.5-Omni 系列：\*\*适用于长视频分析、会议纪要、字幕生成、内容审核、音视频交互等场景。
    -   输入限制：3 小时音频或 1 小时视频
    -   音频控制：支持通过指令调节音量、语速、情绪
    -   视觉能力：与 Qwen3.5 同等水平，可理解画面、语音、音效等多模态信息
    -   多模态组合输入：支持文本与图片、音频、视频的任意组合同时输入，不限于单一模态
\-   \*\*Qwen3-Omni-Flash系列：\*\*适用于短视频分析、成本敏感场景。
    -   输入限制：150 秒以内音视频
    -   思考模式：Qwen-Omni 系列中唯一支持思考模式的系列
    -   输入模态：仅支持文本与单一其他模态（图片、音频或视频）的组合输入
\-   \*\*Qwen-Omni-Turbo系列\*\*
    已停止更新，功能受限，建议迁移至 Qwen3.5-Omni 系列或 Qwen3-Omni-Flash 系列。

| \*\*模型系列\*\* | \*\*音视频描述能力\*\* | \*\*深度思考\*\* | \*\*联网搜索\*\* | \*\*输入音频语种\*\* | \*\*输出音频语种\*\* | \*\*音色数量\*\* |
| --- | --- | --- | --- | --- | --- | --- |
| Qwen3.5-Omni 最新一代全模态模型 | 强   | 不支持 | 支持  | 113 种 含74 种语言、39 种方言 \*\*语言：\*\*中文、英语、德语、法语、意大利语、捷克语、印尼语、泰语、韩语、波兰语、日语、越南语、芬兰语、葡萄牙语、西班牙语、荷兰语、俄语、马来语、加泰罗尼亚语、瑞典语、土耳其语、乌克兰语、罗马尼亚语、斯洛伐克语、丹麦语、冰岛语、挪威语（博克马尔）、马其顿语、希腊语、匈牙利语、加利西亚语、菲律宾语、克罗地亚语、波斯尼亚语、斯洛文尼亚语、保加利亚语、哈萨克语、白俄罗斯语、拉脱维亚语、爱沙尼亚语、阿塞拜疆语、维吾尔语、斯瓦希里语、印地语、世界语、柯尔克孜语、塔吉克语、宿务语、南非语、阿拉伯语、立陶宛语、爪哇语、孟加拉语、波斯语、希伯来语、旁遮普语、古吉拉特语、蒙古语、阿斯图里亚斯语、卡纳达语、马拉地语、国际语、马拉雅拉姆语、马耳他语、新挪威语、泰卢固语、乌尔都语、格鲁吉亚语、巴斯克语、泰米尔语、奥里亚语、塞尔维亚语、毛利语 \*\*方言：\*\* 东北话、贵州话、粤语、河南话、香港粤语、上海话、陕西话、天津话、台湾话、云南话、安徽话、福建话、甘肃话、广东话、湖北话、湖南话、江西话、山东话、山西话、四川话、广西话、海南话、重庆话、长沙话、杭州话、合肥话、银川话、郑州话、沈阳话、温州话、武汉话、昆明话、太原话、南昌话、济南话、兰州话、南京话、客家话、闽南语 | 36 种 含 29 种语言、7 种方言 \*\*语言：\*\* 中文、英语、德语、意大利语、葡萄牙语、西班牙语、日语、韩语、法语、俄语、泰语、印度尼西亚语、阿拉伯语、越南语、土耳其语、芬兰语、波兰语、印地语、荷兰语、捷克语、乌尔都语、他加禄语、瑞典语、丹麦语、希伯来语、冰岛语、马来语、挪威语、波斯语 \*\*方言：\*\* 四川话、北京话、天津话、南京话、陕西话、粤语、闽南语 | 55 种 |
| Qwen3-Omni-Flash 混合思考模型 | 较弱  | 支持  | 不支持 | 19 种 含 11 种语言、8 种方言 \*\*语言：\*\* 中文、英语、德语、法语、意大利语、泰语、韩语、日语、俄语、西班牙语、葡萄牙语 \*\*方言：\*\* 四川话、上海话、粤语、闽南语、陕西话、南京话、天津话、北京话 | 19 种 含 11 种语言、8 种方言 \*\*语言：\*\* 中文、英语、德语、法语、意大利语、泰语、韩语、日语、俄语、西班牙语、葡萄牙语 \*\*方言：\*\* 四川话、上海话、粤语、闽南语、陕西话、南京话、天津话、北京话 | 17\~49 种 > 因版本而异 |
| Qwen-Omni-Turbo \*\*已停止更新\*\* | 无   | 不支持 | 不支持 | 中文、英语 | 中文、英语 | 4 种 |

> 模型的名称、上下文、价格、快照版本等信息请参见百炼控制台；并发限流条件请参考\[限流](https://help.aliyun.com/zh/model-studio/rate-limit)。
\## \*\*模型效果\*\*
\### \*\*音视频内容分析\*\*

| > 请你对这个视频按时间戳生成全面的描述。 | \*\*00:00.000 – 00:02.500\*\* 雨夜中的城市街道填满宽银幕画面。长时间曝光下，红蓝车灯拖出光轨滑过，在湿漉漉的路面上 闪烁。一位身穿深色及膝风衣、内搭浅色衬衫领带的孤独男子，沿着右侧人行道向镜头走来。雨滴凝结在他的肩膀和头发上；每一步都在潮湿的混凝土上发出沉闷的啪嗒声。低沉不祥的电子嗡鸣支撑着环境音，同时稳定的雨声四处噼啪作响。他身旁的砖墙上贴满彩色涂鸦，街区远处几块霓虹灯招牌发光——一块清晰显示橙红色草书体 "Nice"，另一块竖置招牌的末端露出字母 "AT"。 ...... \*\*00:12.300 – 00:14.533\*\* 镜头向下倾斜。在手电筒光圈内，一张 泛黄老化的单页纸躺在浅水洼中，边缘烧焦且边角卷曲。墨迹段落覆盖大部分表面，但潮湿和焦痕使文字无法辨认。男子跪下，戴手套的手指伸向文件；手靠近时水波向外荡漾。警笛达到峰值，随后开始略微消退，而 环境嗡鸣保持稳定。画面在颤抖的纸页即将被触碰前 定格，片段结束。 > 仅展示部分时间戳内容。 |
| --- | --- |

\### \*\*多方言理解\*\*

| > 给出不同方言歌手的声音特征、演唱时的情绪状态、以及对应的完整歌词 | 这段音频由多位来自中国不同地区的歌手用各自的方言进行说唱，展现了中国方言的丰富多样性。以下是每位歌手的声音特征、情绪状态及对应歌词的详细描述： \*\*杭州话（吴语）\*\* \*\*声音特征：\*\* 这位男歌手的声音较为柔和，带有吴语特有的软糯和温婉。他的语调起伏平缓，节奏轻快，给人一种娓娓道来的感觉。 \*\*情绪状态：\*\* 悠闲、惬意且充满生活气息。他描绘了杭州的慢生活和城市变迁，情绪中带着对家乡的眷恋和对现代发展的感慨，整体感觉舒适而亲切。 \*\*对应歌词：\*\* \\\\> 杭州话，听听看，我们格文化，包括家门口的儿化音 \\\\> 像花开在西湖边，不搞文化调查，只有我们搞得懂 \\\\> 你们都不懂，三不搭门，格儿，老儿，粉儿，伢儿，这外人分得清 \\\\> 出发，变化快，地铁交通发达，据说要去看看 \\\\> 包容新马泰，看十三太，为城市骄傲，性格直给 \\\\> 感情你只为过桥，而且味道不一样，你不来嘞 > 仅展示部分效果。 |
| --- | --- |

\### 歌词字幕生成

| > 请你识别这首歌的歌词，并分句给出歌词的时间戳，输出格式如下：\\\\\[00:00:15,020 --> 00:00:28,085\\\\] ：When you walk through a storm, hold your head up high.\\\\\[00:00:28,085 --> 00:00:40,200\\\\] And don't be afraid of the dark. ...... | \\\\\[00:00:12,680 --> 00:00:16,960\\\\] 猫线绕过树摇晃的月光 \\\\\[00:00:18,400 --> 00:00:22,800\\\\] 暖气片哼着九八年排行 \\\\\[00:00:24,160 --> 00:00:28,080\\\\] 时间拨开云雾般的热浪 \\\\\[00:00:28,920 --> 00:00:33,000\\\\] 屏幕里的霓虹晒在鼻梁 ...... \\\\\[00:03:16,720 --> 00:03:21,680\\\\] 我们窝在年轮最柔软一墙 \\\\\[00:03:22,400 --> 00:03:27,000\\\\] 呼吸被余温酿成蜂蜜糖 \\\\\[00:03:28,160 --> 00:03:33,200\\\\] 沙发陷落成云絮的形状 \\\\\[00:03:34,000 --> 00:03:38,800\\\\] 每个毛孔都晒着晴朗 \\\\\[00:04:09,000 --> 00:04:10,020\\\\] (End) > 仅展示部分效果。 |
| --- | --- |

\### \*\*音视频编程\*\*

|     |     |
| --- | --- |

\## \*\*使用方式\*\*
\#### \*\*流式输出\*\*
所有对 Qwen-Omni 模型的请求都必须设置 `stream=True`。
\#### \*\*模型配置\*\*
根据使用场景，为模型配置合适的参数、提示词、音视频长度，可在成本、速度和效果之间找到平衡。
\## 音视频理解

| \*\*使用场景\*\* | \*\*推荐视频长度\*\* | \*\*Prompt 建议\*\* | \*\*max\\\\\_pixels 推荐参数值\*\* |
| --- | --- | --- | --- |
| 快速审核，成本低 | ≤60分钟 | 50 个词以内的简单 Prompt | 230,400 |
| 内容提取（长视频分段） | ≤60分钟 | 921,600\~2,073,600 |
| 标准分析（短视频打标） | ≤4分钟 | 使用下方的结构化 Prompt \*\*建议Prompt\*\* ```` Provide a detailed description of the video. It should explicitly include three sections: 1. A structured chronological storyline of \*\*every noticeable audio and visual details\*\* 2. A structured list of all visible text. For each text element, include start timestamp, end timestamp, the exact text content, the appearance characteristics. If no text appears, explicitly state so. 3. A structured speech-to-text transcription, include speaker（Corresponding to the character or voice‑over in Section 1, including their accent and tone）, exact spoken content, start timestamp, end timestamp, and speaking state (prosody, emotion, and style). If no speech appears, explicitly state so. Aside from these three required sections, you are free to organize any additional content in any way you find helpful. This additional content can include global information about the entire video or localized information about specific moments. You may choose the topic of this extra content freely. Output Format: ``` ## Storyline <xx:xx.xxx> - <xx:xx.xxx> <an unstructured long paragraph in natural language describing what happened during this period, blending both audio and video details.> <xx:xx.xxx> - <xx:xx.xxx> <an unstructured long paragraph in natural language describing what happened during this period, blending both audio and video details.> <xx:xx.xxx> - <xx:xx.xxx> <an unstructured long paragraph in natural language describing what happened during this period, blending both audio and video details.> ... ## Visible Text <xx:xx.xxx> - <xx:xx.xxx> “<element>”: <appearance> “<element>”: <appearance> <xx:xx.xxx> - <xx:xx.xxx> “<element>”: <appearance> “<element>”: <appearance> “<element>”: <appearance> <xx:xx.xxx> - <xx:xx.xxx> “<element>”: <appearance> ... ## Speakers and Transcript Speaker profiles: <speaker> - <profile> <speaker> - <profile> <speaker> - <profile> ... <xx:xx.xxx> - <xx:xx.xxx> Speaker: <speaker> State: <description> Content: “<content>” <xx:xx.xxx> - <xx:xx.xxx> Speaker: <speaker> State: <description> Content: “<content>” <xx:xx.xxx> - <xx:xx.xxx> Speaker: <speaker> State: <description> Content: “<content>” ... ## <another section> <paragraphs> ## <another section> <paragraphs> ... ``` ```` | 921,600\~2,073,600 |
| 精细分析（多说话人/复杂场景） | ≤2分钟 | 2,073,600 |

\*\*说明\*\*
长视频如需获得细粒度的描述，建议分段处理。
\## 音频理解
通过控制音频长度和 Prompt 复杂度来平衡成本与效果。

| \*\*使用场景\*\* | \*\*推荐音频长度\*\* | \*\*Prompt 建议\*\* |
| --- | --- | --- |
| 快速审核、低成本 | ≤60分钟 | 50 个词以内的简单 Prompt |
| 内容提取（长音频分段） | ≤60分钟 |
| 标准分析（音频打标） | ≤2分钟 | 使用结构化 Prompt \*\*结构化Prompt\*\* ```` Provide a detailed description of the audio. It should explicitly include two sections: 1. A structured chronological storyline of \*\*every noticeable audio details\*\* 2. A structured speech-to-text transcription, include speaker（Corresponding to the character or voice‑over in Section 1, including their accent and tone）, exact spoken content, start timestamp, end timestamp, and speaking state (prosody, emotion, and style). If no speech appears, explicitly state so. Aside from these two required components, you are free to organize any additional content in any way you find helpful. This additional content can include global information about the entire audio or localized information about specific moments. You may choose the topic of this extra content freely. Output Format: ``` ## Storyline <xx:xx.xxx> - <xx:xx.xxx> <an unstructured long paragraph in natural language describing what happened during this period, blending both audio details.> <xx:xx.xxx> - <xx:xx.xxx> <an unstructured long paragraph in natural language describing what happened during this period, blending both audio details.> <xx:xx.xxx> - <xx:xx.xxx> <an unstructured long paragraph in natural language describing what happened during this period, blending both audio details.> ... ... ## Speakers and Transcript Speaker profiles: <speaker> - <profile> <speaker> - <profile> <speaker> - <profile> ... <xx:xx.xxx> - <xx:xx.xxx> Speaker: <speaker> State: <description> Content: “<content>” <xx:xx.xxx> - <xx:xx.xxx> Speaker: <speaker> State: <description> Content: “<content>” <xx:xx.xxx> - <xx:xx.xxx> Speaker: <speaker> State: <description> Content: “<content>” ... ## <another section> <paragraphs> ## <another section> <paragraphs> ... ``` ```` |
| 精细分析（多说话人/复杂场景） | ≤1分钟 |

\*\*说明\*\*
长音频如需获得细粒度的描述，建议分段处理。
\## \*\*多模态组合输入\*\*
\*\*说明\*\*
多模态组合输入仅 Qwen3.5-Omni 系列支持。您可以在同一请求中同时传入多种模态的数据（例如图片+音频+文本、视频+图片+文本等任意组合）。
以下示例展示如何在一个请求中同时传入图片和音频，并让模型综合分析多种模态的内容。
---
*← 返回 [README](./README.md)*
