$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'LabSafety.ps1')
$lab = 'C:\Users\conte\CodexLabs\testne-audit'
Assert-NoReparseAncestor -LiteralPath $lab
Assert-LabBudget -LiteralPath $lab
$checks = 2
# Read-only negative cases use existing Windows compatibility links, never create a link.
foreach ($link in @('C:\Users\All Users', 'C:\Documents and Settings')) {
    $item = Get-Item -LiteralPath $link -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) { throw 'Expected Windows compatibility reparse fixture' }
    foreach ($candidate in @($link, (Join-Path $link 'nonexistent-testne-child'))) {
        $rejected = $false
        try { Assert-NoReparseAncestor -LiteralPath $candidate }
        catch { if ($_.Exception.Message -like 'Reparse point rejected*') { $rejected = $true } else { throw } }
        if (-not $rejected) { throw 'Reparse ancestor was not rejected' }
        $checks++
    }
}
Write-Output "$checks/6 lab safety checks passed; no fixture paths created or deleted."
