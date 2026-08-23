import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
      restoreMocks: true,
      clearMocks: true,
      setupFiles: ['./src/test-setup.ts'],
      coverage: {
        provider: 'v8',
        include: [
          'src/App.tsx',
          'src/{components,pages,runtime,stores,utils,i18n,schema}/**/*.{ts,tsx}',
        ],
        exclude: [
          'src/**/*.test.{ts,tsx}',
          'src/main.tsx',
          // Application composition roots and lazy route registration are
          // exercised by integration tests, not counted as unit-test code.
          // (App.tsx is covered by App.test.tsx since the shallow-integration
          // rewrite; only the pure render entrypoints stay excluded.)
          'src/router.tsx',
          'src/overlay.tsx',
          'src/mocks/**',
          'src/i18n/config.ts',
          // These schema modules contain compile-time contracts only. V8 sees
          // a few emitted enum lines even though there is no runtime behavior.
          'src/schema/config.ts',
          'src/schema/provider-contract.ts',
          'src/schema/provider-runtime.ts',
        ],
        reporter: ['text', 'json', 'json-summary', 'html'],
        reportsDirectory: '../../artifacts/testing/coverage/desktop',
        thresholds: {
          // Keep executable baselines as ratchets rather than leaving CI red.
          // V8 counts JSX fallbacks and optional-chain alternatives as branches;
          // raise the branch floor as those UI paths gain assertion-rich tests.
          statements: 95,
          lines: 95,
          functions: 95,
          branches: 92,
        },
      },
    },
  }),
);
