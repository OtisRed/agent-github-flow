param(
  [Parameter(Mandatory=$true)][string]$RepositoryPath,
  [Parameter(Mandatory=$true)][string]$Commit,
  [Parameter(Mandatory=$true)][string]$Destination
)
$ErrorActionPreference = 'Stop'
if ($Commit -cnotmatch '^[a-f0-9]{40}$') { throw 'Zadaj pelny 40-znakowy SHA commita.' }
$Destination = [System.IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $Destination) { throw 'Katalog docelowy juz istnieje; wybierz nowy.' }
$verified = git -C $RepositoryPath rev-parse --verify "$Commit^{commit}"
if ($LASTEXITCODE -ne 0 -or $verified.Trim() -cne $Commit) { throw 'Commit nie zostal znaleziony w repozytorium.' }
New-Item -ItemType Directory -Path $Destination | Out-Null
$archive = Join-Path $Destination 'chef-source.tar'
git -C $RepositoryPath archive --format=tar --output=$archive $Commit
if ($LASTEXITCODE -ne 0) { throw 'Nie mozna utworzyc snapshotu.' }
tar -xf $archive -C $Destination
if ($LASTEXITCODE -ne 0) { throw 'Nie mozna rozpakowac snapshotu.' }
Remove-Item -LiteralPath $archive
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'chef-test.mjs') -Destination $Destination
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'build-chef-test-manifest.mjs') -Destination $Destination
Push-Location $Destination
try {
  node build-chef-test-manifest.mjs $Commit
  if ($LASTEXITCODE -ne 0) { throw 'Nie mozna utworzyc manifestu.' }
  npm ci --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'Nie mozna zainstalowac zaleznosci.' }
} finally { Pop-Location }
$marketplace = Join-Path $Destination 'marketplace'
$registry = Join-Path $marketplace '.agents/plugins'
$plugin = Join-Path $marketplace 'plugins/chef-test'
New-Item -ItemType Directory -Path $registry, (Join-Path $plugin '.codex-plugin') -Force | Out-Null
$utf8 = [System.Text.UTF8Encoding]::new($false)
function Write-JsonFile($Path, $Value) { [System.IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 12), $utf8) }
$runtime = @{command=(Get-Command node).Source; args=@('--experimental-sqlite',(Join-Path $Destination 'chef-test.mjs')); cwd=$Destination}
Write-JsonFile (Join-Path $registry 'marketplace.json') @{name='agf-local-chef-test'; interface=@{displayName='AGF Chef Test Local'}; plugins=@(@{name='chef-test';source=@{source='local';path='./plugins/chef-test'};policy=@{installation='AVAILABLE';authentication='ON_INSTALL'};category='Developer Tools'})}
Write-JsonFile (Join-Path $plugin '.codex-plugin/plugin.json') @{name='chef-test';version='0.1.0';description='Chef-test na danych fikcyjnych';mcpServers='./.mcp.json';author=@{name='Local pilot'}}
Write-JsonFile (Join-Path $plugin '.mcp.json') @{mcpServers=@{'chef-test'=$runtime}}
# This local Codex build prefers a root plugin.json over the compatibility
# manifest and then fails to discover the MCP server. Generate the verified
# Codex package only; do not claim this is a portable ChatGPT package.
Write-Output "Chef-test snapshot: $Commit"
Write-Output "Lokalny marketplace: $marketplace"
Write-Output 'Nastepny krok: podlacz lokalna wtyczke i sprawdz chef_test_srodowisko.'
