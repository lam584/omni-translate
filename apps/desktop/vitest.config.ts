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
          'src/App.tsx',
          'src/router.tsx',
          'src/overlay.tsx',
        ],
        exclude: [
          'src/**/*.test.{ts,tsx}',
          'src/main.tsx',
          'src/mocks/**',
          'src/i18n/config.ts',
        ],
        reporter: ['text', 'json-summary', 'html'],
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
