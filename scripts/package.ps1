$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$pkg = Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json
$version = $pkg.version
$dist = Join-Path $root "dist"
if (Test-Path $dist) { Remove-Item -Recurse -Force $dist }

$stage = Join-Path $dist "stage"
$plugin = Join-Path $stage "dsh-plugin-dsh-sync"
New-Item -ItemType Directory -Force $plugin | Out-Null

$files = @("package.json", "index.js", "client.js", "cordis.patch.yml", "icon.svg", "README.md", "DESIGN.md", "CHANGELOG.md")
foreach ($file in $files) { Copy-Item (Join-Path $root $file) (Join-Path $plugin $file) -Force }
# "shadow" is the merged Shadow Workspace host tree (index.js, src\, locale\).
foreach ($dir in @("src", "shadow", "locale")) {
  Copy-Item (Join-Path $root $dir) (Join-Path $plugin $dir) -Recurse -Force
}
# Ship top-level docs only (chat screenshot); docs\mock holds design previews
# that must not bloat the installable package.
$docs = Join-Path $root "docs"
if (Test-Path $docs) {
  $docsTarget = Join-Path $plugin "docs"
  New-Item -ItemType Directory -Force $docsTarget | Out-Null
  Get-ChildItem $docs -File | ForEach-Object { Copy-Item $_.FullName $docsTarget -Force }
}

# The merged plugin is unusable without the shadow host tree: fail the build
# instead of shipping a zip that silently lost it.
$required = @(
  "shadow\index.js",
  "shadow\src\constants.js",
  "shadow\src\panel-route.js",
  "shadow\src\session-bridge.js",
  "shadow\src\b-proxy.js",
  "shadow\src\local-route.js",
  # 0.10.25: voice input is served by this B-local speech bridge.
  "shadow\src\speech.js",
  "shadow\locale\zh.json",
  "shadow\locale\en.json"
)
foreach ($rel in $required) {
  if (-not (Test-Path (Join-Path $plugin $rel))) { throw "Plugin package incomplete, missing: $rel" }
}

Copy-Item (Join-Path $root "packaging\install.ps1") $stage -Force
Copy-Item (Join-Path $root "packaging\install.cmd") $stage -Force
Copy-Item (Join-Path $root "packaging\安装说明.md") $stage -Force

$zip = Join-Path $dist "dsh-plugin-dsh-sync-$version.zip"
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -CompressionLevel Optimal

$tgzRoot = Join-Path $dist "tgz"
$tgzPkg = Join-Path $tgzRoot "package"
New-Item -ItemType Directory -Force $tgzPkg | Out-Null
Copy-Item (Join-Path $plugin "*") $tgzPkg -Recurse -Force
$tgz = Join-Path $dist "dsh-plugin-dsh-sync-$version.tgz"
& tar -czf $tgz -C $tgzRoot package
if ($LASTEXITCODE -ne 0) { throw "tar failed" }

Write-Host ""
Write-Host "Packaged $version"
foreach ($artifact in @($zip, $tgz)) {
  $item = Get-Item $artifact
  $hash = (Get-FileHash $artifact -Algorithm SHA256).Hash
  Write-Host ("  {0}  {1:N0} bytes" -f $item.Name, $item.Length)
  Write-Host ("    sha256 {0}" -f $hash)
}
Write-Host ""
Write-Host "Zip layout:"
Get-ChildItem $stage | ForEach-Object { Write-Host ("  " + $_.Name) }
