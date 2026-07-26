import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist', 'src-tauri/target'],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-hooks/set-state-in-effect': 'error',
      // All production logging must flow through createLogger (src/runtime/logger.ts),
      // which mirrors to the console itself and forwards to the native diagnostics log.
      'no-console': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Environment probing happens once, in the composition root. Everything
      // else consumes the installed desktop-api (activeDesktopApi / context
      // capabilities); see src/runtime/desktop-api.ts. The overrides below
      // exempt the composition-root modules themselves.
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/tauri-runtime'],
          importNamePattern: '^(isTauriRuntime|waitForTauriRuntime)$',
          message: 'Probe the environment only in the composition roots; consume capabilities from desktop-api/desktop-api-context instead.',
        }],
      }],
      'react-refresh/only-export-components': ['error', {
        allowConstantExport: true,
        allowExportNames: [
          'isWatchModeDiagnosticAutostartAllowed', 'buildWatchModeDiagnosticAutostartConfig',
          'appLayoutTestHelpers', 'scrollToConsoleSection', 'useConsoleDock',
          'welcomeLanguagePickerHelpers', 'mountOverlayApp', 'audioRoutingPageHelpers',
          'diagnosticsPageHelpers', 'runRecommendedBridgeAction', 'glossaryPageDataHelpers',
          'glossaryPageHelpers', 'realTimeSessionPageHelpers', 'subtitleOverlayPageHelpers',
          'resolveChineseFallback', 'tWithDefault', 'isBinaryAudioOutputEvent',
          'isTextOutputEvent', 'shouldUseManualBenchmarkMode', 'textLength', 'shouldUseCandidate',
          'buildOutputSegments', 'fmtMs', 'exportFile', 'exportJson',
          'DiagnosticsReportExporter', 'formatLiveEventsTxt', 'formatBenchmarkTxt',
          'router', 'useDesktopApiV2', 'useDesktopCapabilities', 'diagnosticsReadyPatchForMode',
        ],
      }],
    },
  },
  {
    files: ['src/router.tsx'],
    rules: {
      // Router construction is an application entrypoint, not a Fast Refresh component boundary.
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    // Composition roots: the one-time environment decision (desktop-api) and
    // the bootstrap that owns the preview -> Tauri late-heal (bootstrap/
    // startup), plus the probe module's own tests.
    files: ['src/runtime/desktop-api.ts', 'src/runtime/bootstrap/startup.ts', 'src/runtime/tauri-runtime.test.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  {
    files: ['**/*.{test,spec}.{ts,tsx}'],
    rules: {
      // Tests may spy on and assert against console output.
      'no-console': 'off',
    },
  },
);
