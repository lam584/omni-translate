## 变更摘要

<!-- 用几句话说明改了什么，以及用户或系统能够观察到的结果。 -->

## 背景与关联 Issue

<!-- 为什么需要这项变更？使用 Closes #123 / Fixes #123 关联 Issue。 -->

## 实现说明

<!-- 说明关键设计、边界、取舍，以及没有采用的方案。 -->

## 验证

已运行：

- [ ] `npm run verify:desktop`（前端改动）
- [ ] `npm run test:desktop-shell`（Tauri/Rust 改动）
- [ ] `npm run test:bridge-service-native`（Native Bridge 改动）
- [ ] `npm run test:contracts`（跨进程契约改动）
- [ ] `npm run test:config-paths`（Rust 配置路径改动）
- [ ] `npm run driver:build-sysvad` / `npm run driver:test`（驱动改动）
- [ ] `npm run quality:gate:release`（发布候选或大型跨层改动）

实际结果：

<!-- 粘贴简洁结果。未运行的项目请说明原因及替代验证。 -->

## 证据

<!-- UI 请附截图/视频；音频、驱动、Watch Mode 请附脱敏后的诊断或测试证据。不适用请写 N/A。 -->

## 影响检查

- [ ] 改动范围单一，没有混入无关格式化或重构。
- [ ] 新行为或缺陷修复包含有效回归测试。
- [ ] 已同步相关的 TypeScript/Rust/Bridge/Driver 契约与 fixtures。
- [ ] 已评估配置默认值、迁移和向后兼容性。
- [ ] 已评估权限、凭据、日志、IPC 和依赖安全影响。
- [ ] 已更新相关文档与全部受影响的多语言资源，或说明不适用。
- [ ] 差异中不包含 API Key、个人数据、诊断原件、构建产物或 `.codex/`。
- [ ] 中文文件编码已核对，没有因终端乱码或批量改写而损坏。

## 发布与回滚

<!-- 说明部署/发布注意事项、功能开关、数据或配置迁移，以及必要时如何回滚。不适用请写 N/A。 -->
