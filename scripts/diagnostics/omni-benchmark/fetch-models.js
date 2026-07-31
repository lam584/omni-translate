const https = require('https');
const fs = require('fs');
const path = require('path');

// This script lives at scripts/diagnostics/omni-benchmark/, so the repo root is three levels up.
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const dir = __dirname;
const configPath = path.join(repoRoot, 'scripts', 'testing', 'llm-integration.config.json');

// Mirrors run-llm-integration.mjs: the API key is sourced from the shared
// llm-integration config instead of being hardcoded here. The env-var name comes
// from audio.apiKeyEnv; the value is read from config.environment, falling back
// to the real process environment. Placeholder values like "<your-api-key-here>"
// are treated as absent.
const readConfig = () => {
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Missing config: ${configPath}\n` +
        'Copy scripts/testing/llm-integration.config.example.json to llm-integration.config.json and fill in your key.'
    );
  }
  // Tolerate a UTF-8 BOM so configs touched by PowerShell tooling still parse.
  return JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
};

const resolveApiKey = (config) => {
  const envName = (config.audio && config.audio.apiKeyEnv) || 'OMNI_TEST_DASHSCOPE_API_KEY';
  const fromConfig = config.environment ? config.environment[envName] : undefined;
  const raw = fromConfig || process.env[envName] || '';
  const value = String(raw).trim();
  if (!value || /^<.*>$/.test(value)) {
    throw new Error(
      `No API key available. Set environment.${envName} in ${configPath} ` +
        `or export the ${envName} environment variable.`
    );
  }
  return value;
};

const apiKey = resolveApiKey(readConfig());

const options = {
  hostname: 'dashscope.aliyuncs.com',
  path: '/compatible-mode/v1/models',
  method: 'GET',
  headers: { 'Authorization': `Bearer ${apiKey}` }
};

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => {
    try {
      const json = JSON.parse(data);
      const models = json.data || [];
      console.log(`Total models: ${models.length}`);
      fs.writeFileSync(path.join(dir, 'all-models-raw.json'), JSON.stringify(models, null, 2));

      // Print all model IDs for analysis
      const ids = models.map(m => m.id || m.model_id || '').sort();
      ids.forEach(id => console.log(id));
    } catch (e) {
      console.error('Parse error:', e.message);
      console.error(data.substring(0, 1000));
    }
  });
});
req.on('error', (e) => console.error('Error:', e.message));
req.end();
