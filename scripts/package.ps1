$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'extension/manifest.json') | ConvertFrom-Json
$releaseDir = Join-Path $projectRoot 'dist'
New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
$archivePath = Join-Path $releaseDir ("BiliCache-" + $manifest.version + ".zip")
$releaseFiles = @('extension', 'docs', 'README.md', 'LICENSE') | ForEach-Object { Join-Path $projectRoot $_ }
Compress-Archive -LiteralPath $releaseFiles -DestinationPath $archivePath -Force
Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath | Select-Object Path, Hash
