[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^https://gitlab\.com/.+/.+\.git$')]
    [string]$GitLabRemote,

    [string]$SourceRemote = 'https://github.com/isagi3097-cell/0xoLemon.git',
    [string]$Worktree = (Join-Path $PSScriptRoot '..\.gitlab-mirror-worktree')
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'Git is not installed or not available in PATH.'
}

$resolvedWorktree = [System.IO.Path]::GetFullPath($Worktree)
if (Test-Path $resolvedWorktree) {
    throw "Worktree already exists: $resolvedWorktree. Remove it only after verifying its contents."
}

Write-Host "Creating a mirror clone from $SourceRemote"
git clone --mirror $SourceRemote $resolvedWorktree
Push-Location $resolvedWorktree
try {
    git remote set-url --push origin $GitLabRemote
    Write-Host "Pushing all refs to $GitLabRemote"
    git push --mirror origin
    Write-Host 'GitLab mirror created successfully.'
    Write-Host 'This script does not alter the launcher updater endpoint or the working checkout.'
}
finally {
    Pop-Location
}
