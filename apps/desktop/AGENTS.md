# apps/desktop 组件说明

桌面端应用（Tauri 2 + React + Vite），包含两层：

- 前端层：`src/`、`index.html`、`overlay.html`、`vite.config.ts` 等（TypeScript/React）
- 桌面壳层：`src-tauri/`（Rust，Tauri 后端）

## 验证入口（在仓库根目录运行）

| 改动范围 | 验证命令 |
| --- | --- |
| 前端代码 | `npm run verify:desktop`（lint + tsc + vitest + 构建） |
| `src-tauri` Rust 代码 | `npm run test:desktop-shell`；仅编译检查用 `npm run check:desktop-shell` |
| 涉及跨进程契约（事件/命令/协议） | 额外运行 `npm run test:contracts` |

## 边界约束

- 前端与 Rust 壳之间只通过 Tauri 命令/事件通信，契约变更必须同步两侧并通过契约校验。
- 不要在本目录内直接调用 `apps/bridge-service-native` 的内部实现，只依赖既定协议。
