param([string]$LabRoot = 'C:\Users\conte\CodexLabs\testne-audit')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'LabSafety.ps1')
$resolvedLab = [IO.Path]::GetFullPath($LabRoot).TrimEnd('\')
if ($resolvedLab -ne 'C:\Users\conte\CodexLabs\testne-audit') { throw 'Unexpected lab root' }
Assert-LabBudget -LiteralPath $resolvedLab
$run = Join-Path $resolvedLab ('session-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$null = New-Item -ItemType Directory -Path $run
$project = Join-Path $PSScriptRoot 'SessionHarness.csproj'
$output = Join-Path $run 'bin'
Assert-NoReparseAncestor -LiteralPath $run
& dotnet build $project -c Release --nologo --disable-build-servers -p:BaseIntermediateOutputPath="$run\obj\" -p:OutputPath="$output\" -p:RestoreSources= -p:NuGetAudit=false -p:UseSharedCompilation=false
if ($LASTEXITCODE -ne 0) { throw 'Session fixture build failed' }
Assert-LabBudget -LiteralPath $resolvedLab -ReserveBytes 10MB
$buildBytes = (@(Get-GuardedLabFiles -LiteralPath $run) | Measure-Object Length -Sum).Sum
if ($buildBytes -gt 90MB) { throw 'Fixture intermediates exceeded the bounded build budget' }
$executable = Join-Path $output 'SessionHarness.exe'
Copy-Item -LiteralPath $executable -Destination (Join-Path $output 'UnapprovedFixture.exe')
$result = & $executable
if ($LASTEXITCODE -ne 0) { throw 'Session fixture failed' }
$evidence = $result | ConvertFrom-Json
if (@($evidence.tests).Count -ne 8 -or @($evidence.tests | Where-Object result -ne pass).Count) { throw 'Incomplete session evidence' }
# Only harness-created lab files are inventoried; no original sample, game, or launcher data is changed.
Assert-LabBudget -LiteralPath $resolvedLab -ReserveBytes 1MB
$evidence | Add-Member -NotePropertyName sourceHashes -NotePropertyValue @(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'Program.cs'), (Join-Path $PSScriptRoot 'LabSafety.ps1'), $project, $PSCommandPath -Algorithm SHA256 | Select-Object Path, Hash)
$evidence | Add-Member -NotePropertyName artifactHashes -NotePropertyValue @(Get-FileHash -LiteralPath $executable, (Join-Path $output 'SessionHarness.dll'), (Join-Path $output 'UnapprovedFixture.exe') -Algorithm SHA256 | Select-Object Path, Hash)
$evidence | Add-Member -NotePropertyName ownedFiles -NotePropertyValue (@(Get-GuardedLabFiles -LiteralPath $run | ForEach-Object { [IO.Path]::GetRelativePath($run, $_.FullName) }) + 'evidence.json')
$evidencePath = Join-Path $run 'evidence.json'
Assert-NoReparseAncestor -LiteralPath $run
$json = $evidence | ConvertTo-Json -Depth 8
if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 1MB) { throw 'Evidence exceeded its 1 MiB reserve' }
$file = [IO.File]::Open($evidencePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try {
    $writer = [IO.StreamWriter]::new($file, [Text.UTF8Encoding]::new($false))
    try { $writer.Write($json); $writer.Flush(); $file.Flush($true) }
    finally { $writer.Dispose() }
}
finally { $file.Dispose() }
$evidence.tests | Format-Table scenario, result, pid, rootPid, inJob, reason, elapsedMs
Write-Output "Evidence: $evidencePath"
