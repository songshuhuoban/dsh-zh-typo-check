#Requires -Version 5.1
<# Offline recovery through DSH's official CLI. No app files, locks or models are removed. #>
[CmdletBinding()]
param(
    [string]$ProfileDirectory = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh/profiles/desktop'),
    [string]$DshCli = 'D:\deepseek-harness\resources\runtime\cli\bin\dsh.cmd',
    [ValidatePattern('^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$')][string]$Version = '0.3.3',
    [switch]$PlanOnly
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-DesktopStopped {
    if ($profileName -ne 'desktop') { return }
    $running = @(Get-CimInstance Win32_Process -Filter "Name = 'DeepSeek Harness.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--(?:type[= ]|expose-internals)' })
    if ($running.Count -gt 0) {
        throw 'Save drafts and fully quit DeepSeek Harness, including its tray process, before offline recovery.'
    }
}
function Model-Hashes {
    $answer = @{}
    $directory = Join-Path $resolvedProfile 'models/zh-typo-check'
    if (Test-Path -LiteralPath $directory) {
        Get-ChildItem -LiteralPath $directory -File -Recurse | ForEach-Object {
            $answer[$_.FullName] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
        }
    }
    return $answer
}

$resolvedProfile = (Resolve-Path -LiteralPath $ProfileDirectory).ProviderPath
$profilesDirectory = Split-Path -Parent $resolvedProfile
$profileName = Split-Path -Leaf $resolvedProfile
if ((Split-Path -Leaf $profilesDirectory) -ne 'profiles' -or $profileName -notmatch '^[A-Za-z0-9_-]+$') {
    throw 'Expected an existing DSH home/profiles/<name> directory.'
}
$profileHome = Split-Path -Parent $profilesDirectory
$packagePath = Join-Path $resolvedProfile 'package.json'
$manifest = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $manifest.dsh -or -not $manifest.dsh.profile) { throw 'Not a DSH profile manifest.' }
if (-not (Test-Path -LiteralPath $DshCli -PathType Leaf)) { throw 'DSH CLI not found. Supply -DshCli with its dsh.cmd path.' }
$spec = "dsh-zh-typo-check@$Version"
if ($PlanOnly) {
    [pscustomobject]@{ Profile = $resolvedProfile; Package = $spec; Registry = 'https://registry.npmjs.org';
        Actions = @('require desktop stopped', 'backup profile configuration', 'official CLI add --save-exact', 'enable bundle', 'verify settings and model hashes') } | ConvertTo-Json -Depth 8
    return
}
Assert-DesktopStopped
$backup = Join-Path $resolvedProfile ('.plugin-manager/repair-backups/' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $backup -Force | Out-Null
foreach ($name in @('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml')) {
    $source = Join-Path $resolvedProfile $name
    if (Test-Path -LiteralPath $source -PathType Leaf) { Copy-Item -LiteralPath $source -Destination (Join-Path $backup $name) }
}
$patchPath = Join-Path $resolvedProfile 'cordis.patch.yml'
$patchHash = if (Test-Path -LiteralPath $patchPath) { (Get-FileHash -LiteralPath $patchPath -Algorithm SHA256).Hash } else { $null }
$modelHashes = Model-Hashes
$previousDshHome = $env:DSH_HOME
try {
    $env:DSH_HOME = $profileHome
    & $DshCli plugin --profile $profileName add $spec --save-exact --registry=https://registry.npmjs.org
    if ($LASTEXITCODE -ne 0) { throw "DSH CLI installation failed (exit $LASTEXITCODE). Backup: $backup" }
} finally {
    if ($null -eq $previousDshHome) { Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue }
    else { $env:DSH_HOME = $previousDshHome }
}

$installedPath = Join-Path $resolvedProfile 'node_modules/dsh-zh-typo-check/package.json'
$installed = Get-Content -LiteralPath $installedPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($installed.name -ne 'dsh-zh-typo-check' -or $installed.version -ne $Version) { throw 'Installed package verification failed.' }
Assert-DesktopStopped
$manifest = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.dependencies.'dsh-zh-typo-check' -ne $Version) { throw 'Exact dependency version was not saved.' }
$bundles = @($manifest.dsh.profile.bundles)
if ($bundles -notcontains 'dsh-zh-typo-check') {
    $manifest.dsh.profile.bundles = @($bundles) + @('dsh-zh-typo-check')
    $tempPath = $packagePath + '.repair-' + [Guid]::NewGuid().ToString('N')
    [System.IO.File]::WriteAllText($tempPath, ($manifest | ConvertTo-Json -Depth 100) + "`n", (New-Object System.Text.UTF8Encoding($false)))
    [System.IO.File]::Replace($tempPath, $packagePath, (Join-Path $backup 'package-before-enable.json'))
}
$afterPatchHash = if (Test-Path -LiteralPath $patchPath) { (Get-FileHash -LiteralPath $patchPath -Algorithm SHA256).Hash } else { $null }
if ($patchHash -ne $afterPatchHash) { throw "Profile settings changed unexpectedly. Inspect backup: $backup" }
$afterModels = Model-Hashes
if ($modelHashes.Count -ne $afterModels.Count) { throw 'Model file count changed unexpectedly.' }
foreach ($file in $modelHashes.Keys) {
    if ($modelHashes[$file] -ne $afterModels[$file]) { throw 'Model content changed unexpectedly.' }
}
$receipt = [pscustomobject]@{ Version = $Version; Profile = $resolvedProfile; Enabled = $true;
    SettingsUnchanged = $true; ModelFilesPreserved = $modelHashes.Count; Backup = $backup;
    AtUtc = [DateTime]::UtcNow.ToString('o') }
$receiptJson = $receipt | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText((Join-Path $backup 'receipt.json'), $receiptJson, (New-Object System.Text.UTF8Encoding($false)))
$receiptJson
Write-Output 'Recovery completed. Start DSH normally; downloaded models and settings are preserved.'
