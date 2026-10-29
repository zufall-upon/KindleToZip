param(
    [Parameter(Mandatory)][ValidatePattern('^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$')][string]$Tag,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{40}$')][string]$SourceCommit,
    [Parameter(Mandatory)][ValidatePattern('^[0-9]+$')][string]$WorkflowRun,
    [string]$Repository = 'zufall-upon/KindleToZip',
    [string]$Destination = 'release'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
    . ./scripts/portable-reports.ps1
    $build = Get-LatestPortableReport $root
    $report = $build.Report
    if ($Tag -ne "v$($report.appVersion)" -or $Repository -ne 'zufall-upon/KindleToZip') { throw 'Release package version/repository mismatch.' }
    $release = New-Item -ItemType Directory -Path $Destination
    $packageDir = New-Item -ItemType Directory -Path "$release/package"
    Copy-Item -LiteralPath $build.Executable -Destination "$packageDir/KindleToZip-Portable.exe"
    Copy-Item -LiteralPath LICENSE -Destination $packageDir
    Copy-Item -LiteralPath docs/portable.md -Destination "$packageDir/README.md"
    $notices = New-Item -ItemType Directory -Path "$packageDir/third-party-notices"
    foreach ($name in @('playwright','playwright-core')) {
        $destination = New-Item -ItemType Directory -Path "$notices/$name"
        Get-ChildItem -Path "node_modules/$name/*" -File | Where-Object { $_.Name -match '^(LICENSE|NOTICE|COPYING)' } | Copy-Item -Destination $destination
    }
    # The locked JPEG crates are already fetched by the release workflow. Copy
    # their original license texts and the IJG notice from the actual source.
    $controllerLock = Get-Content -LiteralPath 'poc/controller/Cargo.lock' -Raw -Encoding utf8
    $registry = Join-Path $root 'artifacts/toolchains/cargo/registry/src'
    foreach ($crate in @(
        @{ name = 'jpeg-decoder'; version = '0.3.2' },
        @{ name = 'jpeg-encoder'; version = '0.6.1' }
    )) {
        $lockEntry = '(?m)^name = "' + [regex]::Escape($crate.name) + '"\r?\nversion = "' + [regex]::Escape($crate.version) + '"\r?$'
        if ($controllerLock -notmatch $lockEntry) { throw "JPEG notice version does not match the controller lock: $($crate.name)" }
        $crateName = "$($crate.name)-$($crate.version)"
        $sources = @(Get-ChildItem -LiteralPath $registry -Directory | ForEach-Object {
            $candidate = Join-Path $_.FullName $crateName
            if (Test-Path -LiteralPath $candidate -PathType Container) { $candidate }
        })
        if ($sources.Count -ne 1) { throw "Expected exactly one fetched source directory for $crateName." }
        $destination = New-Item -ItemType Directory -Path "$notices/$crateName"
        foreach ($license in @('LICENSE-MIT', 'LICENSE-APACHE')) {
            Copy-Item -LiteralPath (Join-Path $sources[0] $license) -Destination $destination
        }
        if ($crate.name -eq 'jpeg-encoder') {
            $source = [IO.File]::ReadAllText((Join-Path $sources[0] 'src/fdct.rs'))
            $header = [regex]::Match($source, '(?s)\A/\*.*?(?=\s*\* This file contains a slower)')
            if (-not $header.Success -or $header.Value -notmatch '1991-2020, Thomas G\. Lane, Guido Vollbeding' -or $header.Value -notmatch 'Independent JPEG Group') { throw 'The JPEG encoder IJG source notice was not found.' }
            $acknowledgement = "this software is based in part on the work of the Independent JPEG Group.`n`nSource: jpeg-encoder 0.6.1, src/fdct.rs (ported from mozjpeg).`n`n"
            [IO.File]::WriteAllText((Join-Path $destination 'IJG-NOTICE.txt'), $acknowledgement + $header.Value.TrimEnd() + "`n */`n", [Text.UTF8Encoding]::new($false))
        }
    }
    Invoke-WebRequest -Uri https://raw.githubusercontent.com/nodejs/node/v22.14.0/LICENSE -OutFile "$notices/Node.js-LICENSE"
    $browsers = (Resolve-Path artifacts/browsers).Path
    Get-ChildItem -LiteralPath $browsers -Recurse -File | Where-Object { $_.Name -match '^(LICENSE|NOTICE|ABOUT|COPYING|COPYRIGHT)([._-]|$)' } | ForEach-Object {
        $relative = [IO.Path]::GetRelativePath($browsers, $_.FullName)
        $destination = Join-Path "$notices/browser" $relative
        New-Item -ItemType Directory -Force -Path (Split-Path $destination -Parent) | Out-Null
        Copy-Item -LiteralPath $_.FullName -Destination $destination
    }
    [ordered]@{ repository = $Repository; sourceCommit = $SourceCommit; tag = $Tag; workflowRun = $WorkflowRun; build = $report } | ConvertTo-Json -Depth 10 | Set-Content "$packageDir/build-metadata.json" -Encoding utf8NoBOM
    $archive = "$release/KindleToZip-Portable-$Tag-win-x64.zip"
    Compress-Archive -Path "$packageDir/*" -DestinationPath $archive
    $entries = @($archive, "$packageDir/KindleToZip-Portable.exe") | ForEach-Object {
        $digest = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant()
        $relative = [IO.Path]::GetRelativePath($release.FullName, (Resolve-Path $_).Path).Replace('\','/')
        "$digest  $relative"
    }
    $entries | Set-Content "$release/SHA256SUMS.txt" -Encoding ascii
    Write-Output "Release archive and notices prepared: $archive"
} finally { Pop-Location }
