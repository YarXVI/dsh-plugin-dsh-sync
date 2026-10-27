# DSH 设备同步插件 · 一键安装（不需要 git）
#
# 用法（PowerShell 7 或 5.1）：
#   irm https://yarxvi.github.io/dsh-plugin-dsh-sync/bootstrap.ps1 | iex
#
# 可选环境变量：
#   $env:DSH_PROFILE = 'desktop'          # 目标 profile（默认 desktop）
#   $env:DshHome     = 'C:\Users\me\.dsh' # 自定义 DSH_HOME（默认 ~/.dsh）
#   $env:DSH_SYNC_DRYRUN = '1'            # 只看会写哪些文件，不落盘
#
# 做的事：拉取最新 Release 的 zip → 解压到临时目录 → 调插件自带的 install.ps1。
# 不删除任何 DSH 数据；install.ps1 会在改动 profile/package.json 前留 .bak-sync-install-* 备份。
$ErrorActionPreference = 'Stop'
$repo = 'YarXVI/dsh-plugin-dsh-sync'
$profile = if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'desktop' }

Write-Host "[bootstrap] 查询最新发布 …" -ForegroundColor Cyan
$headers = @{ 'User-Agent' = 'dsh-sync-bootstrap'; Accept = 'application/vnd.github+json' }
$rel = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers $headers -TimeoutSec 60
$asset = $rel.assets | Where-Object { $_.name -like '*.zip' } | Select-Object -First 1
if (-not $asset) { throw "Release '$($rel.tag_name)' 里没有 zip 资产" }
Write-Host "[bootstrap] 版本 $($rel.tag_name) · $($asset.name) · $([math]::Round($asset.size/1KB)) KB"

$tag = $rel.tag_name
$zip = Join-Path $env:TEMP "dsh-sync-$tag.zip"
$dir = Join-Path $env:TEMP "dsh-sync-$tag"
if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }   # 只清自己的临时目录
New-Item -ItemType Directory -Force -Path $dir | Out-Null

Write-Host "[bootstrap] 下载 …"
Invoke-WebRequest $asset.browser_download_url -OutFile $zip -TimeoutSec 300
Write-Host "[bootstrap] 解压到 $dir"
Expand-Archive -Path $zip -DestinationPath $dir -Force

$installer = Get-ChildItem $dir -Recurse -Filter install.ps1 | Select-Object -First 1
if (-not $installer) { throw '压缩包里没有 install.ps1，下载可能不完整' }
Write-Host "[bootstrap] 运行 $($installer.FullName)"
$splat = @{ Profile = $profile }
if ($env:DshHome) { $splat.DshHome = $env:DshHome }
if ($env:DSH_SYNC_DRYRUN -eq '1') {
  Write-Host "[bootstrap] DRYRUN：只打印，不落盘" -ForegroundColor Yellow
  & $installer.FullName @splat -WhatIf
} else {
  & $installer.FullName @splat
}

Write-Host ''
Write-Host "[bootstrap] 完成。请重启 DeepSeek Harness，然后看左侧栏是否出现「设备同步」。" -ForegroundColor Green
Write-Host "[bootstrap] 卸载：删掉 profiles\$profile\plugins\dsh-plugin-dsh-sync，并从 package.json 的 dependencies / dsh.profile.bundles 去掉同名条目。" -ForegroundColor DarkGray
