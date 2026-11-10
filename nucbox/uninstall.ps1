# Undoes install.ps1: stops and removes the LM relay, LibreHardwareMonitor,
# tasks-service, Claude sessions and Open in VS Code tasks (tasks.env with its tokens goes too), their firewall rules, and C:\ProgramData\car-thing-panel. In an
# administrator PowerShell:
#
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:ProgramData 'car-thing-panel'
$lhmExe = Join-Path $root 'LibreHardwareMonitor\LibreHardwareMonitor.exe'

foreach ($name in 'Car Thing panel - LM relay', 'Car Thing panel - LibreHardwareMonitor', 'Car Thing panel - Tasks', 'Car Thing panel - Claude sessions', 'Car Thing panel - Open in VS Code') {
  if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $name
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
  }
  Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
}
Get-Process LibreHardwareMonitor -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -eq $lhmExe } | Stop-Process -Force
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like '*car-thing-panel\lm-relay.js*' -or $_.CommandLine -like '*car-thing-panel\tasks-service.js*' -or $_.CommandLine -like '*car-thing-panel\sessions\src\index.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 2
Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
'Removed. If you installed the Claude Code hooks here, remove them with mac-service\scripts\uninstall-hooks.js (before this folder went, or from the repo copy).'
