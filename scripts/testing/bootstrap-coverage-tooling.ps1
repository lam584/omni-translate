$ErrorActionPreference = 'Stop'

$toolchain = 'nightly-2026-06-01'
$llvmCovVersion = '0.8.6'

rustup toolchain install $toolchain --profile minimal
if ($LASTEXITCODE -ne 0) {
  throw "Failed to install Rust toolchain $toolchain."
}

rustup component add llvm-tools-preview --toolchain $toolchain
if ($LASTEXITCODE -ne 0) {
  throw "Failed to install llvm-tools-preview for $toolchain."
}

cargo install cargo-llvm-cov --version $llvmCovVersion --locked
if ($LASTEXITCODE -ne 0) {
  throw "Failed to install cargo-llvm-cov $llvmCovVersion."
}

Write-Output "Coverage tooling is ready: $toolchain / cargo-llvm-cov $llvmCovVersion"
