// 导出约定：test-utils 不提供桶导出（barrel），全部使用深路径导入，例如
//   import { registerDomHarness } from '../test-utils/component-test-harness';
//   import { mountTestRoot } from '../test-utils/react-root';
//
// 原因：多个模块（i18n-stub、fake-bridge-harness、tauri-invoke-mock、
// driver-runtime-mock）被 hoisted 的 vi.mock 工厂通过动态 import 深路径引用，
// 必须保持依赖图最小；桶导出会把整个 test-utils 图拉进 mock 作用域，
// 也会造成"部分走桶、部分走深路径"的混用。本文件故意不导出任何符号，
// 从 '../test-utils' 导入会直接编译失败（TS2306），请改用深路径。
//
// 各 harness 的适用场景见 apps/desktop/AGENTS.md 的 test-utils 小节。
