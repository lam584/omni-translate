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
          'router', 'useDesktopApiV2', 'diagnosticsReadyPatchForMode',
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
    files: ['**/*.{test,spec}.{ts,tsx}'],
    rules: {
      // Tests may spy on and assert against console output.
      'no-console': 'off',
    },
  },
);
