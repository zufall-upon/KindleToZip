function Get-LatestPortableReport([string]$Root) {
    $releases = Join-Path $Root 'artifacts/releases'
    $files = @(Get-ChildItem -LiteralPath $releases -Filter '*.json' -File)
    foreach ($directory in Get-ChildItem -LiteralPath $releases -Directory -Filter 'build-*') {
        if ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
        $files += @(Get-ChildItem -LiteralPath $directory.FullName -Filter 'KindleToZip-Portable.json' -File)
    }
    $candidates = foreach ($item in $files) {
        try { $report = Get-Content -LiteralPath $item.FullName -Raw -Encoding utf8 | ConvertFrom-Json } catch { continue }
        if ($report.portable -ne $true -or -not $report.executablePath) { continue }
        $exe = [IO.Path]::GetFullPath((Join-Path $Root ([string]$report.executablePath)))
        if ((Split-Path -Parent $exe) -ne $item.DirectoryName -or [IO.Path]::GetFileName($exe) -ne $report.executable) { continue }
        [pscustomobject]@{ Report = $report; Executable = $exe }
    }
    $selected = $candidates | Sort-Object { [DateTime]$_.Report.createdAtUtc } -Descending | Select-Object -First 1
    if (-not $selected) { throw 'No build report with portable=true was found. Build a Portable EXE first.' }
    return $selected
}
