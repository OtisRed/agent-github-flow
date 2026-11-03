[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('status', 'store', 'self-test')]
    [string] $Action
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# This script never accepts the token in a command argument, environment
# variable, file, or agent-visible response. `store` must run in the owner's
# own interactive console. Git Credential Manager receives it over stdin.
$relayHost = 'agent-github-flow-relay.invalid'
$relayUser = 'agent-github-flow-relay'

if ($env:OS -ne 'Windows_NT') {
    Write-Error 'This credential store is available only on Windows.'
    exit 1
}

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class AgentFlowCredentialPresence {
    [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
    [DllImport("advapi32.dll", SetLastError=true)]
    private static extern void CredFree(IntPtr credential);
    public static bool Exists(string target) {
        IntPtr credential;
        if (CredRead(target, 1, 0, out credential)) {
            CredFree(credential);
            return true;
        }
        int error = Marshal.GetLastWin32Error();
        if (error == 1168) return false;
        throw new Win32Exception(error);
    }
}
'@

function Test-CredentialExists([string] $HostName) {
    return [AgentFlowCredentialPresence]::Exists("agent-github-flow:https://$HostName")
}

function Invoke-CredentialManager([string] $Operation, [string] $InputRecord) {
    $git = Get-Command git -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $info = [System.Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $git.Source
    $info.Arguments = "credential-manager $Operation"
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($name in @($info.EnvironmentVariables.Keys)) {
        if ($name -match '^(GIT_TRACE|GCM_TRACE)') { $info.EnvironmentVariables.Remove($name) }
    }
    $info.EnvironmentVariables['GCM_CREDENTIAL_STORE'] = 'wincredman'
    $info.EnvironmentVariables['GCM_PROVIDER'] = 'generic'
    $info.EnvironmentVariables['GCM_INTERACTIVE'] = 'never'
    $info.EnvironmentVariables['GCM_NAMESPACE'] = 'agent-github-flow'
    $info.EnvironmentVariables['GCM_TRACE'] = '0'
    $info.EnvironmentVariables['GCM_TRACE_SECRETS'] = '0'
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $info
    try {
        if (-not $process.Start()) { throw 'credential-manager-start-failed' }
        $out = $process.StandardOutput.ReadToEndAsync()
        $err = $process.StandardError.ReadToEndAsync()
        $process.StandardInput.Write($InputRecord)
        $process.StandardInput.Close()
        if (-not $process.WaitForExit(30000)) {
            $process.Kill()
            throw 'credential-manager-timeout'
        }
        $process.WaitForExit()
        # stderr may contain sensitive data; never print either child stream.
        return @{ ExitCode = $process.ExitCode; Output = $out.Result }
    } finally {
        $process.Dispose()
    }
}

function New-CredentialQuery([string] $HostName, [string] $UserName) {
    return "protocol=https`nhost=$HostName`nusername=$UserName`n`n"
}

function Store-Credential([string] $HostName, [string] $UserName, [string] $Password, [bool] $VerifySynthetic = $false) {
    if (Test-CredentialExists $HostName) { throw 'credential-already-exists' }
    $record = "protocol=https`nhost=$HostName`nusername=$UserName`npassword=$Password`n`n"
    $result = Invoke-CredentialManager 'store' $record
    if ($result.ExitCode -ne 0 -or -not (Test-CredentialExists $HostName)) { throw 'credential-store-unconfirmed' }
    if ($VerifySynthetic) {
        # This path is only called with a hard-coded fake self-test password.
        $read = Invoke-CredentialManager 'get' (New-CredentialQuery $HostName $UserName)
        if ($read.ExitCode -ne 0) { throw 'synthetic-readback-unconfirmed' }
        $passwordLines = @($read.Output -split "`r?`n" | Where-Object { $_.StartsWith('password=') })
        if ($passwordLines.Count -ne 1 -or $passwordLines[0].Substring(9) -cne $Password) {
            throw 'synthetic-readback-unconfirmed'
        }
    }
}

function Invoke-SyntheticSelfTest {
    $testHost = 'agent-github-flow-vault-selftest-' + [Guid]::NewGuid().ToString('N') + '.invalid'
    $testUser = 'synthetic-only'
    $testPassword = 'synthetic-value-not-a-real-credential'
    # The public synthetic target is shown before creation for manual cleanup
    # if the process is interrupted; it never identifies a real credential.
    "Synthetic test slot: agent-github-flow:https://$testHost"
    if (Test-CredentialExists $testHost) { throw 'self-test-slot-occupied' }
    try {
        Store-Credential $testHost $testUser $testPassword $true
        $duplicateBlocked = $false
        try { Store-Credential $testHost $testUser 'another-synthetic-value' $true }
        catch {
            if ($_.Exception.Message -ne 'credential-already-exists') { throw }
            $duplicateBlocked = $true
        }
        if (-not $duplicateBlocked) { throw 'synthetic-overwrite-not-blocked' }
        $read = Invoke-CredentialManager 'get' (New-CredentialQuery $testHost $testUser)
        $passwordLines = @($read.Output -split "`r?`n" | Where-Object { $_.StartsWith('password=') })
        if ($read.ExitCode -ne 0 -or $passwordLines.Count -ne 1 -or $passwordLines[0].Substring(9) -cne $testPassword) {
            throw 'synthetic-overwrite-check-failed'
        }
        'Synthetic vault store and readback passed.'
        'Existing synthetic slot refused and value preserved.'
    } finally {
        $erase = Invoke-CredentialManager 'erase' (New-CredentialQuery $testHost $testUser)
        if ($erase.ExitCode -ne 0 -or (Test-CredentialExists $testHost)) { throw 'self-test-cleanup-unconfirmed' }
    }
    'Synthetic vault entry removed.'
}

$mutex = [System.Threading.Mutex]::new($false, 'Local\AgentGitHubFlowRelayVaultV1')
$locked = $false
try {
    $locked = $mutex.WaitOne(0)
    if (-not $locked) { throw 'vault-busy' }
    if ($Action -eq 'status') {
        if (Test-CredentialExists $relayHost) { 'Relay credential slot occupied; identity, validity and permissions unverified.' }
        else { 'Relay credential: absent.' }
    } elseif ($Action -eq 'self-test') {
        Invoke-SyntheticSelfTest
    } else {
        if (-not [Environment]::UserInteractive -or [Console]::IsInputRedirected) { throw 'interactive-console-required' }
        if (Test-CredentialExists $relayHost) { throw 'credential-already-exists' }
        # Check the real GCM/store configuration using only a fake credential
        # before asking the owner to paste anything sensitive.
        Invoke-SyntheticSelfTest
        if (Test-CredentialExists $relayHost) { throw 'credential-already-exists' }
        $secure = Read-Host 'Wklej fine-grained token relay (wartość nie będzie wyświetlona)' -AsSecureString
        $pointer = [IntPtr]::Zero
        try {
            $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
            $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
            if ($password.Length -gt 2048 -or $password -cnotmatch '^github_pat_[A-Za-z0-9_]+$') { throw 'invalid-relay-token-format' }
            Store-Credential $relayHost $relayUser $password
            'Relay credential slot is occupied after storage; value and GitHub permissions remain unverified.'
        } finally {
            if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
            if ($null -ne $secure) { $secure.Dispose() }
            Remove-Variable -Name password -ErrorAction SilentlyContinue
        }
    }
} catch {
    # Do not display exception text: native tools or unexpected errors could
    # contain sensitive process input. A failed store may have taken effect.
    [Console]::Error.WriteLine('Vault operation failed or could not be confirmed; no automatic retry.')
    exit 1
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
