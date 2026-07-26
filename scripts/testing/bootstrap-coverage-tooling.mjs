import { isMain, runCommand } from '../lib/testing-common.mjs';

export const toolchain = 'nightly-2026-06-01';
export const llvmCovVersion = '0.8.6';

export const bootstrapCoverageTooling = () => {
  const steps = [
    {
      command: `rustup toolchain install ${toolchain} --profile minimal`,
      failure: `Failed to install Rust toolchain ${toolchain}.`,
    },
    {
      command: `rustup component add llvm-tools-preview --toolchain ${toolchain}`,
      failure: `Failed to install llvm-tools-preview for ${toolchain}.`,
    },
    {
      command: `cargo install cargo-llvm-cov --version ${llvmCovVersion} --locked`,
      failure: `Failed to install cargo-llvm-cov ${llvmCovVersion}.`,
    },
  ];
  for (const step of steps) {
    if (runCommand(step.command) !== 0) {
      throw new Error(step.failure);
    }
  }
  console.log(`Coverage tooling is ready: ${toolchain} / cargo-llvm-cov ${llvmCovVersion}`);
};

if (isMain(import.meta.url)) {
  try {
    bootstrapCoverageTooling();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
