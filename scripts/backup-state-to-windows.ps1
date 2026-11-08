param(
  [string]$BackupDir = 'C:\Offline\Organizacja\agf-private-backups'
)

# The log contains only fixed phase names and timestamps. Keep it beside the
# script so startup can be observed before the backup directory is checked.
function Write-BackupPhase {
  param([string]$Directory, [string]$RunStarted, [string]$Phase)
  try {
    $entry = @{ run_started_utc = $RunStarted; phase = $Phase; at_utc = [DateTime]::UtcNow.ToString('o') }
    $line = ($entry | ConvertTo-Json -Compress) + [Environment]::NewLine
    [System.IO.File]::AppendAllText((Join-Path $Directory 'backup-phases.log'), $line, [System.Text.UTF8Encoding]::new($false))
  } catch {
    # Missing diagnostics must never prevent a backup or its normal alert.
  }
}
$ErrorActionPreference = 'Stop'
$runStarted = [DateTime]::UtcNow.ToString('o')
Write-BackupPhase -Directory $PSScriptRoot -RunStarted $runStarted -Phase 'script-started'

# These functions keep the alert criteria independent of the actual backup and
# SSH transport, so the decision can be checked without live credentials.
function Get-PreviousRunWarning {
  param([string]$StatusJson, [DateTimeOffset]$Now)
  try {
    $status = $StatusJson | ConvertFrom-Json -ErrorAction Stop
    $previous = [DateTimeOffset]::MinValue
    $value = $status.checked_at_utc
    # Windows PowerShell preserves a JSON timestamp as text; PowerShell Core
    # may parse it as DateTime. Preserve its timezone in either case.
    if ($value -is [DateTime]) {
      if ($value.Kind -eq [DateTimeKind]::Unspecified) { throw 'timestamp-has-no-timezone' }
      $previous = [DateTimeOffset]::new($value)
    } elseif ($value -is [DateTimeOffset]) {
      $previous = $value
    } elseif (-not $value -or [string]$value -notmatch '(Z|[+-]\d{2}:\d{2})$' -or
              -not [DateTimeOffset]::TryParse([string]$value, [ref]$previous)) {
      throw 'invalid-timestamp'
    }
    $elapsed = ($Now.ToUniversalTime() - $previous.ToUniversalTime()).TotalHours
    if ($elapsed -lt -0.0834) { return 'Czas poprzedniego uruchomienia kopii jest nieprawidlowy.' }
    if ($elapsed -ge 48) { return 'Kopia nie byla uruchamiana przez co najmniej 48 godzin.' }
  } catch {
    return 'Nie mozna potwierdzic czasu poprzedniego uruchomienia kopii.'
  }
}

function Get-ControllerWarnings {
  param([string]$HealthJson)
  try {
    $health = $HealthJson | ConvertFrom-Json -ErrorAction Stop
    if ($null -eq $health -or $health.read_error -eq $true -or
        $health.service_active -isnot [bool] -or $health.nightly_scan_recent -isnot [bool]) {
      return 'Nie mozna potwierdzic stanu kontrolera.'
    }
    foreach ($value in @($health.queue, $health.errors, $health.uncertain, $health.promotion_errors, $health.promotion_missing)) {
      if (($value -isnot [int] -and $value -isnot [long]) -or $value -lt 0) {
        return 'Nie mozna potwierdzic stanu kontrolera.'
      }
    }
    if (-not $health.service_active) { 'Kontroler GitHub Flow nie dziala.' }
    if (-not $health.nightly_scan_recent) { 'Brak potwierdzenia nocnego skanu w ostatnich 48 godzinach.' }
    if ($health.errors -gt 0) { 'Kontroler zglosil blad wymagajacy sprawdzenia.' }
    if ($health.uncertain -gt 0) { 'Kontroler ma dlugo niepotwierdzony zapis.' }
    if ($health.queue -gt 0) { 'Nie mozna jeszcze potwierdzic oproznienia kolejki kontrolera.' }
    if ($health.promotion_errors -gt 0) { 'Nocna promocja wymaga sprawdzenia.' }
    if ($health.promotion_missing -gt 0) { 'Brak potwierdzenia nocnej promocji w ostatnich 48 godzinach.' }
  } catch {
    return 'Nie mozna potwierdzic stanu kontrolera.'
  }
}

# Windows PowerShell can wait indefinitely for OpenSSH even after a connection
# closes. Bound each child process so the existing failure notification runs.
function ConvertTo-ProcessArgument {
  param([AllowEmptyString()][string]$Value)
  $value = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
  $value = [regex]::Replace($value, '(\\+)$', '$1$1')
  return '"' + $value + '"'
}

function Invoke-BoundedProcess {
  param(
    [string]$FilePath,
    [string[]]$ProcessArguments,
    [AllowNull()][string]$InputText = $null,
    [ValidateRange(1, 300)][int]$TimeoutSeconds = 60
  )
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $FilePath
  $start.Arguments = (($ProcessArguments | ForEach-Object { ConvertTo-ProcessArgument $_ }) -join ' ')
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $start
  $started = $false
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    if (-not $process.Start()) { throw 'process-start-failed' }
    $started = $true
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if ($null -ne $InputText) {
      $write = $process.StandardInput.WriteAsync($InputText)
      if (-not $write.Wait($TimeoutSeconds * 1000)) { throw 'process-timeout' }
    }
    $process.StandardInput.Close()
    $remaining = [Math]::Max(0, ($TimeoutSeconds * 1000) - [int]$watch.ElapsedMilliseconds)
    if ($remaining -eq 0 -or -not $process.WaitForExit($remaining)) { throw 'process-timeout' }
    if (-not $stdout.Wait(3000) -or -not $stderr.Wait(3000)) { throw 'process-output-timeout' }
    if ($process.ExitCode -ne 0) { throw 'process-failed' }
    return $stdout.Result.TrimEnd([char[]]@("`r", "`n"))
  } finally {
    $cleanupFailed = $false
    if ($started) {
      try {
        if (-not $process.HasExited) {
          $process.Kill()
          if (-not $process.WaitForExit(3000)) { $cleanupFailed = $true }
        }
      } catch { $cleanupFailed = $true }
    }
    $process.Dispose()
    if ($cleanupFailed) { throw 'process-could-not-stop' }
  }
}

$result = 'failed'
$reason = 'not-started'
$checkedDir = $false
$temporary = $null
$sourceTimestamp = $null
$warnings = New-Object 'System.Collections.Generic.List[string]'
$healthResult = 'not-checked'
$remotePath = '/var/lib/agent-github-flow-mvp/state.sqlite.backup'
$python = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$ssh = Join-Path $env:SystemRoot 'System32\OpenSSH\ssh.exe'
$scp = Join-Path $env:SystemRoot 'System32\OpenSSH\scp.exe'
$options = @('-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2')

try {
  Write-BackupPhase -Directory $PSScriptRoot -RunStarted $runStarted -Phase 'before-directory'
  $dir = Get-Item -LiteralPath $BackupDir -Force
  if (-not $dir.PSIsContainer -or $dir.LinkType) { throw 'invalid-backup-directory' }
  Write-BackupPhase -Directory $PSScriptRoot -RunStarted $runStarted -Phase 'before-acl'
  $acl = Get-Acl -LiteralPath $dir.FullName
  if (-not $acl.AreAccessRulesProtected) { throw 'inherited-backup-acl' }
  Write-BackupPhase -Directory $PSScriptRoot -RunStarted $runStarted -Phase 'before-acl-identities'
  $allowed = @([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')
  foreach ($rule in $acl.Access) {
    $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    if ($sid -notin $allowed) { throw 'unexpected-backup-acl' }
  }
  $checkedDir = $true
  Write-BackupPhase -Directory $PSScriptRoot -RunStarted $runStarted -Phase 'preflight'
  if (-not (Test-Path -LiteralPath $python) -or -not (Test-Path -LiteralPath $ssh) -or -not (Test-Path -LiteralPath $scp)) { throw 'required-tool-unavailable' }

  $statusFile = Join-Path $dir.FullName 'last-run.json'
  if (Test-Path -LiteralPath $statusFile) {
    try {
      $previousJson = [System.IO.File]::ReadAllText($statusFile, [System.Text.Encoding]::UTF8)
      $gapWarning = Get-PreviousRunWarning -StatusJson $previousJson -Now ([DateTimeOffset]::UtcNow)
      if ($gapWarning) { $warnings.Add($gapWarning) }
    } catch { $warnings.Add('Nie mozna odczytac wyniku poprzedniego uruchomienia kopii.') }
  } else {
    $warnings.Add('Brak informacji o poprzednim uruchomieniu kopii.')
  }

  $reason = 'source-unavailable'
  Write-BackupPhase -Directory $PSScriptRoot -RunStarted $runStarted -Phase 'source-checksum'
  $before = Invoke-BoundedProcess -FilePath $ssh -ProcessArguments ($options + @('mikrus', "sha256sum -- $remotePath"))
  if ($before -notmatch '^([a-f0-9]{64})\s') { throw 'source-unavailable' }
  $expected = $Matches[1]
  $reason = 'source-stale'
  Write-BackupPhase -Directory $PSScriptRoot -RunStarted $runStarted -Phase 'source-time'
  $sourceTime = Invoke-BoundedProcess -FilePath $ssh -ProcessArguments ($options + @('mikrus', "stat -c %Y -- $remotePath"))
  if ($sourceTime -notmatch '^\d+$') { throw $reason }
  $ageSeconds = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - [long]$sourceTime
  if ($ageSeconds -lt -300 -or $ageSeconds -gt 172800) { throw $reason }
  $sourceTimestamp = [DateTimeOffset]::FromUnixTimeSeconds([long]$sourceTime).UtcDateTime.ToString('o')
  $id = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N')
  $temporary = Join-Path $dir.FullName ('.state-' + $id + '.partial')
  $final = Join-Path $dir.FullName ('state-' + $id + '.sqlite')
  $reason = 'copy-failed'
  Write-BackupPhase -Directory $PSScriptRoot -RunStarted $runStarted -Phase 'copy'
  [void](Invoke-BoundedProcess -FilePath $scp -ProcessArguments ($options + @(('mikrus:' + $remotePath), $temporary)))
  if (-not (Test-Path -LiteralPath $temporary)) { throw 'copy-failed' }

  $reason = 'source-changed-or-checksum-mismatch'
  Write-BackupPhase -Directory $PSScriptRoot -RunStarted $runStarted -Phase 'checksum-verification'
  $after = Invoke-BoundedProcess -FilePath $ssh -ProcessArguments ($options + @('mikrus', "sha256sum -- $remotePath"))
  if ($after -notmatch '^([a-f0-9]{64})\s' -or $Matches[1] -ne $expected) { throw $reason }
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $temporary).Hash.ToLowerInvariant() -ne $expected) { throw $reason }

  $reason = 'integrity-check-failed'
  Write-BackupPhase -Directory $PSScriptRoot -RunStarted $runStarted -Phase 'integrity-verification'
  $pythonCode = 'import pathlib, sqlite3, sys; p=pathlib.Path(sys.argv[1]); c=sqlite3.connect(p.resolve().as_uri()+"?mode=ro",uri=True); ok=(c.execute("PRAGMA integrity_check").fetchone()[0]=="ok" and c.execute("PRAGMA application_id").fetchone()[0]==0x4147464D and c.execute("PRAGMA user_version").fetchone()[0] in (1,2)); c.close(); sys.exit(0 if ok else 1)'
  [void](Invoke-BoundedProcess -FilePath $python -ProcessArguments @('-', $temporary) -InputText $pythonCode)
  [System.IO.File]::Move($temporary, $final)
  $temporary = $null
  $reason = 'ok'
  $result = 'ok'

  # The source snapshot precedes the nightly scan, so inspect the live state
  # separately. Only aggregate, non-sensitive values cross SSH.
  $healthCode = @'
import contextlib, json, os, re, sqlite3, subprocess, time
try:
    active = subprocess.run(['systemctl', 'is-active', 'agent-github-flow-mvp.service'], capture_output=True, text=True, timeout=10).stdout.strip() == 'active'
    journal = subprocess.run(['journalctl', '-u', 'agent-github-flow-mvp.service', '--since', '48 hours ago', '--grep', 'FLOW scan: nightly candidates queued', '-n', '1', '--no-pager', '-o', 'cat'], capture_output=True, text=True, timeout=10)
    if journal.returncode != 0:
        raise RuntimeError('journal unavailable')
    promotions = subprocess.run(['journalctl', '-u', 'agent-github-flow-mvp.service', '--since', '48 hours ago', '--grep', 'FLOW (promotion: |attention: promotion-)', '-n', '5000', '--no-pager', '-o', 'cat'], capture_output=True, text=True, timeout=10)
    # journalctl returns 1 without stderr when a grep has no matches yet.
    if promotions.returncode != 0 and not (promotions.returncode == 1 and not promotions.stdout and not promotions.stderr):
        raise RuntimeError('promotion journal unavailable')
    lines = promotions.stdout.splitlines()
    if len(lines) >= 5000:
        raise RuntimeError('promotion journal truncated')
    states = {}
    for line in lines:
        match = re.fullmatch(r'FLOW (?:promotion: |attention: promotion-)([a-z-]+) repo=([0-9]+)', line)
        if match:
            states[match.group(2)] = match.group(1)
    config_path = '/etc/agent-github-flow-mvp/config.json'
    with open(config_path, encoding='utf-8') as config_file:
        config = json.load(config_file)
    enabled = set()
    for project in config['projects']:
        if project.get('promotion_enabled') is True:
            if type(project.get('repository_id')) is not int or project['repository_id'] <= 0:
                raise ValueError('invalid promotion configuration')
            enabled.add(str(project['repository_id']))
    # A newly enabled project has up to 48 hours to produce its first nightly entry.
    missing = sum(repo not in states for repo in enabled) if time.time() - os.path.getmtime(config_path) >= 172800 else 0
    with contextlib.closing(sqlite3.connect('file:/var/lib/agent-github-flow-mvp/state.sqlite?mode=ro', uri=True, timeout=5)) as db:
        if db.execute('PRAGMA application_id').fetchone()[0] != 0x4147464D or db.execute('PRAGMA user_version').fetchone()[0] != 2:
            raise ValueError('unsupported schema')
        result = {'service_active': active, 'nightly_scan_recent': 'FLOW scan: nightly candidates queued' in journal.stdout,
                  'queue': db.execute('SELECT COUNT(*) FROM work_queue').fetchone()[0],
                  'errors': db.execute('SELECT COUNT(*) FROM issues WHERE error_code IS NOT NULL').fetchone()[0],
                  'uncertain': db.execute('SELECT COUNT(*) FROM issues WHERE uncertain_since IS NOT NULL AND uncertain_since < ?', (time.time() - 180,)).fetchone()[0],
                  'promotion_errors': sum(states.get(repo) in ('failed', 'blocked', 'protection-required', 'incomplete') for repo in enabled),
                  'promotion_missing': missing}
    print(json.dumps(result))
except Exception:
    print(json.dumps({'read_error': True}))
'@
  try {
    Write-BackupPhase -Directory $PSScriptRoot -RunStarted $runStarted -Phase 'controller-health'
    $healthJson = Invoke-BoundedProcess -FilePath $ssh -ProcessArguments ($options + @('mikrus', 'python3 -')) -InputText $healthCode
    $healthWarnings = @(Get-ControllerWarnings -HealthJson $healthJson)
    # A queue may simply be processing a fresh event. Check once more before
    # warning rather than treating a short-lived pending item as an error.
    if ($healthWarnings -contains 'Nie mozna jeszcze potwierdzic oproznienia kolejki kontrolera.') {
      Start-Sleep -Seconds 15
      $healthJson = Invoke-BoundedProcess -FilePath $ssh -ProcessArguments ($options + @('mikrus', 'python3 -')) -InputText $healthCode
      $healthWarnings = @(Get-ControllerWarnings -HealthJson $healthJson)
    }
    if ($healthWarnings.Count -eq 0) { $healthResult = 'ok' }
    else {
      $healthResult = 'attention'
      foreach ($message in $healthWarnings) { $warnings.Add($message) }
    }
  } catch {
    $healthResult = 'attention'
    $warnings.Add('Nie mozna potwierdzic stanu kontrolera.')
  }
} catch {
  if ($reason -eq 'not-started') { $reason = 'preflight-failed' }
  if ($_.Exception.Message -in @('process-timeout', 'process-output-timeout', 'process-could-not-stop')) { $reason = 'process-timeout' }
} finally {
  Write-BackupPhase -Directory $PSScriptRoot -RunStarted $runStarted -Phase 'finalization'
  if ($result -ne 'ok') { $warnings.Add('Nie udalo sie wykonac lub zweryfikowac kopii GitHub Flow.') }
  if ($checkedDir) {
    try {
      if ($temporary -and (Test-Path -LiteralPath $temporary)) {
        $prefix = $dir.FullName.TrimEnd('\') + '\'
        $full = [System.IO.Path]::GetFullPath($temporary)
        if ($full.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) -and [System.IO.Path]::GetFileName($full) -match '^\.state-[0-9-]+-[a-f0-9]{32}\.partial$') {
          Remove-Item -LiteralPath $full -Force
        }
      }
    } catch { $warnings.Add('Nie mozna usunac niekompletnej kopii tymczasowej.') }
    try {
      $status = @{ result = $result; reason = $reason; checked_at_utc = [DateTime]::UtcNow.ToString('o'); source_snapshot_utc = $sourceTimestamp; controller_health = $healthResult; warnings = @($warnings.ToArray()) }
      [System.IO.File]::WriteAllText((Join-Path $dir.FullName 'last-run.json'), ($status | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))
    } catch { $warnings.Add('Nie mozna zapisac wyniku sprawdzenia kopii.') }
  }
  if ($warnings.Count -gt 0) {
    Write-BackupPhase -Directory $PSScriptRoot -RunStarted $runStarted -Phase 'notification'
    try {
      # Reuse the installed Terminal app identity: the toast remains in the
      # user's notification center after its banner disappears. One fixed tag
      # replaces older warnings instead of accumulating scheduled retries.
      $appId = 'Microsoft.WindowsTerminal_8wekyb3d8bbwe!App'
      if (-not @(Get-StartApps | Where-Object { $_.AppID -eq $appId }).Count) { throw 'notification-app-missing' }
      [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null
      [Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null
      [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] > $null
      $message = ($warnings -join "`n") + "`nSprawdzono: " + (Get-Date -Format 'yyyy-MM-dd HH:mm')
      $escaped = [System.Security.SecurityElement]::Escape($message)
      $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
      $xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>GitHub Flow - potrzebna uwaga</text><text>' + $escaped + '</text></binding></visual></toast>')
      $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
      $toast.Tag = 'agf-backup'
      $toast.Group = 'agf'
      $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
      if ($notifier.Setting.ToString() -ne 'Enabled') { throw 'notifications-disabled' }
      [Windows.UI.Notifications.ToastNotificationManager]::History.Remove('agf-backup', 'agf', $appId)
      $notifier.Show($toast)
      $history = [Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory($appId)
      if (-not @($history | Where-Object { $_.Tag -eq 'agf-backup' -and $_.Group -eq 'agf' }).Count) { throw 'notification-unconfirmed' }
    } catch {
      try {
        $shell = New-Object -ComObject WScript.Shell
        [void]$shell.Popup(($warnings -join "`r`n"), 60, 'GitHub Flow - potrzebna uwaga', 48)
      } catch { Write-Warning 'Nie mozna pokazac ostrzezenia Windows.' }
    }
  }
  Write-BackupPhase -Directory $PSScriptRoot -RunStarted $runStarted -Phase 'finished'
}
if ($result -ne 'ok') { Write-Error ('Backup failed: ' + $reason); exit 1 }
Write-Output 'Backup integrity and checksum verified.'
