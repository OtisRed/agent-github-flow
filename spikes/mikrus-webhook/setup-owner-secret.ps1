$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Run only in the owner's own terminal. The assistant must not capture its
# clipboard or secret. The secret travels over SSH stdin, never command args.
$bytes = New-Object byte[] 32
$generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
$secret = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
if ($secret.Length -ne 43) { throw 'Secret generation failed.' }

$ssh = (Get-Command ssh.exe -CommandType Application).Source
$info = New-Object System.Diagnostics.ProcessStartInfo
$info.FileName = $ssh
$sshConfig = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ssh\config'
$info.Arguments = '-F "' + $sshConfig + '" -o BatchMode=yes -o ConnectTimeout=8 mikrus python3 /opt/agent-github-flow-spike-71/install_owner_secret.py'
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardInput = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$process = New-Object System.Diagnostics.Process
$process.StartInfo = $info
try {
    if (-not $process.Start()) { throw 'SSH did not start.' }
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $process.StandardInput.Write($secret)
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(30000)) { $process.Kill(); throw 'SSH timed out; installation is uncertain.' }
    $process.WaitForExit()
    if ($process.ExitCode -ne 0 -or $stdout.Result.Trim() -ne 'Secret installed.') { throw 'Installation failed or is uncertain.' }
    try { Set-Clipboard -Value $secret } catch {
        Write-Host 'Secret installed, but clipboard failed. Keep this window open and contact the assistant; do not retry.'
        Read-Host 'Press Enter only after recovery instructions' | Out-Null
        exit 1
    }
    Write-Host 'Secret installed on Mikrus and copied to your clipboard. Paste it into the GitHub App webhook Secret field.'
} catch {
    Write-Error 'Secret installation was not confirmed. Do not retry; contact the assistant.'
    exit 1
} finally {
    $process.Dispose()
    [Array]::Clear($bytes, 0, $bytes.Length)
    $secret = $null
}
