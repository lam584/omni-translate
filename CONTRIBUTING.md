# 为 Omni Translate 做贡献

感谢你愿意帮助改进 Omni Translate。项目涉及 Windows 桌面界面、Rust 音频运行时、Native Bridge、虚拟音频驱动以及跨进程协议；请先确认改动边界，并提交可复现、可验证的变更。

参与本项目即表示你同意遵守 [行为准则](CODE_OF_CONDUCT.md)。安全漏洞请按照 [安全策略](SECURITY.md) 私下报告，不要创建公开 Issue。

## 开始之前

1. 搜索现有 Issue 和 Pull Request，避免重复工作。
2. Bug 请使用 Bug 报告模板，并附最小复现步骤、Windows 版本和脱敏后的诊断信息。
3. 较大的功能、协议变更、驱动 ABI 变更或架构重构，请先创建功能请求并说明设计与兼容性影响。
4. 首次贡献建议从文档、测试或边界清晰的小型修复开始。

## 开发环境

基本要求：

- Windows 10/11；
- Node.js 20 或更高版本；
- Rust stable 工具链；
- 构建 Tauri 与 Native Bridge 时需要 Visual Studio 2022 Build Tools（Desktop development with C++）；
- 驱动开发需要 WDK 10.0.26100，并可能需要管理员权限与 TESTSIGNING 环境。

安装依赖并启动前端：

```powershell
npm ci
npm run dev:desktop
```

启动完整桌面应用：

```powershell
npm run dev:desktop-shell
```

完整桌面链路可能触发 UAC。不要为了运行普通前端测试而安装或修改驱动。

## 仓库约束

- 修改任何目录前，阅读仓库根目录以及目标目录中的 `AGENTS.md`。
- 前端与 Tauri 壳只通过已有命令和事件契约通信；跨进程变更必须同步协议两端。
- 不要绕过统一的驱动安装、卸载或修复脚本手动修改设备状态。
- 不要提交 API Key、凭据、个人日志、诊断导出、构建产物、`.env.local` 或 `.codex/`。
- Windows 中文文件可能是 UTF-8、GBK 或 ANSI。发现乱码时先确认文件编码与终端编码，禁止在错误编码下重写文件。
- 禁止用格式化工具或脚本无差别批量改写仓库。

## 分支和提交

- 从最新的 `main` 创建主题分支；一个 Pull Request 聚焦一个目标。
- 使用清晰的 Conventional Commit 标题，例如 `fix(audio): ...`、`feat(driver): ...`、`docs: ...`。
- 不要混入无关重构、生成文件或个人工具配置。
- Codex 对提交有实质贡献时，按 `AGENTS.md` 添加 `Co-authored-by: Codex <noreply@openai.com>`；仅提供建议或只读检查时不添加。
- Qoder 对提交有实质贡献时，按 `AGENTS.md` 添加 `Co-authored-by: Qoder <noreply@qoder.com>`；仅提供建议或只读检查时不添加。

## 验证要求

至少运行与改动层对应的命令：

| 改动范围 | 必需验证 |
| --- | --- |
| `apps/desktop` 前端 | `npm run verify:desktop` |
| `apps/desktop/src-tauri` | `npm run test:desktop-shell` |
| `apps/bridge-service-native` | `npm run test:bridge-service-native` |
| 跨进程命令、事件或协议 | `npm run test:contracts` |
| Rust 配置 `.pointer` 读写 | `npm run test:config-paths` |
| 虚拟音频驱动 | `npm run driver:build-sysvad`，适用时再运行 `npm run driver:test` |
| 发布候选或大型跨层改动 | `npm run quality:gate:release` |

如果某项验证受 WDK、管理员权限、真实音频设备、外部模型凭据或网络环境限制，请在 Pull Request 中明确写出“未运行”、原因和替代验证，不能用含糊的“应该可用”代替。

新增或修复行为时应补充回归测试。不要只追求覆盖率数字；断言应验证具体结果、错误类型、状态转换或协议字段。

## Pull Request 要求

Pull Request 应包含：

- 问题背景和用户可见影响；
- 解决方案与关键设计取舍；
- 实际运行的验证命令及结果；
- 未运行项目和原因；
- 涉及 UI 时的截图或短视频；
- 涉及音频、驱动或 Watch Mode 时的脱敏诊断证据；
- 配置、协议、兼容性、安全性、文档和多语言资源的影响；
- 关联 Issue，例如 `Closes #123`。

提交 PR 前，请确认差异中没有密钥、个人路径、无关格式化或本地生成文件，并确保工作区中的测试产物不会被提交。

## 评审与合并

维护者可能要求缩小范围、补充测试、更新契约或提供真实 Windows 链路证据。请优先回应阻断正确性、安全性和兼容性的问题。PR 通过必要检查并完成评审后，由维护者决定合并方式。

贡献一经合并，将按仓库的 [Apache License 2.0](LICENSE) 发布。
