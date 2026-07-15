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
          'src/{components,pages,runtime,stores,utils,i18n,schema}/**/*.{ts,tsx}',
        ],
        exclude: [
          'src/**/*.test.{ts,tsx}',
          'src/main.tsx',
          // Application composition roots and lazy route registration are
          // exercised by integration tests, not counted as unit-test code.
          'src/App.tsx',
          'src/router.tsx',
          'src/overlay.tsx',
          'src/mocks/**',
          'src/i18n/config.ts',
          // Transitional startup orchestration is integration-covered; the
          // independently testable V2 service boundary remains in coverage.
          'src/runtime/desktop-runtime.ts',
          // These schema modules contain compile-time contracts only. V8 sees
          // a few emitted enum lines even though there is no runtime behavior.
          'src/schema/config.ts',
          'src/schema/provider-contract.ts',
          'src/schema/provider-runtime.ts',
        ],
        reporter: ['text', 'json', 'json-summary', 'html'],
        reportsDirectory: '../../artifacts/testing/coverage/desktop',
        thresholds: {
          statements: 97,
          lines: 97,
          functions: 98,
          branches: 88,
        },
      },
    },
  }),
);
