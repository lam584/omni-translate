@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath powershell.exe -ArgumentList '-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File','%~dp0prime-win11-ssh-git.ps1' -Verb RunAs -Wait -PassThru; exit $p.ExitCode"
if errorlevel 1 (
  echo SSH/Git bootstrap failed. Review C:\ProgramData\Win11VmBootstrap\prime-ssh-git.log
) else (
  echo SSH/Git bootstrap completed. Keep this VM window open.
)
pause
