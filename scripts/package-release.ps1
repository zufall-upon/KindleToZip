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
