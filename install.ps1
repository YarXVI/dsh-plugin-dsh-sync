param(
  [string]$Profile = "",
  [string]$DshHome = ""
)

$ErrorActionPreference = "Stop"

if (-not $Profile) {
  if ($env:DSH_PROFILE) { $Profile = $env:DSH_PROFILE } else { $Profile = "desktop" }
}
if (-not $DshHome) {
  if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME } else { $DshHome = Join-Path $HOME ".dsh" }
}

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Join-Path $root "dsh-plugin-dsh-sync"
if (-not (Test-Path $source)) { throw "Plugin folder not found next to this script: $source" }

$profileDir = Join-Path $DshHome "profiles\$Profile"
if (-not (Test-Path $profileDir)) {
  throw "DSH profile not found: $profileDir. Start DeepSeek Harness once with profile '$Profile', then run this script again."
}

$target = Join-Path $profileDir "plugins\dsh-plugin-dsh-sync"
New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
if (Test-Path $target) { Remove-Item -Recurse -Force $target }
Copy-Item $source $target -Recurse

$packageJson = Join-Path $profileDir "package.json"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
Copy-Item $packageJson "$packageJson.bak-sync-install-$stamp"
$json = Get-Content $packageJson -Raw | ConvertFrom-Json

$deps = [ordered]@{}
if ($json.PSObject.Properties.Name -contains "dependencies" -and $json.dependencies) {
  foreach ($prop in $json.dependencies.PSObject.Properties) { $deps[$prop.Name] = $prop.Value }
}
$deps["dsh-plugin-dsh-sync"] = "link:./plugins/dsh-plugin-dsh-sync"
$json | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]$deps) -Force

if (-not ($json.PSObject.Properties.Name -contains "dsh") -or -not $json.dsh) {
  $json | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force
}
if (-not ($json.dsh.PSObject.Properties.Name -contains "profile") -or -not $json.dsh.profile) {
  $json.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force
}
$bundles = @()
if ($json.dsh.profile.PSObject.Properties.Name -contains "bundles" -and $json.dsh.profile.bundles) {
  $bundles = @($json.dsh.profile.bundles)
}
if ($bundles -notcontains "dsh-plugin-dsh-sync") { $bundles += "dsh-plugin-dsh-sync" }
$json.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force

# Write UTF-8 *without* a BOM. Windows PowerShell 5.1's
# `Set-Content -Encoding utf8` always prepends one, and DSH reads this file with
# JSON.parse, which then dies on "Unexpected token '﻿'". .NET lets us choose the
# encoder explicitly and works on both 5.1 and 7+.
$serialized = ($json | ConvertTo-Json -Depth 20)
[IO.File]::WriteAllText($packageJson, $serialized + "`r`n", (New-Object Text.UTF8Encoding($false)))

$link = Join-Path $profileDir "node_modules\dsh-plugin-dsh-sync"
New-Item -ItemType Directory -Force (Split-Path $link) | Out-Null
if (Test-Path $link) { Remove-Item -Recurse -Force $link }
New-Item -ItemType Junction -Path $link -Target $target | Out-Null

Write-Host ""
Write-Host "Installed dsh-plugin-dsh-sync"
Write-Host "  profile : $profileDir"
Write-Host "  plugin  : $target"
Write-Host "  backup  : package.json.bak-sync-install-$stamp"
Write-Host ""
Write-Host "Next: restart DeepSeek Harness, open 'Device Sync' in the left sidebar,"
Write-Host "      click Pair on both computers, compare the 6-digit code, then confirm."
