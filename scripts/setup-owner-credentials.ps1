$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Run in the owner's terminal. Secret values are never command arguments or output.
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Choose the GitHub App private key (.pem)'
$dialog.Filter = 'PEM key (*.pem)|*.pem'
if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
    Write-Host 'Cancelled; no changes made.'
    exit 1
}
$keyBytes = [IO.File]::ReadAllBytes($dialog.FileName)
$secureToken = Read-Host 'Paste the classic Project PAT (input is hidden)' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
$process = $null
try {
    $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    $payload = @{ private_key_b64 = [Convert]::ToBase64String($keyBytes); project_token = $token } | ConvertTo-Json -Compress
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = (Get-Command ssh.exe -CommandType Application).Source
    $info.Arguments = '-o BatchMode=yes -o ConnectTimeout=8 mikrus python3 /opt/agent-github-flow-mvp/scripts/install_owner_credentials.py'
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    if (-not $process.Start()) { throw 'SSH did not start.' }
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $process.StandardInput.Write($payload)
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(30000)) { $process.Kill(); throw 'Installation is uncertain.' }
    $process.WaitForExit()
    if ($process.ExitCode -ne 0 -or $stdout.Result.Trim() -ne 'Credentials installed.') { throw 'Installation is uncertain.' }
    Write-Host 'Credentials installed. Tell the assistant: gotowe.'
} catch {
    Write-Host 'Installation failed or is uncertain. Do not retry; tell the assistant.'
    exit 1
} finally {
    if ($process) { $process.Dispose() }
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    [Array]::Clear($keyBytes, 0, $keyBytes.Length)
    $token = $null
    $payload = $null
    $secureToken.Dispose()
    $dialog.Dispose()
}
