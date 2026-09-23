import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../../.github/workflows/nightly-startup-stress.yml', import.meta.url),
  'utf8',
).replace(/\r\n/g, '\n');
// Inspect executable YAML lines, not comments mentioning a command or runner.
const active = workflow.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
const job = active.match(/^  startup-stress:\n([\s\S]*?)(?=^  \S|$(?![\s\S]))/m)?.[1];
assert.ok(job, 'startup-stress job must exist');
const steps = [...job.matchAll(/^      - name: .+\n(?:(?!^      - |^  \S)[\s\S])*/gm)]
  .map(([block]) => block);

function commandStep(command) {
  const matches = steps.filter((step) => step.split('\n').includes(`        run: ${command}`));
  assert.equal(matches.length, 1, `expected one unconditional, direct ${command} step`);
  return matches[0];
}

test('nightly provisions and tests AEC3 after npm ci and before the release build', () => {
  const install = commandStep('npm ci');
  const provision = commandStep('npm run test:aec3-msvc');
  const build = commandStep('npm run build:desktop-shell');
  assert.ok(steps.indexOf(install) < steps.indexOf(provision));
  assert.ok(steps.indexOf(provision) < steps.indexOf(build));
});

test('nightly pins the runner for the release Visual Studio 2022 generator', () => {
  assert.match(job, /^    runs-on: windows-2022\s*$/m);
});

test('nightly cannot skip or soften the AEC3 gate or release build', () => {
  const jobSettings = job.split(/^    steps:/m)[0];
  for (const block of [jobSettings, commandStep('npm run test:aec3-msvc'), commandStep('npm run build:desktop-shell')]) {
    assert.doesNotMatch(block, /^\s*(?:if|continue-on-error):/m,
      'required gates must run normally and propagate failures');
  }
});


test('nightly executes workflow regression tests before native compilation', () => {
  const regression = commandStep('node --test scripts/testing/nightly-startup-workflow.test.mjs');
  assert.ok(steps.indexOf(commandStep('npm ci')) < steps.indexOf(regression));
  assert.ok(steps.indexOf(regression) < steps.indexOf(commandStep('npm run test:aec3-msvc')));
  assert.doesNotMatch(regression, /^\s*(?:if|continue-on-error):/m,
    'workflow regression tests must run normally and propagate failures');
});
