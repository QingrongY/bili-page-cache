$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'extension/manifest.json') | ConvertFrom-Json
$package = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'package.json') | ConvertFrom-Json
if ($manifest.version -ne $package.version) { throw 'Package and manifest versions differ' }
$releaseDir = Join-Path $projectRoot 'dist'
New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
$archivePath = Join-Path $releaseDir ("BiliCache-" + $manifest.version + ".zip")
$releaseFiles = @('extension', 'docs', 'README.md', 'LICENSE') | ForEach-Object { Join-Path $projectRoot $_ }
Compress-Archive -LiteralPath $releaseFiles -DestinationPath $archivePath -Force
$storePath = Join-Path $releaseDir ("BiliCache-" + $manifest.version + "-store.zip")
Compress-Archive -Path (Join-Path $projectRoot 'extension/*') -DestinationPath $storePath -Force
Compress-Archive -LiteralPath (Join-Path $projectRoot 'LICENSE') -DestinationPath $storePath -Update
$materialsPath = Join-Path $releaseDir ("BiliCache-" + $manifest.version + "-store-assets.zip")
Compress-Archive -Path (Join-Path $projectRoot 'store/*') -DestinationPath $materialsPath -Force
Compress-Archive -LiteralPath (Join-Path $projectRoot 'LICENSE') -DestinationPath $materialsPath -Update
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($storePath)
try {
  if (-not ($zip.Entries | Where-Object FullName -EQ 'manifest.json')) { throw 'Store archive needs manifest.json at its root' }
  if ($zip.Entries | Where-Object { $_.FullName -match '(^|/)(node_modules|tests|test-results|\.env)' }) { throw 'Unexpected file in store archive' }
} finally { $zip.Dispose() }
$checksums = @($archivePath, $storePath, $materialsPath) | ForEach-Object {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $hash = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($_))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
  $hash + '  ' + (Split-Path -Leaf $_)
}
[IO.File]::WriteAllLines((Join-Path $releaseDir 'SHA256SUMS.txt'), $checksums, [Text.UTF8Encoding]::new($false))
