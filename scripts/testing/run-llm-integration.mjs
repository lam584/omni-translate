import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { isMain, parseCliArgs, readJson, repoRoot, runCommand } from '../lib/testing-common.mjs';

const defaultConfigPath = 'scripts/testing/llm-integration.config.json';
export const defaultAudioTimeoutSeconds = 300;
export const maximumAudioTimeoutSeconds = 600;

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

export const validateAudioTimeoutSeconds = (rawValue) => {
  const timeoutSeconds = Number(rawValue);
  if (
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds <= 0 ||
    timeoutSeconds > maximumAudioTimeoutSeconds
  ) {
    throw new Error(
      `--timeout-seconds must be greater than 0 and no more than ${maximumAudioTimeoutSeconds}`,
    );
  }
  return timeoutSeconds;
};

export const parseLlmIntegrationArgs = (argv) => {
  const args = parseCliArgs(argv, {
    booleans: ['audio-only'],
    defaults: {
      configPath: defaultConfigPath,
      timeoutSeconds: String(defaultAudioTimeoutSeconds),
    },
  });
  return { ...args, timeoutSeconds: validateAudioTimeoutSeconds(args.timeoutSeconds) };
};

export const buildIntegrationEnvironment = ({ config, requestedConfig, audioOnly = false }) => {
  const environment = {
    ...process.env,
    ...buildConfigEnvironment(config),
    OMNI_LLM_TEST_CONFIG: requestedConfig,
  };
  if (audioOnly) environment.OMNI_LLM_TEST_AUDIO_ONLY = '1';
  else delete environment.OMNI_LLM_TEST_AUDIO_ONLY;
  return environment;
};

const terminateProcessTree = (child) => {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    if (result.status !== 0) child.kill('SIGKILL');
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
};

export const runCommandWithHardTimeout = (command, { cwd, env, timeoutSeconds }) =>
  new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd,
      env,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, timeoutSeconds * 1_000);

    child.once('error', (error) => {
      clearTimeout(timer);
      console.error(`Failed to start audio model integration: ${error.message}`);
      resolve(1);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        console.error(
          `Audio model integration exceeded the ${timeoutSeconds}s hard timeout; ` +
            'the test process tree was terminated.',
        );
        resolve(124);
        return;
      }
      resolve(code ?? 1);
    });
  });

export const runLlmIntegration = (
  {
    configPath = defaultConfigPath,
    audioOnly = false,
    timeoutSeconds = defaultAudioTimeoutSeconds,
  } = {},
) => {
  const validatedTimeoutSeconds = validateAudioTimeoutSeconds(timeoutSeconds);
  const requestedConfig = path.resolve(repoRoot, configPath);
  if (!fs.existsSync(requestedConfig)) {
    throw new Error(
      `LLM integration config not found at ${requestedConfig}. ` +
        'Copy scripts/testing/llm-integration.config.example.json to ' +
        'scripts/testing/llm-integration.config.json and fill in local credentials.',
    );
  }
  const config = readJson(requestedConfig);
  const env = buildIntegrationEnvironment({ config, requestedConfig, audioOnly });
  const command =
    'cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml ' +
    'provider::gateway::tests::llm_integration_provider_smoke_calls_configured_models ' +
    '-- --nocapture --include-ignored';
  if (audioOnly) {
    return runCommandWithHardTimeout(command, {
      cwd: repoRoot,
      env,
      timeoutSeconds: validatedTimeoutSeconds,
    });
  }
  return Promise.resolve(runCommand(command, { cwd: repoRoot, env }));
};

if (isMain(import.meta.url)) {
  try {
    const args = parseLlmIntegrationArgs(process.argv.slice(2));
    process.exit(await runLlmIntegration(args));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
