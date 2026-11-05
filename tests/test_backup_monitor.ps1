$ErrorActionPreference = 'Stop'
$source = Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\backup-state-to-windows.ps1'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Backup script does not parse' }

# Load only the pure decision functions, never the backup, SSH or popup code.
foreach ($name in @('Get-PreviousRunWarning', 'Get-ControllerWarnings')) {
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

$healthy = '{"service_active":true,"nightly_scan_recent":true,"queue":0,"errors":0,"uncertain":0}'
Assert-Count @(Get-ControllerWarnings -HealthJson $healthy) 0 'healthy controller'
Assert-Count @(Get-ControllerWarnings -HealthJson '{"service_active":false,"nightly_scan_recent":false,"queue":2,"errors":1,"uncertain":1}') 5 'independent problems'
Assert-Count @(Get-ControllerWarnings -HealthJson '{"read_error":true}') 1 'remote probe failed'
Assert-Count @(Get-ControllerWarnings -HealthJson '{"service_active":true}') 1 'incomplete remote probe'
Assert-Count @(Get-ControllerWarnings -HealthJson '{"service_active":true,"nightly_scan_recent":true,"queue":false,"errors":0,"uncertain":0}') 1 'invalid count type'
Assert-Count @(Get-ControllerWarnings -HealthJson '{"service_active":true,"nightly_scan_recent":true,"queue":-1,"errors":0,"uncertain":0}') 1 'invalid negative count'
Assert-Count @(Get-ControllerWarnings -HealthJson 'not json') 1 'invalid remote probe'
Write-Output 'Backup monitor decision tests passed.'
