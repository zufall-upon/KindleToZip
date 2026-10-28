$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$run = Join-Path $root ('artifacts/distribution-tests/deployment-' + [guid]::NewGuid().ToString('N'))
$target = Join-Path $run 'Portable with spaces'
[IO.Directory]::CreateDirectory($target) | Out-Null
$source = Join-Path $run 'source.exe'
$exe = Join-Path $target 'KindleToZip-Portable.exe'
$helper = Join-Path $PSScriptRoot 'deploy-portable.ps1'
$sentinel = Join-Path $target 'data/jobs/profile-settings-output.txt'
[IO.Directory]::CreateDirectory((Split-Path $sentinel -Parent)) | Out-Null
[IO.File]::WriteAllText($sentinel, 'existing user data')
function Deploy([string]$Hash) { & $helper -Source $source -DestinationDirectory $target -ExpectedSha256 $Hash }
function Expect-Failure([scriptblock]$Action) {
    $failed = $false
    try { & $Action | Out-Null } catch { $failed = $true }
    if (-not $failed) { throw 'Expected failure was not reported.' }
    if ([IO.File]::ReadAllText($exe) -ne 'old executable') { throw 'Failure damaged the previous executable.' }
    if (@(Get-ChildItem $target -Filter '.deploy-*.exe' -Force).Count) { throw 'Staging file leaked.' }
}
[IO.File]::WriteAllText($source, 'old executable')
$oldHash = (Get-FileHash $source).Hash
Deploy $oldHash | Out-Null
[IO.File]::WriteAllText($source, 'new executable')
$newHash = (Get-FileHash $source).Hash
Expect-Failure { Deploy ('0' * 64) }
$lock = [IO.File]::Open($exe, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try { Expect-Failure { Deploy $newHash } } finally { $lock.Dispose() }
[IO.File]::Move($source, "$source.saved")
Expect-Failure { Deploy $newHash }
[IO.File]::Move("$source.saved", $source)
$link = Join-Path $run 'junction'
New-Item -ItemType Junction -Path $link -Target $target | Out-Null
try { Expect-Failure { & $helper -Source $source -DestinationDirectory $link -ExpectedSha256 $newHash } }
finally { [IO.Directory]::Delete($link) }
$result = Deploy $newHash
if ($result.executableSha256 -ne $newHash.ToLowerInvariant() -or [IO.File]::ReadAllText($exe) -ne 'new executable') { throw 'Replacement/hash receipt failed.' }
if ([IO.File]::ReadAllText($source) -ne 'new executable') { throw 'Release source changed.' }
if ([IO.File]::ReadAllText($sentinel) -ne 'existing user data') { throw 'Existing data changed.' }
Write-Output 'deployment-regression: pass (first copy, replacement, hash failure, lock, missing source, reparse, data preservation)'
