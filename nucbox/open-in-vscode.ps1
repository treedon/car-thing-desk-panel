# Opens a Claude Code session in VS Code, on the owner's desktop. Run by the
# scheduled task "Car Thing panel - Open in VS Code" (install.ps1 -ClaudeSessions),
# which the session service starts with `schtasks /run`.
#
# The service runs without a desktop (session 0), so a window it opened would
# appear on no screen. This task runs as you, in your own session, and the two
# talk through a folder (mac-service/src/desktop-open.js is the other half):
#
#   request.json  the service's ask: { nonce, sessionId, cwd, continue, createdTs }
#   result.json   this script's answer: { nonce, ok } or { nonce, ok:false, reason }
#
# Both are UTF-8 without a BOM. One run handles one request and writes one
# result. The request is deleted as soon as it is read, and one older than 60000
# ms is refused, so a request left behind by a crash or a reboot never opens
# anything later. Whatever goes wrong, a result is still written (with the
# request's nonce when it got that far) and the script exits 0: the service reads
# the answer, not the exit code.
#
# Reasons: bad-request, stale, no-folder, code-failed.
#
# -DryRun checks the request and writes what it would open, opening nothing.
# Windows PowerShell 5.1 (powershell.exe): no ??, no ternary, no &&.
param(
  [string]$Dir = (Join-Path $env:USERPROFILE '.config\claude-panel\open-in-vscode'),
  # Between starting Code.exe and following the vscode:// link. Too short and the
  # link can land before the window it is meant for; 1500 ms worked with VS Code
  # already running and started cold (measured on the NucBox 2026-11-07).
  [int]$DelayMs = 1500,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

$requestFile = Join-Path $Dir 'request.json'
$resultFile = Join-Path $Dir 'result.json'
$noBom = New-Object System.Text.UTF8Encoding $false
$uuid = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z'
# The nonce of the request being handled, once it has checked out. A refusal
# carries it; before that the result has none, and the service ignores it.
$script:nonce = ''

function New-Refusal($reason) {
  [ordered]@{ nonce = $script:nonce; ok = $false; reason = $reason }
}

# Written to a .tmp file and moved into place, so the service never reads half
# of one. (Windows PowerShell writes & and ' in JSON as \u0026 and \u0027; both
# parse back to the same text.)
function Write-Result($result) {
  $tmp = $resultFile + '.tmp'
  [IO.File]::WriteAllText($tmp, (ConvertTo-Json -InputObject $result -Compress), $noBom)
  Move-Item -LiteralPath $tmp -Destination $resultFile -Force
}

# The request as a result: a refusal, or what was done. Returns it; the caller writes it.
function Invoke-OpenRequest {
  try {
    $raw = Get-Content -LiteralPath $requestFile -Raw -Encoding UTF8
  }
  finally {
    Remove-Item -LiteralPath $requestFile -Force -ErrorAction SilentlyContinue
  }
  $req = $raw | ConvertFrom-Json
  if ($null -eq $req) { return (New-Refusal 'bad-request') }

  # Lower-case hex only, and \z rather than $ (which also matches before a
  # trailing newline): the session id goes into a link, the folder into a command line.
  if (-not ($req.nonce -is [string] -and $req.nonce -cmatch '^[0-9a-f]{32}\z')) { return (New-Refusal 'bad-request') }
  $script:nonce = $req.nonce
  if (-not ($req.sessionId -is [string] -and $req.sessionId -match $uuid)) { return (New-Refusal 'bad-request') }
  # 'continue' is a keyword; quoted, it is only a property name.
  if ($req.'continue' -isnot [bool]) { return (New-Refusal 'bad-request') }

  $created = 0L
  if (-not [long]::TryParse([string]$req.createdTs, [ref]$created)) { return (New-Refusal 'bad-request') }
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ([Math]::Abs($now - $created) -gt 60000) { return (New-Refusal 'stale') }

  # A full path: a drive letter or a share, not "\x" or "x" (which mean the
  # current drive and the current folder) and not "c:x". Characters Windows never
  # allows in a path (the quote above all) are refused here, before any of it
  # reaches a command line.
  $cwd = $req.cwd
  if ($cwd -isnot [string]) { return (New-Refusal 'bad-request') }
  if ($cwd.IndexOfAny([IO.Path]::GetInvalidPathChars()) -ge 0) { return (New-Refusal 'bad-request') }
  if ($cwd -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\/])') { return (New-Refusal 'bad-request') }
  # A trailing \ would escape the closing quote of the argument below. Not a
  # drive (or share) root: VS Code on all of C:\ is never what was asked for.
  $folder = $cwd.TrimEnd('\', '/')
  if ($folder -eq [IO.Path]::GetPathRoot($cwd).TrimEnd('\', '/')) { return (New-Refusal 'bad-request') }
  if (-not (Test-Path -LiteralPath $folder -PathType Container)) { return (New-Refusal 'no-folder') }

  $code = Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\Code.exe'
  if (-not (Test-Path -LiteralPath $code -PathType Leaf)) { return (New-Refusal 'code-failed') }

  $folderArg = '"' + $folder + '"'
  $uri = 'vscode://anthropic.claude-code/open?session=' + $req.sessionId
  # OPEN NOW types this into the session's box, unsent: the cut-off turn is redone.
  if ($req.'continue') { $uri += '&prompt=Continue%20where%20you%20left%20off.' }

  if ($DryRun) {
    return ([ordered]@{ nonce = $script:nonce; ok = $true; dryRun = $true; folderArg = $folderArg; uri = $uri })
  }
  try {
    # Without this, a Code.exe started cold (VS Code was closed) attaches to the
    # console it was started from. The task runs this script under a hidden
    # conhost, so the task's action then lives as long as VS Code does: the task
    # stays Running to its time limit and the next request queues behind it and
    # times out. (With VS Code already running, the new Code.exe only hands off
    # and exits, so the task was never stuck.) ELECTRON_NO_ATTACH_CONSOLE is
    # Electron's switch for it: "don't attach to the current console session".
    $env:ELECTRON_NO_ATTACH_CONSOLE = '1'
    # The folder first, so its window exists for the link to find; then the link,
    # which opens the session's tab in that window.
    Start-Process -FilePath $code -ArgumentList $folderArg
    Start-Sleep -Milliseconds $DelayMs
    Start-Process $uri
  }
  catch {
    return (New-Refusal 'code-failed')
  }
  return ([ordered]@{ nonce = $script:nonce; ok = $true })
}

# Another run (the task queues them) may have taken the request already.
if (-not (Test-Path -LiteralPath $requestFile -PathType Leaf)) { exit 0 }

try {
  $result = Invoke-OpenRequest
}
catch {
  $result = New-Refusal 'bad-request'
}
try { Write-Result $result }
catch { }   # nowhere to say so; the service times out and says helper-timeout
exit 0
