param(
    [string]$Source,
    [string]$DestinationDirectory,
    [string]$ExpectedSha256
)
$ErrorActionPreference = 'Stop'
if (-not $Source -and -not $DestinationDirectory -and -not $ExpectedSha256) {
    $root = Split-Path $PSScriptRoot -Parent
    . (Join-Path $PSScriptRoot 'portable-reports.ps1')
    $latest = Get-LatestPortableReport $root
    $Source = $latest.Executable
    $ExpectedSha256 = $latest.Report.executableSha256
    $DestinationDirectory = Join-Path $root '_testenv'
}
if (-not $Source -or -not $DestinationDirectory -or -not $ExpectedSha256) { throw 'Provide all deployment arguments or none to use the latest build.' }
# This helper never launches an application or touches runtime/data/temp.
$destinationName = 'KindleToZip-Portable.exe'
$directory = [IO.Path]::GetFullPath($DestinationDirectory)
if (-not (Test-Path -LiteralPath $directory -PathType Container)) { throw 'Deployment directory must already exist.' }
$ancestor = Get-Item -LiteralPath $directory -Force
while ($ancestor) {
    if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Deployment through a reparse point is refused.' }
    $ancestor = $ancestor.Parent
}
$destination = Join-Path $directory $destinationName
$temporary = Join-Path $directory ('.deploy-' + [guid]::NewGuid().ToString('N') + '.exe')
function Assert-UnlockedDestination {
    if (Test-Path -LiteralPath $destination) {
        $item = Get-Item -LiteralPath $destination -Force
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Deployment destination must be a regular file.' }
        # Open, never truncate/write. A running image or incompatible open handle
        # must fail rather than being killed, renamed away or forcibly replaced.
        $probe = [IO.File]::Open($destination, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        $probe.Dispose()
    }
}
try {
    if ((Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedSha256.ToLowerInvariant()) { throw 'Source SHA-256 mismatch.' }
    if ((Test-Path -LiteralPath $destination -PathType Leaf) -and (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -eq $ExpectedSha256.ToLowerInvariant()) {
        [pscustomobject]@{ executablePath = $destination; executableSha256 = $ExpectedSha256.ToLowerInvariant(); unchanged = $true }
        return
    }
    Assert-UnlockedDestination
    [IO.File]::Copy($Source, $temporary, $false)
    $hash = (Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $ExpectedSha256.ToLowerInvariant()) { throw 'Staged deployment SHA-256 mismatch.' }
    Assert-UnlockedDestination
    # Same-directory atomic publication. No delete-before-copy and no fallback
    # to a non-atomic overwrite when Windows refuses replacement.
    if (Test-Path -LiteralPath $destination) { [IO.File]::Replace($temporary, $destination, [System.Management.Automation.Language.NullString]::Value) }
    else { [IO.File]::Move($temporary, $destination) }
    $deployedHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($deployedHash -ne $hash) { throw 'Published deployment SHA-256 mismatch.' }
    [pscustomobject]@{ executablePath = $destination; executableSha256 = $deployedHash }
} catch {
    throw "Portable deployment failed; no forced replacement or application operation was attempted. Release source remains available. $($_.Exception.Message)"
} finally {
    if (Test-Path -LiteralPath $temporary) { [IO.File]::Delete($temporary) }
}
