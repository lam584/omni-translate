# c03 AEC 开放输入闭环验收

本契约只升级既有 AEC c03，不引入短视频场景，不替代四机矩阵或发布门禁。

## 固定策略

- Provider：qwen3.8-livetranslate-flash-realtime；沿用签名素材、真实端点及 double-talk、80ms delay、160ms delay + soft-clip 三阶段。
- 完成策略：aec-output-quiescent-v2。media-complete 不关闭采集；响应、字幕覆盖和物理播放排空后，连续 2 秒无新语音/输出/播放活动，且此期间有至少 32,000 个16k输入样本的真实成功 socket append，才批准 input-complete。新活动重置静稳。
- 正常顺序：media-complete → quiet-approved → capture/provider fence → session.finish → session.finished → 封存。finish 后出现新译音必须失败；watchdog 清理不是成功。
- 原始预算维持：输入180秒、Provider终态15秒、播放排空120秒、报告10秒、总325秒。每个会话签名样本上限2,880,000，账本记录实际发送样本；预算超限失败。

## 不可放宽的门禁

- 连续 native render stream：800ms启动缓冲，1000ms最长缓冲等待；End立即flush短尾。不得等整段或audio.done才播放。
- 真实录音重建首译音：在英文播放期间；有声模型输入→译音≤8s；每个完整cue的首可播放音频delta→首实际译音≤1.5s；长响应在audio.done前产生声学输出。不是render入队时间。
- 每一个完整cue，包括末尾，必须有可信声学身份、头尾匹配和完整录音。保留字幕8s/15s及所有原门禁。
- 双参考独立分离英文源与译音；非线性参考来自实际变换后的render PCM。各阶段的有效译音贡献衰减≥20dB，英文增益±3dB，语音覆盖≥95%。时钟/数据/参考不足为不可判定且不通过；不允许总体平均掩盖单阶段失败。
- 录制 pre/post-AEC、render、物理播放及实际Provider输入；逐帧绑定来源、QPC、session/owner、padding、reset/continuity。不能静音、丢块、改模式或进程排除换绿。

## 冻结与证据

签名 aec-threshold-freeze.json 固定阈值、run/cell/lease身份及runtimeBinaryHashes；tap在付费启动前捕获冻结哈希。worker由封存PCM和类型化事件机械重建aec-closed-loop-evidence.json，随后纳入artifact库存；最终校验器只重建已经库存封存的清单，不补写缺失证据。

独立分析仅调用库存绑定的target/release/omni-benchmark.exe，分析前后核验哈希；验收过程中禁止编译或替换。原retained-PCM仍是diagnosticOnly，未晋升正式门禁。

## 无付费验证与运行入口

- npm run test:watch-mode-aec-closed-loop
- npm run test:watch-mode-report
- npm run test:watch-mode-coordinator-tooling
- npm run test:desktop-shell；npm run test:bridge-service-native；npm run test:integration:bridge-contract；npm run test:contracts
- benchmark核心所需：test:benchmark-core、test:diagnostics-benchmark、audit:dead-code、audit:architecture、coverage:gate:base。核心变更仍须人工审查。

付费只能通过现有生产coordinator，显式execution-scope=aec-c03-iteration及aec-worker=vm131或vm171，并提供同样的签名分片、固定身份、交互会话、凭据引用、冻结runtime和用量授权；不能直接调用Provider。单场景保存到独立AEC迭代证据根，未运行场景标记not-run，不更新矩阵latest-successful索引。

离线门禁或必要验证未通过时不运行付费会话。每轮仅一个c03；失败先记录测试工具/生产实现/环境/Provider归因。没有新判别证据、验证补丁或外部恢复依据时不重跑。

最终要求同一冻结实现连续三次成功：vm131一次、vm171两次；期间改代码/阈值则重新计数。达成后只能宣称新版AEC单场景通过。

## 待决输入所有权与收尾反例

speech_stopped 只结束当前VAD活动，不代表模型已经响应。类型化账本将每个已接收输入owner保留为pendingInputSegments，直到生产ResponseLedger提供对应source item/response绑定，并收到该响应成功的response.done。不得用最近一个响应、一次空队列或ASR完成替代这个终态。audio.done也不能清除待决输入。

- response.created晚于speech_stopped三秒：2秒静稳期间仍保持开放，不能提前批准input-complete。
- response.created或response.done早于speech_stopped：响应终态与VAD活动分别判断；有活动语音仍不能收尾。
- ASR final晚于response.done：保留已完成的真实绑定，不重新打开旧owner，但该新输入文本活动重置静稳。
- 未知/缺失/矛盾的owner不能通过。没有明确响应终态的空VAD不做猜测性完成；不可判定保留为失败/看门狗上限。
- outputQuiescent和finishOutputChecked均要求pendingInputSegments=0；没有此字段的旧证据拒绝。
- 实时性逐完整cue验收。首条cue及时不能抵消后续cue积压；16秒后才出声、即便发生在audio.done之前，也不满足1.5秒门槛。

## 本次实施记录

本地隔离快照、验证日志及外部阻塞receipt保存在artifacts/testing/aec-iteration。具体执行状态以该目录最新日志和交付状态文件为准，不将未运行的付费验收标为通过。

### 已实施，但不是设备通过声明

连续native增量render、开放输入状态机、逐帧Provider PCM来源绑定、独立双参考分析、版本化收尾/物理实时门禁、签名单c03范围及2,880,000样本上限均已落地。修复强reset代际被后续underrun覆盖的问题；post-ACK证据I/O失败保持sticky失败，不改变已发生的物理ACK。

本地日志包括零PCM、整体降音量、原样透传、源音丢失、错参考/时间轴、非线性残留、尾音裁切、证据篡改、预算/worker越权、提前关闭、延迟响应及后续cue积压等离线反例。原retained-PCM工具仍为diagnosticOnly。冻结目标20dB/±3dB/95%及8s/1.5s均未放宽。

### 尚未闭合的前置门禁

- architecture审计有8个冻结源快照已存在的未基线化违规；AEC没有新增豁免，但该命令仍是失败。
- coverage:gate:base的前端branches为93.14%，低于原95%门槛。前端及相关配置与源快照相同；归因并不是通过或豁免。共享Rust覆盖率的独立通过不能替代这个完整门禁。
- vm131最近一次零Provider SSH预检22端口连接超时；尚无恢复证据。
- 仍须人工审查核心变更。

因此本次没有发起付费Provider会话、没有正式运行冻结包及三次物理验收证据，连续通过计数为0/3。不能称新版AEC场景已通过，更不能更新四机矩阵成功索引。恢复后须先解决未通过的门禁、完成最终提交/构建/签名冻结，再按vm131一次、vm171两次顺序验收；实现一旦变化重新计数。

### 最终本地验证记录

| 验证 | 本地结果 | 证据日志（artifacts/testing/aec-iteration） |
| --- | --- | --- |
| test:watch-mode-aec-closed-loop | 83通过、0失败、0跳过；冻结analyzer二进制测试实际执行 | aec-offline-v8.log |
| test:desktop-shell | 1607通过、0失败、5项原有ignored | desktop-shell-v8.log |
| test:watch-mode-report | 两阶段合计683通过、0失败；1项已退役legacy coordinator测试跳过，未计为新版AEC通过 | watch-report-v6.log |
| test:watch-mode-coordinator-tooling | 726通过、0失败、0跳过 | coordinator-tooling-v5.log |
| test:contracts | 通过；Provider 16 tests、7 manifests/100 fixtures | contracts-v7.log |
| test:bridge-service-native | 234通过、0失败、1项ignored，doctest通过 | bridge-tests-v7.log |
| test:integration:bridge-contract | 18通过 | bridge-contract-v7.log |
| test:benchmark-core | 28通过 | benchmark-core-v7.log |
| test:diagnostics-benchmark | 54通过 | diagnostics-benchmark-v7.log |
| audit:dead-code | 通过 | dead-code-v7.log |
| 共享Rust覆盖率补测 | lines95.04%、functions94.92%、branches83.33%，通过既有86.19/88.65/60棘轮；不是完整coverage gate通过 | shared-crates-coverage-v5.json |
| audit:architecture | 失败：与源快照相同的8项问题，不新增豁免 | architecture-v10.log、architecture-snapshot.log |
| coverage:gate:base | 失败：前端branches93.14% <95%；不放宽阈值 | coverage-base.log、baseline-attribution.json |

implementation-triage-v6.json记录代码/测试工具/夹具归因及外部阻塞；delivery-status.json记录最终提交、日志哈希、实际付费输入0及0/3验收状态。源快照294文件的hash、原HEAD和git status保持不变，见workspace-preservation-v5.json及最终交付状态。日志和运行环境保留在当前隔离工作树，不能在未另存这些ignored证据前归档该工作树。

暂存区检查已修正15个新文件的CRLF/额外EOF空行，仅进行可审计的换行转换，未运行formatter或改写代码token。转换后重新通过桌面壳、bridge、benchmark核心、独立诊断CLI、契约、桥接契约及83项AEC离线测试，并重建用于离线分析的release analyzer。不是正式付费运行冻结包。另确保admitted模型事件在可失败的静稳检查前写入trace，finish之后释放新输出而失败时不会丢掉该事件证据。
