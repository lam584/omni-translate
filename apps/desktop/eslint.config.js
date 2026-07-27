import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

// Module-scope i18n.t() calls evaluate once at import time, freezing the text
// to the startup language: later i18n.changeLanguage() calls can never update
// them. The selectors below flag i18n.t() reached from a top-level
// const/let/var (or class/default-export) initializer — including nested
// object/array literals — while `:not(:function *)` keeps calls inside
// function bodies, arrow functions and methods allowed (those re-evaluate per
// call and follow the active language).
const moduleScopeI18nMessage =
  'i18n.t() at module scope is frozen at import time to the startup language. Defer the call into a function/getter (or a useTranslation hook) so language switches take effect.';
const moduleScopeI18nRestrictions = [
  {
    selector:
      ":matches(Program, Program > ExportNamedDeclaration) > :matches(VariableDeclaration, ClassDeclaration) CallExpression[callee.object.name='i18n'][callee.property.name='t']:not(:function *)",
    message: moduleScopeI18nMessage,
  },
  {
    selector:
      "Program > ExportDefaultDeclaration CallExpression[callee.object.name='i18n'][callee.property.name='t']:not(:function *)",
    message: moduleScopeI18nMessage,
  },
];

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
      'no-restricted-syntax': ['error', ...moduleScopeI18nRestrictions],
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
    // Persisted-state writers: everything these modules produce can end up in
    // durable storage (config drafts, schema payloads), so the content must be
    // locale-independent. Banning the i18n import entirely (runtime and type
    // imports alike) keeps localized strings out of persisted bytes; localize
    // at render time instead.
    files: ['src/schema/**/*.{ts,tsx}', 'src/stores/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...moduleScopeI18nRestrictions,
        {
          selector: "ImportDeclaration[source.value=/i18n/]",
          message:
            'Persisted-state writers (src/schema, src/stores) must stay locale-independent; do not import i18n/i18next here. Localize when rendering, not when persisting.',
        },
        {
          selector: "CallExpression[callee.object.name='i18n'][callee.property.name='t']",
          message:
            'Persisted-state writers (src/schema, src/stores) must not produce localized strings; persisted values must be locale-independent.',
        },
      ],
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
