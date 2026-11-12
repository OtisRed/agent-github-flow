$ErrorActionPreference = 'Stop'
$source = Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\backup-state-to-windows.ps1'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Backup script does not parse' }

# Load only the pure decision functions, never the backup, SSH or popup code.
foreach ($name in @('Get-PreviousRunWarning', 'Get-ControllerWarnings', 'ConvertTo-ProcessArgument', 'Invoke-BoundedProcess', 'Write-BackupPhase')) {
  $function = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
  if (-not $function) { throw "Missing function: $name" }
  . ([scriptblock]::Create($function.Extent.Text))
}

function Assert-Equal($Actual, $Expected, $Name) {
  if ($Actual -ne $Expected) { throw "$Name failed: expected '$Expected', got '$Actual'" }
}
function Assert-Count($Actual, $Expected, $Name) {
  if (@($Actual).Count -ne $Expected) { throw "$Name failed: wrong number of warnings" }
}

$now = [DateTimeOffset]::Parse('2026-11-05T12:00:00Z')
Assert-Count @(Get-PreviousRunWarning -StatusJson '{"checked_at_utc":"2026-11-03T12:00:01Z"}' -Now $now) 0 'less than 48 hours is allowed'
Assert-Count @(Get-PreviousRunWarning -StatusJson '{"checked_at_utc":"2026-11-03T12:00:00Z"}' -Now $now) 1 'gap of 48 hours'
Assert-Count @(Get-PreviousRunWarning -StatusJson '{"checked_at_utc":"2026-11-03T11:59:59Z"}' -Now $now) 1 'gap over 48 hours'
Assert-Count @(Get-PreviousRunWarning -StatusJson '{"checked_at_utc":"2026-11-03T13:00:01+01:00"}' -Now $now) 0 'timezone offset is preserved'
Assert-Count @(Get-PreviousRunWarning -StatusJson '{"checked_at_utc":"2026-11-03T12:00:00"}' -Now $now) 1 'missing timezone is rejected'
Assert-Count @(Get-PreviousRunWarning -StatusJson '{"checked_at_utc":"2026-11-05T12:06:00Z"}' -Now $now) 1 'future time'
Assert-Count @(Get-PreviousRunWarning -StatusJson '{}' -Now $now) 1 'missing prior timestamp'
Assert-Count @(Get-PreviousRunWarning -StatusJson 'invalid json' -Now $now) 1 'invalid prior status'

$healthy = '{"service_active":true,"nightly_scan_recent":true,"archive_state":"off","queue":0,"errors":0,"uncertain":0,"promotion_errors":0,"promotion_missing":0}'
Assert-Count @(Get-ControllerWarnings -HealthJson $healthy) 0 'healthy controller'
Assert-Count @(Get-ControllerWarnings -HealthJson '{"service_active":false,"nightly_scan_recent":false,"archive_state":"off","queue":2,"errors":1,"uncertain":1,"promotion_errors":1,"promotion_missing":1}') 7 'independent problems'
Assert-Count @(Get-ControllerWarnings -HealthJson '{"service_active":true,"nightly_scan_recent":true,"archive_state":"off","queue":0,"errors":0,"uncertain":0,"promotion_errors":1,"promotion_missing":0}') 1 'promotion failure is reported'
Assert-Count @(Get-ControllerWarnings -HealthJson '{"service_active":true,"nightly_scan_recent":true,"archive_state":"off","queue":0,"errors":0,"uncertain":0,"promotion_errors":0,"promotion_missing":1}') 1 'missing promotion is reported'
Assert-Count @(Get-ControllerWarnings -HealthJson '{"service_active":true,"nightly_scan_recent":true,"archive_state":"failed","queue":0,"errors":0,"uncertain":0,"promotion_errors":0,"promotion_missing":0}') 1 'archive failure is reported'
Assert-Count @(Get-ControllerWarnings -HealthJson '{"service_active":true,"nightly_scan_recent":true,"archive_state":"missing","queue":0,"errors":0,"uncertain":0,"promotion_errors":0,"promotion_missing":0}') 1 'missing archive is reported'
Assert-Count @(Get-ControllerWarnings -HealthJson '{"service_active":true,"nightly_scan_recent":true,"archive_state":"pending","queue":0,"errors":0,"uncertain":0,"promotion_errors":0,"promotion_missing":0}') 0 'first archive can be pending'
Assert-Count @(Get-ControllerWarnings -HealthJson '{"read_error":true}') 1 'remote probe failed'
Assert-Count @(Get-ControllerWarnings -HealthJson '{"service_active":true}') 1 'incomplete remote probe'
Assert-Count @(Get-ControllerWarnings -HealthJson '{"service_active":true,"nightly_scan_recent":true,"queue":false,"errors":0,"uncertain":0}') 1 'invalid count type'
Assert-Count @(Get-ControllerWarnings -HealthJson '{"service_active":true,"nightly_scan_recent":true,"queue":-1,"errors":0,"uncertain":0}') 1 'invalid negative count'
Assert-Count @(Get-ControllerWarnings -HealthJson 'not json') 1 'invalid remote probe'

$bundledPython = if ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' } else { $null }
$python = if ($bundledPython -and (Test-Path -LiteralPath $bundledPython)) { $bundledPython } else { (Get-Command python3 -ErrorAction Stop).Source }
# Exercise the real queue and SQL embedded in the backup across retries.
$retryCode = @'
import contextlib,json,re,sqlite3,sys,tempfile
from pathlib import Path
root=Path(sys.argv[1])
sys.path.insert(0,str(root / 'src'))
from mvp_store import Store
from mvp_worker import process_one

source=(root / 'scripts' / 'backup-state-to-windows.ps1').read_text(encoding='utf-8')
match=re.search(r"'queue': db\.execute\('([^']+)'\)\.fetchone\(\)\[0\]",source)
if not match:
    raise SystemExit('queue probe not found')
sql=match.group(1)
now=[1000.0]
class Github:
    failing=True
    def read(self,*_):
        if self.failing:
            raise ValueError('Issue changed during read')
        return {'complete':True,'state':'OPEN','status':'needs-design',
                'created_at':'2026-10-01T00:00:00Z','comments':[],'latest_reopen':None}
    def set_status(self,*_):
        raise AssertionError('unexpected write')

with tempfile.TemporaryDirectory() as directory:
    path=Path(directory) / 'state.sqlite'
    store=Store(path,clock=lambda:now[0])
    store.initialize()
    store.enqueue(20,7)
    github=Github()
    for attempt in range(3):
        result=process_one(store,github,enrolled_at='2026-11-01T00:00:00Z',
                           trusted_authors=frozenset({10}))
        if result.get('cause')!='issue-changed':
            raise AssertionError('expected deferred read')
        if attempt<2:
            now[0]+=60
    def count():
        with contextlib.closing(sqlite3.connect(path)) as db:
            return db.execute(sql).fetchone()[0]
    first=count()
    now[0]+=15
    second=count()
    now[0]+=45
    github.failing=False
    if process_one(store,github,enrolled_at='2026-11-01T00:00:00Z',
                   trusted_authors=frozenset({10})).get('kind')!='completed':
        raise AssertionError('expected recovery')
    print(json.dumps({'first':first,'second':second,'recovered':count()}))
'@
$retryJson = (& $python -c $retryCode (Split-Path -Parent $PSScriptRoot)) -join [Environment]::NewLine
if ($LASTEXITCODE -ne 0) { throw 'synthetic retry probe failed' }
$retry = $retryJson | ConvertFrom-Json
$health = $healthy | ConvertFrom-Json
foreach ($sample in @($retry.first, $retry.second)) {
  $health.queue = $sample
  $warnings = @(Get-ControllerWarnings -HealthJson ($health | ConvertTo-Json -Compress))
  Assert-Count $warnings 1 'persistent queue is reported'
  Assert-Equal $warnings[0] 'Nie mozna jeszcze potwierdzic oproznienia kolejki kontrolera.' 'queue warning'
}
$health.queue = $retry.recovered
Assert-Count @(Get-ControllerWarnings -HealthJson ($health | ConvertTo-Json -Compress)) 0 'resolved retry clears warning'

$echoCode = 'import json,sys; print(json.dumps({"args":sys.argv[1:],"input":sys.stdin.read()}))'
$echo = Invoke-BoundedProcess -FilePath $python -ProcessArguments @('-c', $echoCode, 'space value', 'quote"value', 'trailing\') -InputText "hello`n" -TimeoutSeconds 15 | ConvertFrom-Json
Assert-Equal $echo.args[0] 'space value' 'argument with spaces'
Assert-Equal $echo.args[1] 'quote"value' 'argument with quotes'
Assert-Equal $echo.args[2] 'trailing\' 'argument with trailing backslash'
Assert-Equal $echo.input "hello`n" 'standard input reaches child and closes'
$failed = $false
try { [void](Invoke-BoundedProcess -FilePath $python -ProcessArguments @('-c', 'import sys; sys.exit(7)') -TimeoutSeconds 15) }
catch { if ($_.Exception.Message -notlike '*process-failed*') { throw }; $failed = $true }
if (-not $failed) { throw 'nonzero child exit was not reported' }

$pidPath = Join-Path ([IO.Path]::GetTempPath()) ('agf-process-test-' + [Guid]::NewGuid().ToString('N') + '.txt')
try {
  $hangCode = 'import os,sys,time; open(sys.argv[1],"w").write(str(os.getpid())); time.sleep(30)'
  $failed = $false
  try { [void](Invoke-BoundedProcess -FilePath $python -ProcessArguments @('-c', $hangCode, $pidPath) -TimeoutSeconds 3) }
  catch { if ($_.Exception.Message -notlike '*process-timeout*') { throw }; $failed = $true }
  if (-not $failed -or -not (Test-Path -LiteralPath $pidPath)) { throw 'hung child did not time out as expected' }
  $childId = [int][IO.File]::ReadAllText($pidPath)
  if (Get-Process -Id $childId -ErrorAction SilentlyContinue) { throw 'timed-out child is still running' }
} finally {
  if (Test-Path -LiteralPath $pidPath) { Remove-Item -LiteralPath $pidPath -Force }
}

# A child that does not read its input must not trap the caller while stdin is
# being written, either. This models an unresponsive SSH health-probe process.
$blockedInput = 'x' * 1048576
$timedOut = $false
try { [void](Invoke-BoundedProcess -FilePath $python -ProcessArguments @('-c', 'import time; time.sleep(30)') -InputText $blockedInput -TimeoutSeconds 3) }
catch { if ($_.Exception.Message -notlike '*process-timeout*') { throw }; $timedOut = $true }
if (-not $timedOut) { throw 'blocked input did not time out' }

# Phase records from interrupted runs must remain available after a retry;
# logging failures are observational and must not stop the actual backup.
$diagnosticDir = Join-Path ([IO.Path]::GetTempPath()) ('agf-phase-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $diagnosticDir | Out-Null
try {
  Write-BackupPhase -Directory $diagnosticDir -RunStarted 'run-1' -Phase 'copy'
  Write-BackupPhase -Directory $diagnosticDir -RunStarted 'run-2' -Phase 'preflight'
  $lines = @(Get-Content -LiteralPath (Join-Path $diagnosticDir 'backup-phases.log'))
  Assert-Equal $lines.Count 2 'phase log retains previous attempt'
  $first = $lines[0] | ConvertFrom-Json
  $second = $lines[1] | ConvertFrom-Json
  Assert-Equal $first.run_started_utc 'run-1' 'first attempt identity'
  Assert-Equal $first.phase 'copy' 'interrupted phase'
  Assert-Equal $second.run_started_utc 'run-2' 'retry identity'
  Assert-Equal $second.phase 'preflight' 'retry phase'
  if (@($first.PSObject.Properties).Count -ne 3 -or -not $first.at_utc) { throw 'phase log includes unexpected fields' }
  Write-BackupPhase -Directory (Join-Path $diagnosticDir 'missing') -RunStarted 'run-3' -Phase 'preflight'
} finally {
  Remove-Item -LiteralPath (Join-Path $diagnosticDir 'backup-phases.log') -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $diagnosticDir -Force -ErrorAction SilentlyContinue
}

# A failure before the backup directory can be checked must still leave an
# early phase. The isolated fixture cannot show a notification or access SSH.
$earlyDir = Join-Path ([IO.Path]::GetTempPath()) ('agf-early-phase-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $earlyDir | Out-Null
try {
  $earlyScript = Join-Path $earlyDir 'backup.ps1'
  $earlyLog = Join-Path $earlyDir 'backup-phases.log'
  $sourceText = [IO.File]::ReadAllText($source)
  $fixture = $sourceText.Replace('if ($warnings.Count -gt 0) {', 'if ($false) {')
  if ($fixture -eq $sourceText) { throw 'could not disable fixture notification' }
  [IO.File]::WriteAllText($earlyScript, $fixture, [Text.UTF8Encoding]::new($false))
  $shellPath = (Get-Process -Id $PID).Path
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $shellPath -NoProfile -NonInteractive -File $earlyScript -BackupDir (Join-Path $earlyDir 'missing') 2>&1 | Out-Null
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($LASTEXITCODE -eq 0) { throw 'missing backup directory unexpectedly succeeded' }
  $global:LASTEXITCODE = 0
  if (-not (Test-Path -LiteralPath $earlyLog)) { throw 'missing early phase log' }
  $initial = (Get-Content -LiteralPath $earlyLog -TotalCount 1) | ConvertFrom-Json
  Assert-Equal $initial.phase 'script-started' 'phase logged before preflight'
} finally {
  Remove-Item -LiteralPath (Join-Path $earlyDir 'backup-phases.log') -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $earlyDir 'backup.ps1') -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $earlyDir -Force -ErrorAction SilentlyContinue
}
Write-Output 'Backup monitor decision tests passed.'
