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
      coverage: {
        provider: 'v8',
        include: ['src/{components,pages,runtime,stores,utils,i18n}/**/*.{ts,tsx}'],
        exclude: [
          'src/**/*.test.{ts,tsx}',
          'src/main.tsx',
          'src/overlay.tsx',
          'src/router.tsx',
          'src/App.tsx',
          'src/mocks/**',
          'src/i18n/config.ts',
        ],
        reporter: ['text', 'json-summary', 'html'],
        reportsDirectory: '../../artifacts/testing/coverage/desktop',
        thresholds: {
          statements: 100,
          lines: 100,
          functions: 100,
          branches: 100,
        },
      },
    },
  }),
);
