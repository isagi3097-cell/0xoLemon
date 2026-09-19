$ErrorActionPreference = 'Stop'

$root = Join-Path $PSScriptRoot '..\src-tauri\resources'
$requiredRoots = @(
  'cloud_redirect',
  'emu',
  'gse-uc',
  'lightning',
  'lua-steamkit',
  'managed-runtime',
  'redist',
  'steam_hooks',
  'tools'
)

$totalFiles = 0
$totalBytes = [int64]0
foreach ($name in $requiredRoots) {
  $path = Join-Path $root $name
  if (-not (Test-Path -LiteralPath $path -PathType Container)) {
    throw "Release resource root is missing after generation: $path"
  }

  $files = @(Get-ChildItem -LiteralPath $path -Recurse -File | Where-Object {
    $_.FullName -notmatch '\\gse_tools\\generate_emu_config\\(_OUTPUT|out\.log)(\\|$)'
  })
  if ($files.Count -eq 0) {
    throw "Release resource root is empty after generation: $path"
  }

  $bytes = [int64](($files | Measure-Object -Property Length -Sum).Sum)
  $totalFiles += $files.Count
  $totalBytes += $bytes
  Write-Host ("Release resources {0}: {1} files, {2:N0} bytes" -f $name, $files.Count, $bytes)
}

Write-Host ("Release resource payload validated: {0} files, {1:N0} bytes" -f $totalFiles, $totalBytes)