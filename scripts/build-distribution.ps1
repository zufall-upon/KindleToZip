param(
    [string]$NodeExecutable = ''
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$package = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw -Encoding utf8 | ConvertFrom-Json
$version = [string]$package.version
$expectedNode = '22.14.0'
$expectedPlaywright = '1.64.1'
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

if (-not $NodeExecutable) { $NodeExecutable = (Get-Command node -ErrorAction Stop).Source }
$NodeExecutable = (Resolve-Path -LiteralPath $NodeExecutable).Path
$nodeVersion = (& $NodeExecutable --version).Trim().TrimStart('v')
if ($LASTEXITCODE -ne 0 -or $nodeVersion -ne $expectedNode) { throw "Bundled Node source must be v$expectedNode; found v$nodeVersion." }
$playwright = Get-Content -LiteralPath (Join-Path $root 'node_modules/playwright/package.json') -Raw -Encoding utf8 | ConvertFrom-Json
if ($playwright.version -ne $expectedPlaywright) { throw "Expected Playwright $expectedPlaywright; found $($playwright.version)." }
$browserManifest = Get-Content -LiteralPath (Join-Path $root 'node_modules/playwright-core/browsers.json') -Raw -Encoding utf8 | ConvertFrom-Json
$chromium = $browserManifest.browsers | Where-Object name -eq 'chromium'
$headless = $browserManifest.browsers | Where-Object name -eq 'chromium-headless-shell'
$ffmpeg = $browserManifest.browsers | Where-Object name -eq 'ffmpeg'
if ($chromium.revision -ne '1248' -or $headless.revision -ne '1248' -or $ffmpeg.revision -ne '1013') { throw 'Installed Playwright browser revisions do not match the selected package.' }
$browserNames = @("chromium-$($chromium.revision)", "chromium_headless_shell-$($headless.revision)", "ffmpeg-$($ffmpeg.revision)")
foreach ($name in $browserNames) {
    if (-not (Test-Path -LiteralPath (Join-Path $root "artifacts/browsers/$name") -PathType Container)) { throw "Missing fixed Playwright browser payload: $name" }
}

$toolchainReceipt = Get-Content -LiteralPath (Join-Path $root 'artifacts/toolchains/receipt.json') -Raw -Encoding utf8 | ConvertFrom-Json
if ($toolchainReceipt.toolchain -notin @('stable-x86_64-pc-windows-gnu', '1.99.1-x86_64-pc-windows-gnu')) { throw 'Unexpected isolated Rust toolchain.' }
$env:RUSTUP_HOME = Join-Path $root 'artifacts/toolchains/rustup'
$env:CARGO_HOME = Join-Path $root 'artifacts/toolchains/cargo'
$env:RUSTUP_TOOLCHAIN = [string]$toolchainReceipt.toolchain
$cargo = Join-Path $env:CARGO_HOME 'bin/cargo.exe'
$rustc = Join-Path $env:CARGO_HOME 'bin/rustc.exe'
$rustVersion = (& $rustc --version).Trim()
if ($LASTEXITCODE -ne 0 -or $rustVersion -notmatch '^rustc 1\.99\.1 ') { throw "Expected isolated Rust 1.99.1; found $rustVersion." }
$env:CARGO_TARGET_DIR = Join-Path $root 'artifacts/rust-target'
Push-Location $root
try {
    Write-Output "Building Rust controller with $rustVersion (offline)."
    & $cargo build --manifest-path poc/controller/Cargo.toml --locked --offline --release
    if ($LASTEXITCODE -ne 0) { throw "Rust controller build failed with exit $LASTEXITCODE." }
    $controller = Join-Path $env:CARGO_TARGET_DIR 'release/ktz-g02-controller.exe'
    if (-not (Test-Path -LiteralPath $controller -PathType Leaf)) { throw 'Release controller executable was not produced.' }

    $launcherManifest = Join-Path $root 'poc/launcher/Cargo.toml'
    $launcherLock = Join-Path $root 'poc/launcher/Cargo.lock'
    if (-not (Test-Path -LiteralPath $launcherLock)) {
        & $cargo generate-lockfile --manifest-path $launcherManifest --offline
        if ($LASTEXITCODE -ne 0) { throw "Offline launcher lock generation failed with exit $LASTEXITCODE." }
    }
    $launcherTarget = Join-Path $root 'artifacts/toolchains/launcher-target'
    $env:CARGO_TARGET_DIR = $launcherTarget
    $releaseRoot = Join-Path $root 'artifacts/releases'
    [System.IO.Directory]::CreateDirectory($releaseRoot) | Out-Null
    $staging = Join-Path $releaseRoot ('.build-' + [guid]::NewGuid().ToString('N'))
    [System.IO.Directory]::CreateDirectory($staging) | Out-Null
    try {
        $controllerToml = Get-Content -LiteralPath (Join-Path $root 'poc/controller/Cargo.toml') -Raw -Encoding utf8
        $controllerVersion = [regex]::Match($controllerToml, '(?m)^version\s*=\s*"([^"]+)"').Groups[1].Value
        $bundleInfo = [ordered]@{
            appVersion = $version
            controllerVersion = $controllerVersion
            nodeVersion = $nodeVersion
            playwrightVersion = [string]$playwright.version
            chromiumRevision = [string]$chromium.revision
            chromiumVersion = [string]$chromium.browserVersion
            builtAtUtc = [DateTime]::UtcNow.ToString('o')
        }
        $infoPath = Join-Path $staging 'bundle-info.json'
        [System.IO.File]::WriteAllText($infoPath, ($bundleInfo | ConvertTo-Json -Depth 4), [System.Text.UTF8Encoding]::new($false))

        $entries = [System.Collections.Generic.List[object]]::new()
        function Add-PackageDirectory([string]$sourceRelative, [string]$bundlePrefix) {
            $source = Join-Path $root $sourceRelative
            if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "Missing package directory: $sourceRelative" }
            foreach ($file in Get-ChildItem -LiteralPath $source -File -Recurse -Force) {
                if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing to bundle a reparse point: $($file.FullName)" }
                $inside = [IO.Path]::GetRelativePath($source, $file.FullName).Replace('\', '/')
                $entries.Add([pscustomobject]@{ Source = $file.FullName; Relative = "$bundlePrefix/$inside"; Length = [long]$file.Length })
            }
        }
        Add-PackageDirectory 'app' 'app'
        $publicUiHelper = Get-Item -LiteralPath (Join-Path $root 'poc/browser/public-ui-controls.mjs')
        $entries.Add([pscustomobject]@{ Source = $publicUiHelper.FullName; Relative = 'poc/browser/public-ui-controls.mjs'; Length = [long]$publicUiHelper.Length })
        Add-PackageDirectory 'node_modules/playwright' 'node_modules/playwright'
        Add-PackageDirectory 'node_modules/playwright-core' 'node_modules/playwright-core'
        Add-PackageDirectory "artifacts/browsers/$($browserNames[0])" "artifacts/browsers/$($browserNames[0])"
        Add-PackageDirectory "artifacts/browsers/$($browserNames[1])" "artifacts/browsers/$($browserNames[1])"
        Add-PackageDirectory "artifacts/browsers/$($browserNames[2])" "artifacts/browsers/$($browserNames[2])"
        foreach ($relative in @('poc/browser/fixture-server.mjs', 'poc/fixtures/reader.html', 'poc/fixtures/reader.css', 'poc/fixtures/reader.js', 'poc/fixtures/reader-layout.html', 'poc/fixtures/reader-layout.js', 'poc/fixtures/reader-layout.css', 'poc/fixtures/reader-layout-frame.html', 'poc/fixtures/reader-layout-frame.css', 'poc/fixtures/reader-kindle-chrome.html', 'poc/fixtures/reader-kindle-chrome.css', 'poc/fixtures/reader-kindle-chrome.js', 'poc/launcher/smoke.mjs')) {
            $source = Join-Path $root $relative
            if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing package file: $relative" }
            $file = Get-Item -LiteralPath $source
            if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing to bundle a reparse point: $relative" }
            $entries.Add([pscustomobject]@{ Source = $file.FullName; Relative = $relative.Replace('\', '/'); Length = [long]$file.Length })
        }
        $entries.Add([pscustomobject]@{ Source = $NodeExecutable; Relative = 'node/node.exe'; Length = [long](Get-Item -LiteralPath $NodeExecutable).Length })
        $entries.Add([pscustomobject]@{ Source = $controller; Relative = 'controller/ktz-g02-controller.exe'; Length = [long](Get-Item -LiteralPath $controller).Length })
        $entries.Add([pscustomobject]@{ Source = $infoPath; Relative = 'bundle-info.json'; Length = [long](Get-Item -LiteralPath $infoPath).Length })
        $sortedEntries = @($entries | Sort-Object -Property Relative)
        if ($sortedEntries.Count -gt 100000) { throw 'Package contains too many files.' }

        $payload = Join-Path $staging 'payload.bin'
        $payloadStream = [System.IO.FileStream]::new($payload, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 1048576, [IO.FileOptions]::SequentialScan)
        $writer = [System.IO.BinaryWriter]::new($payloadStream, [System.Text.Encoding]::UTF8, $true)
        try {
            $writer.Write([System.Text.Encoding]::ASCII.GetBytes('KTZBNDL1'))
            $writer.Write([uint32]$sortedEntries.Count)
            foreach ($entry in $sortedEntries) {
                $pathBytes = [System.Text.Encoding]::UTF8.GetBytes([string]$entry.Relative)
                if ($pathBytes.Length -gt 4096) { throw "Package path is too long: $($entry.Relative)" }
                $writer.Write([uint16]$pathBytes.Length)
                $writer.Write([uint64]$entry.Length)
                $writer.Write($pathBytes)
                $inputStream = [System.IO.FileStream]::new($entry.Source, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read, 1048576, [IO.FileOptions]::SequentialScan)
                try {
                    if ($inputStream.Length -ne $entry.Length) { throw "Package input changed while collecting: $($entry.Relative)" }
                    $inputStream.CopyTo($payloadStream, 1048576)
                    if ($inputStream.Position -ne $inputStream.Length) { throw "Package input was not fully read: $($entry.Relative)" }
                } finally { $inputStream.Dispose() }
            }
            $writer.Flush()
            $payloadStream.Flush($true)
        } finally { $writer.Dispose(); $payloadStream.Dispose() }

        $payloadHash = (Get-FileHash -LiteralPath $payload -Algorithm SHA256).Hash.ToLowerInvariant()
        Remove-Item Env:\KTZ_EMBEDDED_PAYLOAD -ErrorAction SilentlyContinue
        $payloadBytes = [long](Get-Item -LiteralPath $payload).Length
        Write-Output ("Appending {0:N0} files ({1:N0} bytes), payload SHA-256 {2}." -f $sortedEntries.Count, $payloadBytes, $payloadHash)
        & $cargo build --manifest-path $launcherManifest --locked --offline --release
        if ($LASTEXITCODE -ne 0) { throw "Single-file launcher build failed with exit $LASTEXITCODE." }

        $launcher = Join-Path $launcherTarget 'release/kindle-to-zip-launcher.exe'
        if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'Self-extracting launcher executable was not produced.' }
        $stubBytes = [long](Get-Item -LiteralPath $launcher).Length
        if ($stubBytes -le 0 -or $payloadBytes -le 0) { throw 'Launcher stub and payload must both contain bytes.' }
        $assembled = Join-Path $staging 'KindleToZip.exe'
        $stubStream = [System.IO.FileStream]::new($launcher, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read, 1048576, [IO.FileOptions]::SequentialScan)
        $payloadStream = [System.IO.FileStream]::new($payload, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read, 1048576, [IO.FileOptions]::SequentialScan)
        $assembledStream = [System.IO.FileStream]::new($assembled, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 1048576, [IO.FileOptions]::SequentialScan)
        try {
            $stubStream.CopyTo($assembledStream, 1048576)
            if ($stubStream.Position -ne $stubStream.Length) { throw 'Launcher stub was not fully copied.' }
            $payloadStream.CopyTo($assembledStream, 1048576)
            if ($payloadStream.Position -ne $payloadStream.Length) { throw 'Package payload was not fully copied.' }
            $footer = [System.IO.BinaryWriter]::new($assembledStream, [System.Text.Encoding]::ASCII, $true)
            try {
                $footer.Write([System.Text.Encoding]::ASCII.GetBytes('KTZEND01'))
                $footer.Write([uint64]$stubBytes)
                $footer.Write([uint64]$payloadBytes)
                $footer.Write([Convert]::FromHexString($payloadHash))
                $footer.Flush()
                $assembledStream.Flush($true)
            } finally { $footer.Dispose() }
        } finally {
            $assembledStream.Dispose()
            $payloadStream.Dispose()
            $stubStream.Dispose()
        }
        $assembledHash = (Get-FileHash -LiteralPath $assembled -Algorithm SHA256).Hash.ToLowerInvariant()
        $destinationName = "KindleToZip-Portable.exe"
        # Immutable build directories retain history without exposing hashes in
        # the user-facing filename or replacing an earlier healthy release.
        $buildDirectory = Join-Path $releaseRoot ('build-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
        [IO.Directory]::CreateDirectory($buildDirectory) | Out-Null
        $destination = Join-Path $buildDirectory $destinationName
        [System.IO.File]::Move($assembled, $destination)
        $exeHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($exeHash -ne $assembledHash) { throw 'Final release executable hash does not match the assembled package.' }
        $exeSize = (Get-Item -LiteralPath $destination).Length
        $report = [ordered]@{
            appVersion = $version
            portable = $true
            portableLayout = 'runtime/, data/, temp/ beside the executable'
            executable = $destinationName
            executablePath = [IO.Path]::GetRelativePath($root, $destination).Replace('\', '/')
            executableBytes = $exeSize
            executableSha256 = $exeHash
            payloadSha256 = $payloadHash
            launcherStubBytes = $stubBytes
            payloadBytes = $payloadBytes
            payloadFooterBytes = 56
            bundledNode = $nodeVersion
            bundledRustController = $controllerVersion
            bundledRustToolchain = $rustVersion
            playwright = [string]$playwright.version
            chromiumRevision = [string]$chromium.revision
            chromiumVersion = [string]$chromium.browserVersion
            browserPayloadBytes = [long](($sortedEntries | Where-Object Relative -Like 'artifacts/browsers/*' | Measure-Object -Property Length -Sum).Sum)
            createdAtUtc = [DateTime]::UtcNow.ToString('o')
            cleanWindowsTested = $false
            smokeCommand = "node scripts/test-distribution.mjs `"$([IO.Path]::GetRelativePath($root, $destination).Replace('\', '/'))`""
        }
        $reportPath = [IO.Path]::ChangeExtension($destination, '.json')
        $reportBytes = [System.Text.UTF8Encoding]::new($false).GetBytes(($report | ConvertTo-Json -Depth 6))
        $reportStream = [System.IO.FileStream]::new($reportPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $reportStream.Write($reportBytes, 0, $reportBytes.Length); $reportStream.Flush($true) }
        finally { $reportStream.Dispose() }
        $deployment = & (Join-Path $PSScriptRoot 'deploy-portable.ps1') -Source $destination -DestinationDirectory (Join-Path $root '_testenv') -ExpectedSha256 $exeHash
        $deployment | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $buildDirectory 'deployment.json') -Encoding utf8
        $stopwatch.Stop()
        Write-Output "Portable single-file Windows package created without replacing an existing release."
        Write-Output "Version: $version"
        Write-Output "Executable: $($report.executablePath)"
        Write-Output "Bytes: $exeSize"
        Write-Output "SHA-256: $exeHash"
        Write-Output "Payload SHA-256: $payloadHash"
        Write-Output "Build elapsed: $([math]::Round($stopwatch.Elapsed.TotalSeconds, 2)) seconds"
        Write-Output "Build report: $([IO.Path]::GetRelativePath($root, $reportPath).Replace('\', '/'))"
        Write-Output "Deployed: $($deployment.executablePath)"
        Write-Output "Deployed SHA-256: $($deployment.executableSha256)"
    } finally {
        Remove-Item Env:\KTZ_EMBEDDED_PAYLOAD -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
    }
} finally { Pop-Location }
