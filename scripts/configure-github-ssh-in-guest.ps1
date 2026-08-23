[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$git = Get-Command git.exe -ErrorAction Stop

# Kept under the historical filename so existing operator shortcuts do not fail.
# The previous private-key import workflow was intentionally replaced with Git
# Credential Manager over HTTPS. Authentication remains interactive and secrets
# stay in the platform credential store instead of the guest filesystem.
& $git.Source config --global credential.helper manager
if ($LASTEXITCODE -ne 0) {
    throw 'Unable to configure Git Credential Manager.'
}

& $git.Source config --global --unset-all core.sshCommand 2>$null
& $git.Source config --global --unset-all 'url.https://github.com/.insteadOf' 2>$null
& $git.Source config --global --add 'url.https://github.com/.insteadOf' 'git@github.com:'
& $git.Source config --global --add 'url.https://github.com/.insteadOf' 'ssh://git@github.com/'
if ($LASTEXITCODE -ne 0) {
    throw 'Unable to configure GitHub HTTPS URL rewriting.'
}

Write-Output 'GitHub remotes now use HTTPS with Git Credential Manager. Authenticate interactively on the next Git operation.'
