# These read-only guards never follow a reparse point, including one above the lab root.
function Assert-NoReparseAncestor {
    param([Parameter(Mandatory)][string]$LiteralPath)
    $absolute = [IO.Path]::GetFullPath($LiteralPath)
    $volume = [IO.Path]::GetPathRoot($absolute)
    if ($volume -notmatch '^[A-Za-z]:\\$') { throw 'Lab paths must use a local drive' }
    $candidate = $volume
    $parts = $absolute.Substring($volume.Length).Split('\', [StringSplitOptions]::RemoveEmptyEntries)
    foreach ($part in @('') + $parts) {
        if ($part) { $candidate = Join-Path $candidate $part }
        try { $item = Get-Item -LiteralPath $candidate -Force -ErrorAction Stop }
        catch [System.Management.Automation.ItemNotFoundException] { break }
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Reparse point rejected before traversal: $candidate"
        }
        if (-not $item.PSIsContainer) { throw "Expected directory ancestor: $candidate" }
    }
}

function Get-GuardedLabFiles {
    param([Parameter(Mandatory)][string]$LiteralPath)
    Assert-NoReparseAncestor -LiteralPath $LiteralPath
    if (-not (Test-Path -LiteralPath $LiteralPath)) { return }
    $pending = [Collections.Generic.Queue[string]]::new()
    $pending.Enqueue([IO.Path]::GetFullPath($LiteralPath))
    while ($pending.Count) {
        $directory = $pending.Dequeue()
        # Recheck immediately before each one-level enumeration; never recurse through links.
        Assert-NoReparseAncestor -LiteralPath $directory
        foreach ($entry in Get-ChildItem -LiteralPath $directory -Force) {
            if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Reparse point rejected in lab tree: $($entry.FullName)"
            }
            if ($entry.PSIsContainer) { $pending.Enqueue($entry.FullName) }
            else { $entry }
        }
    }
}

function Assert-LabBudget {
    param([Parameter(Mandatory)][string]$LiteralPath, [long]$ReserveBytes = 100MB)
    $files = @(Get-GuardedLabFiles -LiteralPath $LiteralPath)
    $bytes = ($files | Measure-Object Length -Sum).Sum
    if ($bytes -gt 5GB - $ReserveBytes) { throw 'Lab size would exceed 5 GiB' }
    if ((Get-PSDrive C).Free -lt 10GB + $ReserveBytes) { throw 'C: must retain 10 GiB after the run reserve' }
}
