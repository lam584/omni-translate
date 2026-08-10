import {
  isMain,
} from '../lib/testing-common.mjs';

if (isMain(import.meta.url)) {
  console.error(
    'generic caller-supplied --source assembly is forbidden; use the scenario-specific production evidence runner',
  );
  process.exit(1);
}
