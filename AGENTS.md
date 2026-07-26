# Global encoding precautions

- When reading, editing, or generating files that contain Chinese text on Windows, treat encoding as a first-class concern.
- Prefer UTF-8 for new files and when rewriting files. Do not assume legacy Windows Chinese files are UTF-8; they may be GBK/ANSI.
- Before modifying a file with Chinese text that appears garbled, check whether the issue is terminal display encoding, file encoding mismatch, or already-corrupted content.
- Avoid rewriting non-UTF-8 files after reading them with the wrong encoding. If conversion is needed, preserve the original content and convert deliberately.
- For PowerShell commands that write Chinese text, specify UTF-8 explicitly where applicable, for example `Set-Content -Encoding utf8` or `Out-File -Encoding utf8`.
- If terminal output shows garbled Chinese, consider setting UTF-8 output for the session before diagnosing file corruption: `chcp 65001`, `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`, and `$OutputEncoding = [System.Text.Encoding]::UTF8`.
- 禁止使用格式化命令批量修改文件

# 命令路由表（改动层 → 验证命令）

以下命令均在仓库根目录直接运行（前置条件：已执行 `npm install`；Rust 相关命令需要本机 cargo 工具链；PowerShell 脚本类命令需要 Windows PowerShell）。

| 改动层 | 验证命令 | 说明 |
| --- | --- | --- |
| `apps/desktop` 前端（src、vite、TS/React） | `npm run verify:desktop` | 依次执行 lint + tsc 检查 + vitest + 构建 |
| `apps/desktop/src-tauri`（Rust 桌面壳） | `npm run test:desktop-shell` | cargo test；仅需类型/编译检查可用 `npm run check:desktop-shell` |
| `apps/bridge-service-native`（Rust 桥接服务） | `npm run check:bridge-service-native` | cargo check；完整测试用 `npm run test:bridge-service-native` |
| 跨进程契约变更（事件/命令/协议） | `npm run test:contracts` | Node 契约校验脚本 |
| `drivers/windows-virtual-mic`（虚拟麦克风驱动） | `npm run driver:build-sysvad` | 需要 WDK/EWDK 构建环境；驱动自测用 `npm run driver:test`；进入该目录前必读 [drivers/windows-virtual-mic/AGENTS.md](drivers/windows-virtual-mic/AGENTS.md) |
| 发布前 / 提交合并前全量门禁 | `npm run quality:gate:release` | 综合质量门禁（PowerShell 脚本） |

# 运行时诊断路由（最小索引）

- 运行时日志：`artifacts/diagnostics/logs/app.log`；应用内诊断导出位于 `artifacts/diagnostics/exports/`。
- 诊断脚本入口：[scripts/diagnostics/README.md](scripts/diagnostics/README.md)（环境检查、IPC 自测、凭据/实时链路探针）。
- 按进程的复现与排查起点：
  - desktop（前端 + Tauri 壳）：[apps/desktop/AGENTS.md](apps/desktop/AGENTS.md)
  - bridge（Rust 桥接服务）：[apps/bridge-service-native/README.md](apps/bridge-service-native/README.md)
  - driver（虚拟麦克风驱动）：[drivers/windows-virtual-mic/AGENTS.md](drivers/windows-virtual-mic/AGENTS.md)
