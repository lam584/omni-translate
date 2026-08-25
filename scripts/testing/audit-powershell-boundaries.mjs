import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDirectory, '../..');
const policyPath = path.join(moduleDirectory, 'powershell-boundaries.json');

const portable = (value) => value.split(path.sep).join('/');

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(candidate));
    else if (/\.ps(?:1|m1)$/i.test(entry.name)) files.push(candidate);
  }
  return files;
}

function functionDefinitions(source) {
  return [...source.matchAll(/^\s*function\s+([A-Za-z][A-Za-z0-9-]*)\b/gmi)]
    .map((match) => match[1]);
}

function unsafeProcessMutation(source) {
  const nameBasedMutation = /Get-Process\s+(?:-[A-Za-z]+\s+)*-?Name\b[\s\S]{0,240}(?:Stop-Process|taskkill\.exe)/i.test(source);
  const taskkillCalls = [...source.matchAll(/taskkill\.exe\b[\s\S]{0,180}/gi)];
  const unscopedTaskkill = taskkillCalls.some((match) => !/['"]?\/PID['"]?/i.test(match[0]));
  return nameBasedMutation || unscopedTaskkill;
}

function hasImplicitRunnerState(source) {
  return /\$(?:global|script):[A-Za-z_][A-Za-z0-9_]*/i.test(source);
}

function hasGlobalModuleImport(source) {
  return /^\s*Import-Module\b[^\r\n]*\s-Global(?:\s|$)/gmi.test(source);
}

function localModuleImports(source) {
  return [...source.matchAll(/Import-Module\s+\(Join-Path\s+\$PSScriptRoot\s+['"]([^'"]+\.psm1)['"]\)/gmi)]
    .map((match) => match[1].replaceAll('\\', '/'));
}

function usedCapabilities(source) {
  const capabilities = [];
  if (/Start-Process[^\r\n]*-Verb\s+RunAs|Test-OmniIsAdministrator|WindowsPrincipal/i.test(source)) {
    capabilities.push('elevation');
  }
  if (/\b(?:Stop-Process|taskkill\.exe|Stop-OmniOwnedProcessTree)\b/i.test(source)) {
    capabilities.push('processTermination');
  }
  if (/CoreAudio|PolicyConfig|Set-DefaultRenderEndpoint/i.test(source)) {
    capabilities.push('coreAudio');
  }
  if (/\bRemove-Item\b|\[System\.IO\.File\]::Delete\s*\(|\.Delete\s*\(/i.test(source)) {
    capabilities.push('fileDeletion');
  }
  return capabilities;
}

function hasWatchPolicy(source) {
  return /function\s+(?:Get-PcmRmsEnvelope|Get-PearsonCorrelation|Compare-WatchMode|Get-CharacterOverlapScore|Read-RecentProviderSummary)/i.test(source)
    || /(?:coverage|lengthRatio|overlap)\s*-(?:ge|gt|le|lt)\s*0?\.[0-9]+/i.test(source);
}

function hasLogDrivenReadiness(source) {
  return /(?:-match|Select-String)[^\r\n]*(?:omni_session_ready|diagnostic_autostart_ipc_ready|startup\.step\s+check-ipc)/i.test(source);
}

function hasStartupVerdictPolicy(source) {
  return /\bverdict\s*=/i.test(source)
    || /function\s+(?:New-StartupThresholds|Get-StartupPhaseThresholdIssues|Classify-DevFailure|Test-FrontendBootstrapErrors)\b/i.test(source);
}

function writesDerivedWatchArtifact(source) {
  return /(?:Join-Path\s+\$[A-Za-z][A-Za-z0-9]*|Set-Content[^\r\n]*)[^\r\n]*["']physical-output-content\.json["']/i.test(source);
}

export function auditPowerShellSources(records, policy, { strict = false } = {}) {
  const issues = [];
  const definitions = new Map();
  const recordPaths = new Set(records.map((record) => record.path));

  for (const record of records) {
    const declaration = policy.scripts[record.path];
    if (!declaration) {
      issues.push(`${record.path}: PowerShell file is not registered in powershell-boundaries.json`);
      continue;
    }
    if (!Array.isArray(declaration.allowedImports)) {
      issues.push(`${record.path}: allowedImports must be declared explicitly`);
    } else {
      const allowedImports = new Set(declaration.allowedImports);
      for (const importedModule of localModuleImports(record.source)) {
        if (!allowedImports.has(importedModule)) {
          issues.push(`${record.path}: undeclared module import ${importedModule}`);
        }
      }
    }
    if (!Array.isArray(declaration.capabilities)) {
      issues.push(`${record.path}: capabilities must be declared explicitly`);
    } else {
      const declaredCapabilities = new Set(declaration.capabilities);
      for (const capability of usedCapabilities(record.source)) {
        if (!declaredCapabilities.has(capability)) {
          issues.push(`${record.path}: undeclared ${capability} capability`);
        }
      }
    }
    const maxLines = declaration?.maxLines ?? policy.defaultModuleMaxLines;
    if (record.lines > maxLines) {
      issues.push(`${record.path}: ${record.lines} lines exceeds registered maximum ${maxLines}`);
    }
    for (const name of functionDefinitions(record.source)) {
      const key = name.toLowerCase();
      if (!definitions.has(key)) definitions.set(key, []);
      definitions.get(key).push(record.path);
    }
    if (unsafeProcessMutation(record.source)) {
      const exemption = policy.unsafeProcessExemptions[record.path];
      if (!exemption || strict) {
        issues.push(`${record.path}: unsafe process termination is not bound to a verified owned-process lease`);
      }
    }
    if (hasImplicitRunnerState(record.source)) {
      const exemption = policy.implicitStateExemptions[record.path];
      if (!exemption || strict) {
        issues.push(`${record.path}: implicit $global:/$script: runner state is forbidden`);
      }
    }
    if (hasGlobalModuleImport(record.source)) {
      issues.push(`${record.path}: module imports must remain local to the importing script or module`);
    }
    if (record.path.includes('watch-mode') && hasWatchPolicy(record.source)) {
      const exemption = policy.watchPolicyExemptions[record.path];
      if (!exemption || strict) {
        issues.push(`${record.path}: Watch Mode verdict/DSP policy must not live in PowerShell`);
      }
    }
    if (record.path.includes('watch-mode') && hasLogDrivenReadiness(record.source)) {
      issues.push(`${record.path}: log text must not control Watch Mode readiness`);
    }
    if (record.path.includes('Omni.Testing.Startup.') && hasStartupVerdictPolicy(record.source)) {
      issues.push(`${record.path}: Startup thresholds, failure classification, and verdict belong to the Node report engine`);
    }
    if (record.path.includes('WatchMode') && writesDerivedWatchArtifact(record.source)) {
      issues.push(`${record.path}: PowerShell may write physical-output-content.raw.json only; the derived content artifact belongs to Node`);
    }
  }

  for (const registeredPath of Object.keys(policy.scripts)) {
    if (!recordPaths.has(registeredPath)) {
      issues.push(`${registeredPath}: registered PowerShell file does not exist`);
    }
  }
  for (const [key, paths] of definitions) {
    const uniquePaths = [...new Set(paths)];
    if (uniquePaths.length <= 1) continue;
    const canonicalName = functionDefinitions(records.find((record) => record.path === uniquePaths[0]).source)
      .find((name) => name.toLowerCase() === key) ?? key;
    const exemption = policy.duplicateFunctionExemptions[canonicalName];
    if (!exemption || strict) {
      issues.push(`${canonicalName}: duplicate function definition in ${uniquePaths.join(', ')}`);
    }
  }
  return issues;
}

export function collectPowerShellSources(root = repoRoot) {
  return walk(path.join(root, 'scripts/testing')).map((filePath) => {
    const source = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    return {
      path: portable(path.relative(root, filePath)),
      source,
      lines: source.split(/\r?\n/).length - (source.endsWith('\n') ? 1 : 0),
    };
  });
}

export function runPowerShellBoundaryAudit({ root = repoRoot, strict = false } = {}) {
  const policy = JSON.parse(fs.readFileSync(path.join(root, 'scripts/testing/powershell-boundaries.json'), 'utf8'));
  const issues = auditPowerShellSources(collectPowerShellSources(root), policy, { strict });
  if (issues.length > 0) {
    throw new Error(`PowerShell boundary audit failed:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
  }
  return { files: collectPowerShellSources(root).length, strict };
}

export function auditTestingDspBoundaries(root = repoRoot) {
  const targets = [
    'scripts/testing/watch-mode-translated-pcm-loopback.mjs',
    'scripts/testing/verify-watch-mode-evidence.mjs',
    'scripts/testing/real-device-audio-release-evidence.mjs',
  ];
  const forbidden = /\b(?:Float32Array|Int16Array|readInt16LE|componentAmplitude|pearsonAt|correlationAt|resampleMonoLinear)\b/;
  const issues = [];
  for (const relativePath of targets) {
    const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
    if (forbidden.test(source)) {
      issues.push(`${relativePath}: PCM decoding, resampling, correlation, and spectral loops belong to omni-benchmark-core`);
    }
  }
  if (issues.length > 0) throw new Error(`Testing DSP boundary audit failed:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
  return { files: targets.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = runPowerShellBoundaryAudit({ strict: process.argv.includes('--strict') });
  auditTestingDspBoundaries();
  console.log(`PowerShell boundary audit passed (${result.files} files, strict=${result.strict}).`);
}
