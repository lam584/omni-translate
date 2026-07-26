# drivers/windows-virtual-mic 组件说明

Windows 虚拟麦克风内核驱动（基于 sysvad 示例改造），为桌面端提供虚拟音频输入设备。

- `src/`、`include/`、`inf/`：驱动源码、头文件与 INF 安装配置
- `sysvad/`：sysvad 基础代码
- `package/`、`tools/`、`tests/`：打包、工具与测试资产
- 构建细节见本目录 `BUILDING.md`

## 验证入口（在仓库根目录运行）

| 改动范围 | 验证命令 | 前置条件 |
| --- | --- | --- |
| 驱动源码 / INF | `npm run driver:build-sysvad` | 需要 WDK/EWDK 构建环境 |
| 驱动安装链路 | `npm run driver:test` | 需要管理员权限与测试签名环境 |

## 边界约束

- 驱动与桥接服务（`apps/bridge-service-native`）之间的接口变更需同步 `npm run test:contracts` 覆盖的契约。
- 驱动安装/卸载/修复统一走根目录 `driver:*` 脚本，不要手工操作设备管理器状态。
