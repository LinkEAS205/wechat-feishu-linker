<#
.SYNOPSIS
  Install wechat-feishu-linker into a DeepSeek Harness desktop profile.

.DESCRIPTION
  Wires the plugin into <DSH_HOME>/profiles/<profile>:
    1. adds a `link:` dependency to the profile package.json
    2. appends the package to `dsh.profile.bundles`
    3. runs `pnpm install` in the profile directory
    4. prints the restart instruction

  Every mutated file is backed up with a timestamp suffix first.

  DSH loads a plugin by its realpath, and this plugin imports no
  `@deepseek-ai/*` packages, so no peer shims are needed.

  IMPORTANT: a running DSH picks the new bundle up on restart. Restarting
  ends any session hosted by the current process, so run this when you are
  ready to restart the app.

.PARAMETER DryRun
  Print the exact changes without writing anything.

.PARAMETER SkipInstall
  Write the manifest and stop - skip `pnpm install`. Use this to stage a
  profile, or to exercise the write path without invoking pnpm at all.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -DryRun
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1
#>
[CmdletBinding()]
param(
  [string]$PluginDir = '',
  [string]$ProfileDir = '',
  [string]$ProfileName = '',
  [switch]$DryRun,
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$PackageName = 'wechat-feishu-linker'

# Resolved in the body: Windows PowerShell 5.1 does not populate $PSScriptRoot
# while it is binding parameter defaults.
if (-not $PluginDir) {
  $scriptPath = $MyInvocation.MyCommand.Path
  if (-not $scriptPath) { $scriptPath = $PSCommandPath }
  if (-not $scriptPath) { throw 'cannot determine the script path - pass -PluginDir explicitly' }
  $PluginDir = Split-Path -Parent (Split-Path -Parent $scriptPath)
}
if (-not $ProfileDir) { $ProfileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop' }

function Write-Step($msg) { Write-Host "[install] $msg" }
function Write-Warn2($msg) { Write-Host "[warn]    $msg" -ForegroundColor Yellow }

# --- 1. sanity checks -------------------------------------------------------
$manifestPath = Join-Path $PluginDir 'package.json'
if (-not (Test-Path $manifestPath)) { throw "plugin package.json not found: $manifestPath" }
$pluginManifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
if ($pluginManifest.name -ne $PackageName) { throw "unexpected plugin name '$($pluginManifest.name)' in $manifestPath" }
$patchPath = Join-Path $PluginDir 'cordis.patch.yml'
if (-not (Test-Path $patchPath)) { throw "cordis.patch.yml not found: $patchPath" }
if (-not (Test-Path (Join-Path $PluginDir 'src\index.js'))) { throw "src\index.js not found in $PluginDir" }

if (-not $ProfileName) { $ProfileName = Split-Path -Leaf $ProfileDir }
$profileManifestPath = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path $profileManifestPath)) { throw "profile package.json not found: $profileManifestPath (is DSH installed for this user?)" }

Write-Step "plugin  : $PluginDir"
Write-Step "profile : $ProfileDir"

# --- 2. build the new profile manifest --------------------------------------
$profile = Get-Content $profileManifestPath -Raw | ConvertFrom-Json
$linkTarget = "link:$($PluginDir -replace '\\', '/')"

$deps = @{}
if ($profile.dependencies) { $profile.dependencies.PSObject.Properties | ForEach-Object { $deps[$_.Name] = $_.Value } }
$deps[$PackageName] = $linkTarget

$bundles = @()
if ($profile.dsh -and $profile.dsh.profile -and $profile.dsh.profile.bundles) { $bundles = @($profile.dsh.profile.bundles) }
if ($bundles -notcontains $PackageName) { $bundles += $PackageName }

$profile.dependencies = [pscustomobject]$deps
if (-not $profile.dsh) { $profile | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) }
$profile.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{ bundles = $bundles }) -Force

Write-Step "dependency : $PackageName = $linkTarget"
Write-Step "bundles    : $($bundles -join ', ')"

if ($DryRun) {
  Write-Host ''
  Write-Host '--- DRY RUN: nothing was written ---' -ForegroundColor Cyan
  Write-Host "would rewrite: $profileManifestPath"
  Write-Host 'would run    : pnpm install (in the profile directory)'
  exit 0
}

# --- 3. back up and write ---------------------------------------------------
# The manifest MUST be written as UTF-8 WITHOUT a BOM. Windows PowerShell 5.1's
# `Set-Content -Encoding UTF8` prepends EF BB BF, and DSH reads this file with
# `JSON.parse(readFileSync(path, 'utf8'))` (dsh-app-boot, `readProfileManifest`)
# - Node rejects a leading BOM, so the profile would fail to load on the next
# boot with `SyntaxError: Unexpected token`. `WriteAllText` with an explicit
# BOM-less encoding is the 5.1-safe spelling, and the trailing `\n` matches the
# host's own writer (`JSON.stringify(manifest, undefined, 2) + '\n'`).
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item $profileManifestPath "$profileManifestPath.bak-wechat-ilink-$stamp" -Force
Write-Step "backup     : $profileManifestPath.bak-wechat-ilink-$stamp"
$manifestJson = $profile | ConvertTo-Json -Depth 12
[System.IO.File]::WriteAllText($profileManifestPath, $manifestJson + "`n", (New-Object System.Text.UTF8Encoding($false)))
Write-Step "wrote      : $profileManifestPath (UTF-8, no BOM)"

# --- 4. pnpm install --------------------------------------------------------
if ($SkipInstall) {
  Write-Step 'pnpm install skipped (-SkipInstall)'
} elseif (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Write-Warn2 'pnpm not found on PATH - run "pnpm install" in the profile directory yourself.'
} else {
  Write-Step 'running pnpm install ...'
  Push-Location $ProfileDir
  try {
    & pnpm install
    if ($LASTEXITCODE -ne 0) { Write-Warn2 "pnpm install exited $LASTEXITCODE - check the output above." }
  } finally {
    Pop-Location
  }
}

Write-Host ''
Write-Host 'Done. Now:' -ForegroundColor Green
Write-Host '  1. restart DeepSeek Harness (the running process keeps the old bundle list)'
Write-Host "  2. run the QR login once:  node `"$PluginDir\scripts\login.mjs`""
Write-Host '  3. message the ClawBot from WeChat - the bridge answers in a DSH session'
Write-Host ''
Write-Host 'To undo: restore the .bak-wechat-ilink-* file and remove the bundle entry.'
