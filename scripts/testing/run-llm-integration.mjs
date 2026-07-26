import fs from 'node:fs';
import path from 'node:path';
import { isMain, parseCliArgs, readJson, repoRoot, runCommand } from '../lib/testing-common.mjs';

const defaultConfigPath = 'scripts/testing/llm-integration.config.json';

export const buildConfigEnvironment = (config) => {
  const environment = {};
  for (const [name, rawValue] of Object.entries(config.environment ?? {})) {
    const value = rawValue == null ? '' : String(rawValue);
    if (value && !/^<.*>$/.test(value)) {
      environment[name] = value;
    }
  }
  return environment;
};

export const runLlmIntegration = ({ configPath = defaultConfigPath } = {}) => {
  const requestedConfig = path.resolve(repoRoot, configPath);
  if (!fs.existsSync(requestedConfig)) {
    throw new Error(
      `LLM integration config not found at ${requestedConfig}. ` +
        'Copy scripts/testing/llm-integration.config.example.json to ' +
        'scripts/testing/llm-integration.config.json and fill in local credentials.',
    );
  }
  const config = readJson(requestedConfig);
  const env = {
    ...process.env,
    ...buildConfigEnvironment(config),
    OMNI_LLM_TEST_CONFIG: requestedConfig,
  };
  return runCommand(
    'cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml ' +
      'provider::gateway::tests::llm_integration_provider_smoke_calls_configured_models ' +
      '-- --nocapture --include-ignored',
    { cwd: repoRoot, env },
  );
};

if (isMain(import.meta.url)) {
  try {
    const args = parseCliArgs(process.argv.slice(2), { defaults: { configPath: defaultConfigPath } });
    process.exit(runLlmIntegration(args));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
