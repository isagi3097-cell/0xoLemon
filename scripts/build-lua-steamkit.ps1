[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression.FileSystem
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$projectRoot = Join-Path $repositoryRoot 'src-tauri\lua-steamkit'
$resourceRoot = Join-Path $repositoryRoot 'src-tauri\resources\lua-steamkit'
$steamKitCommit = '1c7bc9c41a529e8fbb1e6890f1e4dbcdc5200cb7'
$entryPoint = '0xoLemon.LuaSteamKit.exe'

function Assert-RegularBoundary([string] $Path) {
    $candidate = [IO.Path]::GetFullPath($Path)
    if (-not $candidate.StartsWith($repositoryRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Build path escaped repository.' }
    while ($candidate -and $candidate.Length -ge $repositoryRoot.Length) {
        if (Test-Path -LiteralPath $candidate) {
            $item = Get-Item -LiteralPath $candidate -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point in build path.' }
        }
        $candidate = [IO.Path]::GetDirectoryName($candidate)
    }
}

function Hash([string] $Path) {
    # The Tauri/npm child environment may omit PowerShell module discovery.
    # Hash through the framework so build verification is independent of it.
    $stream = [IO.File]::OpenRead($Path)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose(); $stream.Dispose() }
}
function Invoke-PinnedDotnet([string[]] $Arguments) {
    & dotnet @Arguments
    if ($LASTEXITCODE -ne 0) { throw "dotnet operation failed with exit $LASTEXITCODE" }
}

Assert-RegularBoundary $projectRoot
Assert-RegularBoundary $resourceRoot
$publishRoot = Join-Path $projectRoot ('artifacts\publish-' + [Guid]::NewGuid().ToString('N'))
Assert-RegularBoundary $publishRoot
New-Item -ItemType Directory -Path $publishRoot -Force | Out-Null
Push-Location $projectRoot
try {
    $sdk = (& dotnet --version).Trim()
    if ($sdk -ne '8.0.420') { throw 'Pinned .NET SDK 8.0.420 is required.' }
    Invoke-PinnedDotnet -Arguments @('restore','LuaSteamKit.csproj','--runtime','win-x64','--locked-mode','--configfile','NuGet.Config')
    Invoke-PinnedDotnet -Arguments @('publish','LuaSteamKit.csproj','--configuration','Release','--runtime','win-x64','--self-contained','true','--no-restore','--output',$publishRoot)
    if (@(Get-ChildItem -LiteralPath $publishRoot -Directory).Count -ne 0) { throw 'Unexpected nested publish output requires review.' }

    $assets = Get-Content -LiteralPath (Join-Path $projectRoot 'obj\project.assets.json') -Raw | ConvertFrom-Json
    $packageRoot = @($assets.packageFolders.PSObject.Properties.Name)[0]
    $lock = Get-Content -LiteralPath (Join-Path $projectRoot 'packages.lock.json') -Raw | ConvertFrom-Json
    $dependencyEvidence = @()
    foreach ($dependency in $lock.dependencies.'net8.0'.PSObject.Properties) {
        $id = $dependency.Name.ToLowerInvariant()
        $version = $dependency.Value.resolved
        $packageDir = Join-Path $packageRoot "$id\$version"
        $archivePath = Join-Path $packageDir "$id.$version.nupkg"
        Invoke-PinnedDotnet -Arguments @('nuget','verify',$archivePath,'--all','--verbosity','quiet')
        $metadata = Get-Content -LiteralPath (Join-Path $packageDir '.nupkg.metadata') -Raw | ConvertFrom-Json
        if ($metadata.contentHash -ne $dependency.Value.contentHash) { throw 'NuGet lock/content identity mismatch.' }
        $target = $assets.targets.'net8.0/win-x64'.PSObject.Properties | Where-Object Name -eq "$($dependency.Name)/$version" | Select-Object -First 1
        if (-not $target) { throw 'Resolved dependency target missing.' }
        $archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
        try {
            foreach ($runtimeFile in $target.Value.runtime.PSObject.Properties.Name) {
                if (-not $runtimeFile.EndsWith('.dll', [StringComparison]::OrdinalIgnoreCase)) { continue }
                $entry = $archive.GetEntry($runtimeFile)
                if (-not $entry) { throw 'Runtime assembly missing from signed package.' }
                $stream = $entry.Open()
                $hasher = [Security.Cryptography.SHA256]::Create()
                try { $hashBytes = $hasher.ComputeHash($stream); $expected = [BitConverter]::ToString($hashBytes).Replace('-','').ToLowerInvariant() } finally { $stream.Dispose(); $hasher.Dispose() }
                $published = Join-Path $publishRoot ([IO.Path]::GetFileName($runtimeFile))
                if ((Hash $published) -ne $expected) { throw 'Published runtime assembly differs from signed NuGet package.' }
            }
        } finally { $archive.Dispose() }
        $dependencyEvidence += [ordered]@{ id=$dependency.Name; version=$version; nugetContentHash=$dependency.Value.contentHash; archiveSha256=(Hash $archivePath); signatureVerified=$true }
    }
    $runtimeDir = Join-Path $packageRoot 'microsoft.netcore.app.runtime.win-x64\8.0.27'
    $runtimeArchive = Join-Path $runtimeDir 'microsoft.netcore.app.runtime.win-x64.8.0.27.nupkg'
    Invoke-PinnedDotnet -Arguments @('nuget','verify',$runtimeArchive,'--all','--verbosity','quiet')
    $dependencyEvidence += [ordered]@{id='Microsoft.NETCore.App.Runtime.win-x64';version='8.0.27';archiveSha256=(Hash $runtimeArchive);signatureVerified=$true}

    $copies = @{
        'README.txt'=(Join-Path $projectRoot 'README.md')
        'packages.lock.json'=(Join-Path $projectRoot 'packages.lock.json')
        'LICENSE-LGPL-2.1.txt'=(Join-Path $projectRoot 'licenses\LGPL-2.1.txt')
        'LICENSE-Apache-2.0.txt'=(Join-Path $projectRoot 'licenses\Apache-2.0.txt')
        'NOTICE-protobuf-net.txt'=(Join-Path $projectRoot 'licenses\protobuf-net.txt')
        'LICENSE-ZstdSharp.txt'=(Join-Path $projectRoot 'licenses\ZstdSharp.txt')
        'NOTICE-SteamKit2.txt'=(Join-Path $packageRoot 'steamkit2\3.4.0\license.txt')
        'LICENSE-dotnet-runtime.txt'=(Join-Path $runtimeDir 'LICENSE.TXT')
        'THIRD-PARTY-NOTICES-dotnet-runtime.txt'=(Join-Path $runtimeDir 'THIRD-PARTY-NOTICES.TXT')
        'THIRD-PARTY-NOTICES-System.IO.Hashing.txt'=(Join-Path $packageRoot 'system.io.hashing\10.0.1\THIRD-PARTY-NOTICES.TXT')
    }
    foreach ($copy in $copies.GetEnumerator()) { Copy-Item -LiteralPath $copy.Value -Destination (Join-Path $publishRoot $copy.Key) }

    # Corresponding upstream source is a commit-addressed canonical archive, never sample output.
    $sourceArchiveName = "SteamKit2-source-$steamKitCommit.zip"
    $sourceArchivePath = Join-Path $publishRoot $sourceArchiveName
    Invoke-WebRequest -Uri "https://codeload.github.com/SteamRE/SteamKit/zip/$steamKitCommit" -OutFile $sourceArchivePath -TimeoutSec 60
    $sourceFiles = @('Program.cs','Protocol.cs','PicsClient.cs','WorkshopClient.cs','WorkshopProtocol.cs','LuaSteamKit.csproj','global.json','NuGet.Config','packages.lock.json','README.md')
    $sourceEvidence = @($sourceFiles | ForEach-Object { [ordered]@{path=$_;sha256=(Hash (Join-Path $projectRoot $_))} })
    $sourceInputs = @($sourceFiles | ForEach-Object { Join-Path $projectRoot $_ })
    $sourceInputs += Join-Path $PSScriptRoot 'build-lua-steamkit.ps1'
    $sourceInputs += @(Get-ChildItem -LiteralPath (Join-Path $projectRoot 'licenses') -File | Select-Object -ExpandProperty FullName)
    $sourceInputs += @(Get-ChildItem -LiteralPath (Join-Path $projectRoot 'tests') -File | Select-Object -ExpandProperty FullName)
    # Preserve the repository layout: the supplied build script resolves both
    # project files and licenses relative to scripts/. Flattening this archive
    # would ship source that cannot be rebuilt using its accompanying script.
    $adapterArchive = [IO.Compression.ZipFile]::Open((Join-Path $publishRoot 'LuaSteamKit-adapter-source.zip'), [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($inputPath in ($sourceInputs | Sort-Object -Unique)) {
            Assert-RegularBoundary $inputPath
            $entryName = [IO.Path]::GetFullPath($inputPath).Substring($repositoryRoot.Length + 1).Replace('\', '/')
            [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($adapterArchive, $inputPath, $entryName, [IO.Compression.CompressionLevel]::Optimal)
        }
    } finally { $adapterArchive.Dispose() }

    $files = @(Get-ChildItem -LiteralPath $publishRoot -File | Sort-Object Name | ForEach-Object { [ordered]@{path=$_.Name;sha256=(Hash $_.FullName);size=$_.Length} })
    $manifest = [ordered]@{
        schemaVersion=1; entryPoint=$entryPoint
        source=[ordered]@{repo='https://github.com/SteamRE/SteamKit';commit=$steamKitCommit;packageVersion='3.4.0';patches=@();upstreamArchive=$sourceArchiveName;upstreamArchiveSha256=(Hash $sourceArchivePath)}
        build=[ordered]@{sdk=$sdk;framework='net8.0';runtimeFrameworkVersion='8.0.27';rid='win-x64';selfContained=$true;singleFile=$false;createdAt=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()}
        bridgeSources=$sourceEvidence; dependencies=$dependencyEvidence
        licenseEvidence=@('LICENSE-LGPL-2.1.txt','NOTICE-SteamKit2.txt','LICENSE-Apache-2.0.txt','NOTICE-protobuf-net.txt','LICENSE-ZstdSharp.txt','LICENSE-dotnet-runtime.txt','THIRD-PARTY-NOTICES-dotnet-runtime.txt','THIRD-PARTY-NOTICES-System.IO.Hashing.txt')
        files=$files
    }
    $manifestPath = Join-Path $publishRoot 'artifact-manifest.json'
    [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))

    New-Item -ItemType Directory -Path $resourceRoot -Force | Out-Null
    $newNames = @($files | ForEach-Object { $_.path }) + 'artifact-manifest.json'

    # The resource directory is a regenerated build output, not a pinned input.
    # Any previous manifest describes a build from some other machine, so it is
    # not authoritative here. Files that are not part of the current build are
    # removed only when they are regular files inside this directory, and a
    # reparse-point guard keeps the cleanup from following links outside it.
    foreach ($existing in Get-ChildItem -LiteralPath $resourceRoot -Force) {
        Assert-RegularBoundary $existing.FullName
        if ($existing.PSIsContainer) { throw 'Unexpected subdirectory in Lua SteamKit resources requires manual review; nothing was deleted.' }
        if ($existing.Name -notin $newNames) { Remove-Item -LiteralPath $existing.FullName -Force }
    }

    foreach ($file in Get-ChildItem -LiteralPath $publishRoot -File) { Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $resourceRoot $file.Name) -Force }
    foreach ($file in $files) { if ((Hash (Join-Path $resourceRoot $file.path)) -ne $file.sha256) { throw 'Resource verification failed after publish.' } }
    Write-Host "Lua SteamKit packaged: $($files.Count) files; pinned SteamKit2 3.4.0; self-contained win-x64; regenerated resource directory."
} finally { Pop-Location }
