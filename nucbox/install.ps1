# Sets up the NucBox for the Car Thing panel's NucBox view. From this folder,
# in an administrator PowerShell:
#
#   powershell -ExecutionPolicy Bypass -File install.ps1 -HomeAssistant 192.168.1.27
#
# Add -TasksList "Work" to name the TickTick list the Tasks page shows (the
# default is Work). Add -ClaudeSessions to also run the session service here
# (port 8790) for the Claude Code sessions in the NucBox's VS Code; it needs
# the repo's mac-service folder next to this one.
#
# - lm-relay (port 1235): the list of LM Studio's loaded models, read-only, for
#   the panel. LM Studio's own server has no login, so it stays on localhost.
#   Answers the local subnet.
# - LibreHardwareMonitor (port 8085): its web server, for Home Assistant's
#   Libre Hardware Monitor integration. That server can also set fan controls,
#   and the integration can't log in, so it answers Home Assistant only.
#
# - tasks-service (port 8791): the Tasks page's TickTick work list, the focus
#   timer, and dictation with whisper.cpp (downloaded here, with its base.en
#   model; ffmpeg from winget for recordings that aren't WAV). Answers the
#   local subnet, and only with the panel's token. The TickTick token and the
#   panel token go in tasks.env, sent from the Mac by push-tasks-secrets.sh;
#   until then the service doesn't start.
#
# - With -ClaudeSessions, a task "Car Thing panel - Open in VS Code" too
#   (open-in-vscode.ps1). The session service has no desktop, so it asks this
#   task, which runs as you in your own session, to open a session in VS Code.
#   It never starts by itself (no trigger, no port, no firewall rule): the
#   service runs it per request, and it only works while you're logged on.
#
# The services start at boot or logon (the Open in VS Code task only when the
# session service runs it); the firewall rules apply on Private networks only.
# Safe to run again. uninstall.ps1 undoes it.
param(
  [Parameter(Mandatory = $true)][string]$HomeAssistant,
  [string]$User = "$env:COMPUTERNAME\$env:USERNAME",
  [string]$TasksList = 'Work',
  # whisper.cpp attaches its Windows builds to numbered b#### releases, not to
  # the vX.Y.Z ones; b5454 is v1.9.5's.
  [string]$WhisperRelease = 'b5454',
  [switch]$ClaudeSessions
)
$ErrorActionPreference = 'Stop'

$root = Join-Path $env:ProgramData 'car-thing-panel'
$lhmDir = Join-Path $root 'LibreHardwareMonitor'
$lhmExe = Join-Path $lhmDir 'LibreHardwareMonitor.exe'
$relayTask = 'Car Thing panel - LM relay'
$lhmTask = 'Car Thing panel - LibreHardwareMonitor'
$tasksTask = 'Car Thing panel - Tasks'
$sessionsTask = 'Car Thing panel - Claude sessions'
$sessionsDir = Join-Path $root 'sessions'
$whisperDir = Join-Path $root 'whisper'
New-Item -ItemType Directory -Force $root, $lhmDir | Out-Null

function Stop-Ours {
  foreach ($t in $relayTask, $lhmTask, $tasksTask, $sessionsTask) {
    if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $t }
  }
  Get-Process LibreHardwareMonitor -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $lhmExe } | Stop-Process -Force
  # A relay started by hand; other node processes are left alone.
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -like '*car-thing-panel\lm-relay.js*' -or $_.CommandLine -like '*car-thing-panel\tasks-service.js*' -or $_.CommandLine -like '*car-thing-panel\sessions\src\index.js*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-Sleep -Seconds 2
}

function Allow-Inbound($name, $port, $from) {
  Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP `
    -LocalPort $port -RemoteAddress $from -Profile Private | Out-Null
}

function Register-AtLogon($name, $exe, $arguments, $trigger, $principal) {
  $a = @{ Execute = $exe; WorkingDirectory = (Split-Path $exe) }
  if ($arguments) { $a.Argument = $arguments }   # an empty -Argument is refused
  $action = New-ScheduledTaskAction @a
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal `
    -Settings $settings -Force | Out-Null
}

# LibreHardwareMonitor keeps its settings next to the exe and writes them on exit.
function Set-LhmSettings($values) {
  $file = Join-Path $lhmDir 'LibreHardwareMonitor.config'
  if (Test-Path $file) { [xml]$doc = Get-Content $file -Raw }
  else { [xml]$doc = '<?xml version="1.0" encoding="utf-8"?><configuration><appSettings /></configuration>' }
  $app = $doc.SelectSingleNode('/configuration/appSettings')
  foreach ($key in $values.Keys) {
    $node = $app.SelectSingleNode("add[@key='$key']")
    if (-not $node) {
      $node = $doc.CreateElement('add')
      $node.SetAttribute('key', $key)
      [void]$app.AppendChild($node)
    }
    $node.SetAttribute('value', $values[$key])
  }
  $doc.Save($file)
}

Stop-Ours

# The relay runs without a window, logged on or not.
Copy-Item (Join-Path $PSScriptRoot 'lm-relay.js') $root -Force
$node = (Get-Command node).Source
Register-AtLogon $relayTask $node ('"' + (Join-Path $root 'lm-relay.js') + '"') `
  (New-ScheduledTaskTrigger -AtStartup) `
  (New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Limited)
Allow-Inbound $relayTask 1235 'LocalSubnet'

# LibreHardwareMonitor from the zip winget knows (hash-checked), run elevated
# in the owner's session so its tray icon shows; CPU temperatures need both.
if (-not (Test-Path $lhmExe)) {
  $dl = Join-Path $env:TEMP 'car-thing-panel-lhm'
  Remove-Item $dl -Recurse -Force -ErrorAction SilentlyContinue
  winget download --id LibreHardwareMonitor.LibreHardwareMonitor -e --source winget -d $dl `
    --accept-source-agreements --accept-package-agreements | Out-Null
  $zip = Get-ChildItem $dl -Filter *.zip -Recurse | Select-Object -First 1
  if (-not $zip) { throw 'winget did not download LibreHardwareMonitor' }
  Expand-Archive $zip.FullName $lhmDir -Force
  if (-not (Test-Path $lhmExe)) { throw "LibreHardwareMonitor.exe isn't at the top of the zip" }
}
Set-LhmSettings @{
  runWebServerMenuItem = 'true'; listenerPort = '8085'; authenticationEnabled = 'false'
  startMinMenuItem = 'true'; minTrayMenuItem = 'true'; minCloseMenuItem = 'true'
}
Register-AtLogon $lhmTask $lhmExe '' `
  (New-ScheduledTaskTrigger -AtLogOn -User $User) `
  (New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Highest)
Allow-Inbound $lhmTask 8085 $HomeAssistant

# The tasks service, like the relay: no window, logged on or not.
Copy-Item (Join-Path $PSScriptRoot 'tasks-service.js') $root -Force
New-Item -ItemType Directory -Force $whisperDir | Out-Null
# whisper.cpp's Windows build (CPU, from release $WhisperRelease): whisper-cli.exe
# and the DLLs beside it, flattened into whisper\.
if (-not (Test-Path (Join-Path $whisperDir 'whisper-cli.exe'))) {
  $rel = Invoke-RestMethod "https://api.github.com/repos/ggml-org/whisper.cpp/releases/tags/$WhisperRelease" -Headers @{ 'User-Agent' = 'car-thing-panel' }
  $asset = $rel.assets | Where-Object { $_.name -eq 'whisper-bin-x64.zip' } | Select-Object -First 1
  if (-not $asset) { throw "whisper.cpp release $WhisperRelease has no whisper-bin-x64.zip" }
  $zip = Join-Path $env:TEMP 'car-thing-panel-whisper.zip'
  $unz = Join-Path $env:TEMP 'car-thing-panel-whisper'
  Invoke-WebRequest $asset.browser_download_url -OutFile $zip -UseBasicParsing
  Remove-Item $unz -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive $zip $unz -Force
  $cli = Get-ChildItem $unz -Recurse -Filter whisper-cli.exe | Select-Object -First 1
  if (-not $cli) { throw 'whisper-cli.exe is not in the whisper.cpp zip' }
  Copy-Item (Join-Path $cli.DirectoryName '*') $whisperDir -Recurse -Force
  Remove-Item $zip, $unz -Recurse -Force -ErrorAction SilentlyContinue
}
$model = Join-Path $whisperDir 'ggml-base.en.bin'
if (-not (Test-Path $model)) {
  Invoke-WebRequest 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin' -OutFile $model -UseBasicParsing
}
# ffmpeg is only for recordings that aren't already 16 kHz WAV (the
# simulator's); the Car Thing's go straight to whisper. Not fatal.
$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffmpeg) {
  winget install --id Gyan.FFmpeg -e --source winget --accept-source-agreements --accept-package-agreements | Out-Null
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  $ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
  if (-not $ffmpeg) {
    $ffmpeg = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages') -Recurse -Filter ffmpeg.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  }
}
$ffmpegPath = if ($ffmpeg -and $ffmpeg.Source) { $ffmpeg.Source } elseif ($ffmpeg) { $ffmpeg.FullName } else { 'ffmpeg' }
# Settings that aren't secret. The two tokens live in tasks.env.
Set-Content -Path (Join-Path $root 'tasks.conf') -Value ("TASKS_LIST=$TasksList`nFFMPEG=$ffmpegPath`n") -NoNewline
Register-AtLogon $tasksTask $node ('"' + (Join-Path $root 'tasks-service.js') + '"') `
  (New-ScheduledTaskTrigger -AtStartup) `
  (New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Limited)
Allow-Inbound $tasksTask 8791 'LocalSubnet'

# The session service, for Claude Code in the NucBox's VS Code: the same
# service as the Mac's (mac-service), run as you so it reads your
# %USERPROFILE%\.claude, with no window. The panel reaches /ws with its token
# (%USERPROFILE%\.config\claude-panel\token); hooks answer this machine only.
$sessionsNote = ''
if ($ClaudeSessions) {
  $src = Join-Path (Split-Path $PSScriptRoot) 'mac-service'
  if (-not (Test-Path (Join-Path $src 'src\index.js'))) { throw "mac-service isn't next to this folder: copy the whole repo over" }
  New-Item -ItemType Directory -Force $sessionsDir | Out-Null
  foreach ($item in 'src', 'scripts', 'package.json', 'package-lock.json') {
    Copy-Item (Join-Path $src $item) $sessionsDir -Recurse -Force
  }
  Push-Location $sessionsDir
  try { & npm ci --omit=dev --no-audit --no-fund | Out-Null; if ($LASTEXITCODE) { throw 'npm ci failed' } }
  finally { Pop-Location }
  # It writes its logs and pid file beside itself, as you.
  $who = $User
  icacls $sessionsDir /grant "${who}:(OI)(CI)M" | Out-Null
  Register-AtLogon $sessionsTask $node ('"' + (Join-Path $sessionsDir 'src\index.js') + '"') `
    (New-ScheduledTaskTrigger -AtStartup) `
    (New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Limited)
  Allow-Inbound $sessionsTask 8790 'LocalSubnet'
  Start-ScheduledTask -TaskName $sessionsTask
  # The service can't open a window on your screen (no desktop), so Open in VS
  # Code goes to this task, which runs as you, in your session, only when the
  # service asks (`schtasks /run`; no permission grant is needed from the
  # service's account, checked 2026-11-07). conhost --headless keeps its
  # PowerShell from flashing a console. Not started here; no firewall rule.
  $openTask = 'Car Thing panel - Open in VS Code'
  Copy-Item (Join-Path $PSScriptRoot 'open-in-vscode.ps1') $root -Force
  $openAction = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument ('--headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
    (Join-Path $root 'open-in-vscode.ps1') + '" -DelayMs 1500')
  $openPrincipal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
  $openSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances Queue `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $openTask -Action $openAction -Principal $openPrincipal -Settings $openSettings -Force | Out-Null
  $sessionsNote = (' Claude sessions on :8790. Now, in a normal PowerShell, install the hooks: node "' +
    (Join-Path $sessionsDir 'scripts\install-hooks.js') + '", then run nucbox/push-sessions-token.sh on the Mac.')
}

Start-ScheduledTask -TaskName $relayTask
Start-ScheduledTask -TaskName $lhmTask
$tasksNote = 'tasks service on :8791 (local subnet)'
if (Test-Path (Join-Path $root 'tasks.env')) { Start-ScheduledTask -TaskName $tasksTask }
else { $tasksNote += ', waiting for its tokens: run nucbox/push-tasks-secrets.sh on the Mac' }
"Installed. LM relay on :1235 (local subnet), LibreHardwareMonitor on :8085 (only $HomeAssistant), $tasksNote.$sessionsNote"
