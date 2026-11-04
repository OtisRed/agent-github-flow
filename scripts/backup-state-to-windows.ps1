param(
  [string]$BackupDir = 'C:\Offline\Organizacja\agf-private-backups'
)

$ErrorActionPreference = 'Stop'
$result = 'failed'
$reason = 'not-started'
$checkedDir = $false
$temporary = $null
$sourceTimestamp = $null
$remotePath = '/var/lib/agent-github-flow-mvp/state.sqlite.backup'
$python = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$ssh = Join-Path $env:SystemRoot 'System32\OpenSSH\ssh.exe'
$scp = Join-Path $env:SystemRoot 'System32\OpenSSH\scp.exe'
$options = @('-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15')

try {
  $dir = Get-Item -LiteralPath $BackupDir -Force
  if (-not $dir.PSIsContainer -or $dir.LinkType) { throw 'invalid-backup-directory' }
  $acl = Get-Acl -LiteralPath $dir.FullName
  if (-not $acl.AreAccessRulesProtected) { throw 'inherited-backup-acl' }
  $allowed = @([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')
  foreach ($rule in $acl.Access) {
    $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    if ($sid -notin $allowed) { throw 'unexpected-backup-acl' }
  }
  $checkedDir = $true
  if (-not (Test-Path -LiteralPath $python) -or -not (Test-Path -LiteralPath $ssh) -or -not (Test-Path -LiteralPath $scp)) { throw 'required-tool-unavailable' }

  $reason = 'source-unavailable'
  $before = & $ssh @options mikrus "sha256sum -- $remotePath" 2>$null
  if ($LASTEXITCODE -ne 0 -or $before -notmatch '^([a-f0-9]{64})\s') { throw 'source-unavailable' }
  $expected = $Matches[1]
  $reason = 'source-stale'
  $sourceTime = & $ssh @options mikrus "stat -c %Y -- $remotePath" 2>$null
  if ($LASTEXITCODE -ne 0 -or $sourceTime -notmatch '^\d+$') { throw $reason }
  $ageSeconds = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - [long]$sourceTime
  if ($ageSeconds -lt -300 -or $ageSeconds -gt 172800) { throw $reason }
  $sourceTimestamp = [DateTimeOffset]::FromUnixTimeSeconds([long]$sourceTime).UtcDateTime.ToString('o')
  $id = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N')
  $temporary = Join-Path $dir.FullName ('.state-' + $id + '.partial')
  $final = Join-Path $dir.FullName ('state-' + $id + '.sqlite')
  $reason = 'copy-failed'
  & $scp @options ('mikrus:' + $remotePath) $temporary 2>$null
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $temporary)) { throw 'copy-failed' }

  $reason = 'source-changed-or-checksum-mismatch'
  $after = & $ssh @options mikrus "sha256sum -- $remotePath" 2>$null
  if ($LASTEXITCODE -ne 0 -or $after -notmatch '^([a-f0-9]{64})\s' -or $Matches[1] -ne $expected) { throw $reason }
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $temporary).Hash.ToLowerInvariant() -ne $expected) { throw $reason }

  $reason = 'integrity-check-failed'
  $pythonCode = 'import pathlib, sqlite3, sys; p=pathlib.Path(sys.argv[1]); c=sqlite3.connect(p.resolve().as_uri()+"?mode=ro",uri=True); ok=(c.execute("PRAGMA integrity_check").fetchone()[0]=="ok" and c.execute("PRAGMA application_id").fetchone()[0]==0x4147464D and c.execute("PRAGMA user_version").fetchone()[0]==1); c.close(); sys.exit(0 if ok else 1)'
  $pythonCode | & $python - $temporary 2>$null
  if ($LASTEXITCODE -ne 0) { throw $reason }
  [System.IO.File]::Move($temporary, $final)
  $temporary = $null
  $reason = 'ok'
  $result = 'ok'
} catch {
  if ($reason -eq 'not-started') { $reason = 'preflight-failed' }
} finally {
  if ($checkedDir) {
    if ($temporary -and (Test-Path -LiteralPath $temporary)) {
      $prefix = $dir.FullName.TrimEnd('\') + '\'
      $full = [System.IO.Path]::GetFullPath($temporary)
      if ($full.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) -and [System.IO.Path]::GetFileName($full) -match '^\.state-[0-9-]+-[a-f0-9]{32}\.partial$') {
        Remove-Item -LiteralPath $full -Force
      }
    }
    $status = @{ result = $result; reason = $reason; checked_at_utc = [DateTime]::UtcNow.ToString('o'); source_snapshot_utc = $sourceTimestamp }
    [System.IO.File]::WriteAllText((Join-Path $dir.FullName 'last-run.json'), ($status | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))
  }
}
if ($result -ne 'ok') { Write-Error ('Backup failed: ' + $reason); exit 1 }
Write-Output 'Backup integrity and checksum verified.'
