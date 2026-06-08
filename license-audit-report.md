## Omni Translate 依赖与许可证分析报告

分析日期：2026-06-08

### 项目概况

Omni Translate 是一个基于 npm workspace + Cargo 的 monorepo 项目，包含以下子项目：

- `apps/desktop` — Tauri 桌面应用（前端 React + 后端 Rust）
- `apps/bridge-service-native` — Rust 原生桥接服务
- `scripts/diagnostics/` — 3 个 Rust 诊断工具

---

### 一、依赖总览

#### NPM 直接依赖（8 个生产 + 18 个开发）

**生产依赖：**

| 包名 | 版本 | 许可证 |
|------|------|--------|
| @tauri-apps/api | ^2.11.0 | Apache-2.0 OR MIT |
| i18next | ^26.3.0 | MIT |
| i18next-browser-languagedetector | ^8.2.1 | MIT |
| react | 19.2.7 | MIT |
| react-dom | 19.2.7 | MIT |
| react-i18next | ^17.0.8 | MIT |
| react-router-dom | ^7.16.0 | MIT |
| zustand | ^5.0.14 | MIT |

**开发依赖：**

| 包名 | 版本 | 许可证 |
|------|------|--------|
| @eslint/js | ^10.0.1 | MIT |
| @tauri-apps/cli | ^2.11.2 | Apache-2.0 OR MIT |
| @types/react | 19.2.16 | MIT |
| @types/react-dom | 19.2.3 | MIT |
| @vitejs/plugin-react | ^6.0.2 | MIT |
| @vitest/coverage-v8 | ^4.1.8 | MIT |
| eslint | ^10.4.1 | MIT |
| eslint-plugin-react-hooks | ^7.1.1 | MIT |
| eslint-plugin-react-refresh | ^0.5.2 | MIT |
| globals | ^17.6.0 | MIT |
| jsdom | ^29.1.1 | MIT |
| magic-string | ^0.30.21 | MIT |
| obug | ^2.1.1 | MIT |
| rolldown | ^1.0.3 | MIT |
| typescript | ^6.0.3 | Apache-2.0 |
| typescript-eslint | ^8.60.1 | MIT |
| vite | ^8.0.16 | MIT |
| vitest | ^4.1.8 | MIT |

**NPM 传递依赖许可证分布（共约 244 个包）：**

| 许可证 | 数量 | 说明 |
|--------|------|------|
| MIT | 188 | 最常见，高度宽松 |
| Apache-2.0 | 17 | 宽松 |
| ISC | 12 | 宽松（semver, picocolors 等） |
| BSD-2-Clause | 8 | 宽松 |
| BSD-3-Clause | 6 | 宽松 |
| Apache-2.0 OR MIT | 3 | 双许可（Tauri 包） |
| MIT-0 | 2 | MIT 无需署名变体 |
| MPL-2.0 | 2 | 弱传染性（lightningcss） |
| BlueOak-1.0.0 | 2 | 现代宽松许可 |
| CC-BY-4.0 | 1 | 知识共享署名（caniuse-lite） |
| CC0-1.0 | 1 | 公共领域（mdn-data） |

#### Rust 直接依赖

**omni-desktop-shell（apps/desktop/src-tauri）：**

| 依赖 | 版本 | 许可证 |
|------|------|--------|
| chrono | 0.4 | MIT OR Apache-2.0 |
| cpal | 0.17.3 | Apache-2.0 |
| hound | 3.5.1 | Apache-2.0 |
| keyring | 4 | MIT OR Apache-2.0 |
| log | 0.4 | MIT OR Apache-2.0 |
| base64 | 0.22.1 | MIT OR Apache-2.0 |
| minimp3 | 0.6.1 | MIT |
| reqwest | 0.13 | MIT OR Apache-2.0 |
| rodio | 0.22.2 | MIT OR Apache-2.0 |
| rusqlite | 0.40 | MIT（捆绑的 SQLite3 为公共领域） |
| serde | 1 | MIT OR Apache-2.0 |
| serde_json | 1 | MIT OR Apache-2.0 |
| tauri | 2 | Apache-2.0 OR MIT |
| uuid | 1 | Apache-2.0 OR MIT |
| tungstenite | 0.29 | MIT OR Apache-2.0 |
| url | 2 | MIT OR Apache-2.0 |
| wasapi | 0.23.0 | MIT |
| whatlang | 0.18 | MIT |
| windows-sys | 0.61.2 | MIT OR Apache-2.0 |
| tauri-build（构建） | 2 | Apache-2.0 OR MIT |
| tempfile（开发） | 3 | MIT OR Apache-2.0 |

**omni-bridge-service（apps/bridge-service-native）：**

| 依赖 | 版本 | 许可证 |
|------|------|--------|
| cpal | 0.17.3 | Apache-2.0 |
| minimp3 | 0.6 | MIT |
| rodio | 0.22.2 | MIT OR Apache-2.0 |
| serde | 1 | MIT OR Apache-2.0 |
| serde_json | 1 | MIT OR Apache-2.0 |
| wasapi | 0.23.0 | MIT |
| windows-sys | 0.61.2 | MIT OR Apache-2.0 |
| tempfile（开发） | 3.14.0 | MIT OR Apache-2.0 |

**诊断工具依赖（scripts/diagnostics/）：**

| 依赖 | 使用的 crate | 许可证 |
|------|-------------|--------|
| base64 | omni-realtime, omni-benchmark | MIT OR Apache-2.0 |
| minimp3 | omni-realtime, omni-benchmark | MIT |
| rustls | omni-realtime, omni-benchmark | Apache-2.0 OR ISC OR MIT |
| serde | omni-benchmark | MIT OR Apache-2.0 |
| serde_json | omni-realtime, omni-benchmark | MIT OR Apache-2.0 |
| tungstenite | omni-realtime, omni-benchmark | MIT OR Apache-2.0 |
| windows-sys | credential-write | MIT OR Apache-2.0 |

---

### 二、许可证兼容性分析

#### 与 Apache 2.0 的兼容性

项目所有依赖均使用宽松许可证，与 Apache 2.0 完全兼容，不存在 GPL、AGPL、LGPL 等强传染性许可证。

#### 需关注的许可证

| 许可证 | 涉及的包 | 风险等级 | 说明 |
|--------|---------|---------|------|
| MPL-2.0 | lightningcss（Vite 传递依赖） | 低 | 文件级弱传染性。仅修改其源码并分发时才需共享修改，作为依赖使用无影响 |
| CDLA-Permissive-2.0 | webpki-roots | 低 | 非标准数据许可证，用于 Mozilla 根证书数据。宽松且允许商用 |
| Apache-2.0 AND ISC | ring（rustls 传递依赖） | 低 | 组合许可，两部分均为宽松许可，需同时遵守两者 |
| ISC AND (Apache-2.0 OR ISC) | aws-lc-rs/aws-lc-sys（reqwest 传递依赖） | 低 | 组合许可，所有部分均为宽松许可 |
| BlueOak-1.0.0 | lru-cache, minimatch | 无 | 现代宽松许可，MIT 的现代化替代 |
| CC-BY-4.0 | caniuse-lite | 无 | 构建时数据库，生产构建中通常不触发署名要求 |

#### Linux 平台注意事项

如果未来项目扩展到 Linux 平台，以下传递依赖会链接 LGPL-2.1 的系统库：

- `alsa-sys` → libasound2（LGPL-2.1）
- GTK3 系列 → GTK3 库（LGPL-2.1）
- `libdbus-sys` → libdbus（LGPL-2.1）

Rust 绑定默认采用动态链接，只要不静态链接这些 LGPL 库，就不会触发传染性条款。当前项目仅面向 Windows 构建，不受影响。

#### drivers/windows-virtual-mic/sysvad

该目录包含 Microsoft SYSVAD 驱动示例代码，保留 Microsoft 原始版权声明，属于第三方代码，不受项目许可证覆盖。

---

### 三、已完成的变更

项目许可证已从「私有许可证（Private）」变更为 **Apache License 2.0**。具体修改如下：

| 文件 | 变更内容 |
|------|---------|
| `LICENSE`（新建） | 添加完整的 Apache License 2.0 文本 |
| `package.json` | 添加 `"license": "Apache-2.0"` |
| `apps/desktop/package.json` | 添加 `"license": "Apache-2.0"` |
| `apps/desktop/src-tauri/Cargo.toml` | 添加 `license = "Apache-2.0"` |
| `apps/bridge-service-native/Cargo.toml` | 添加 `license = "Apache-2.0"` |
| `scripts/diagnostics/credential-write/Cargo.toml` | 添加 `license = "Apache-2.0"` |
| `scripts/diagnostics/omni-realtime/Cargo.toml` | 添加 `license = "Apache-2.0"` |
| `scripts/diagnostics/omni-benchmark/Cargo.toml` | 添加 `license = "Apache-2.0"` |
| `README.md` | 许可证章节更新为 Apache License 2.0 |
| `i18n/README_en.md` | License 章节更新为 Apache License 2.0 |

---

### 四、结论

项目依赖许可证状况非常健康。全部 244 个 NPM 包和所有 Rust crate 依赖均使用宽松许可证（MIT、Apache-2.0、ISC、BSD 等），无 GPL/AGPL 等强传染性许可证。项目可以安全地采用 Apache License 2.0 发布，不会与任何依赖的许可证产生冲突。
