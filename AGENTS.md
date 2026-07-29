# Global encoding precautions

- When reading, editing, or generating files that contain Chinese text on Windows, treat encoding as a first-class concern.
- Prefer UTF-8 for new files and when rewriting files. Do not assume legacy Windows Chinese files are UTF-8; they may be GBK/ANSI.
- Before modifying a file with Chinese text that appears garbled, check whether the issue is terminal display encoding, file encoding mismatch, or already-corrupted content.
- Avoid rewriting non-UTF-8 files after reading them with the wrong encoding. If conversion is needed, preserve the original content and convert deliberately.
- For PowerShell commands that write Chinese text, specify UTF-8 explicitly where applicable, for example `Set-Content -Encoding utf8` or `Out-File -Encoding utf8`.
- If terminal output shows garbled Chinese, consider setting UTF-8 output for the session before diagnosing file corruption: `chcp 65001`, `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`, and `$OutputEncoding = [System.Text.Encoding]::UTF8`.
- 禁止使用格式化命令批量修改文件

# AI-assisted commit attribution

- When Codex materially contributes code, tests, documentation, review fixes, or implementation decisions to a commit, include the exact trailer `Co-authored-by: Codex <noreply@openai.com>` in that commit message.
- When Qoder materially contributes code, tests, documentation, review fixes, or implementation decisions to a commit, include the exact trailer `Co-authored-by: Qoder <noreply@qoder.com>` in that commit message.
- Do not add an AI trailer when the agent only performs a read-only check or gives advice without contributing to the committed result.

# 命令路由表（改动层 → 验证命令）

以下命令均在仓库根目录直接运行（前置条件：已执行 `npm install`；Rust 相关命令需要本机 cargo 工具链；驱动与 Watch Mode 真实链路等 Windows 专属命令需要 Windows PowerShell，测试/门禁编排脚本均为 Node 实现）。

| 改动层 | 验证命令 | 说明 |
| --- | --- | --- |
| `apps/desktop` 前端（src、vite、TS/React） | `npm run verify:desktop` | 依次执行 lint + tsc 检查 + vitest + 构建；PR CI 另行强制覆盖率门禁与架构边界审计，本地对应 `npm run coverage:gate`（首次需先 `npm run coverage:tooling`）与 `npm run audit:architecture` |
| `apps/desktop/src-tauri`（Rust 桌面壳） | `npm run test:desktop-shell` | cargo test；仅需类型/编译检查可用 `npm run check:desktop-shell` |
| `apps/bridge-service-native`（Rust 桥接服务） | `npm run check:bridge-service-native` + `npm run test:integration:bridge-contract` | cargo check + 桥接契约集成测试；PR CI 运行的是完整 `npm run test:bridge-service-native`（cargo test），提交前建议本地跑齐 |
| 跨进程契约变更（事件/命令/协议） | `npm run test:contracts` | Node 契约校验脚本（含配置路径守卫） |
| Rust 侧新增/改动配置 `.pointer` 读写 | `npm run test:config-paths` | 配置路径守卫：路径必须在 `app-config.default.json` 可解析或有成文豁免；`--report-defaults` 产出默认值清点 |
| `drivers/windows-virtual-mic`（虚拟麦克风驱动） | `npm run test:driver-boundaries`；`npm run driver:build-sysvad` | 前者为纯 Node 边界测试（无需 WDK/管理员，PR CI 同款快速信号）；后者需要 WDK/EWDK 构建环境，PR CI 会对触碰 `drivers/**` 的变更自动运行同款构建（`.github/workflows/driver-build.yml`，机械编译信号）；驱动自测用 `npm run driver:test`；进入该目录前必读 [drivers/windows-virtual-mic/AGENTS.md](drivers/windows-virtual-mic/AGENTS.md) |
| 翻译链路性能改动（首字/首句延迟等） | `npm run test:watch-mode-evidence:strict` | strict 模式对 `firstVisibleTranslationLatencySeconds` 等已产出延迟字段做阈值断言（默认 8s/15s，可用 `--latency-thresholds 字段=秒` 覆盖或 `=off` 关闭）；证据需先由 `npm run test:watch-mode-live:matrix` 产出；脚本自测用 `npm run test:watch-mode-report` |
| 发布前 / 提交合并前全量门禁 | `npm run quality:gate:release` | 综合质量门禁（Node 脚本） |

# 运行时诊断路由（最小索引）

- 运行时日志：`artifacts/diagnostics/logs/app.log`；应用内诊断导出位于 `artifacts/diagnostics/exports/`。
- 诊断脚本入口：[scripts/diagnostics/README.md](scripts/diagnostics/README.md)（环境检查、IPC 自测、凭据/实时链路探针；其中 `omni-benchmark` 提供延迟/性能基准，用于量化 provider 段耗时）。
- 按进程的复现与排查起点：
  - desktop（前端 + Tauri 壳）：[apps/desktop/AGENTS.md](apps/desktop/AGENTS.md)
  - bridge（Rust 桥接服务）：[apps/bridge-service-native/README.md](apps/bridge-service-native/README.md)
  - driver（虚拟麦克风驱动）：[drivers/windows-virtual-mic/AGENTS.md](drivers/windows-virtual-mic/AGENTS.md)
