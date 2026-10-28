$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$machine = Get-CimInstance Win32_ComputerSystem
$cpu = @(Get-CimInstance Win32_Processor | ForEach-Object { $_.Name.Trim() })
$environment = [ordered]@{
    os = [Environment]::OSVersion.VersionString
    logicalProcessors = [int]$machine.NumberOfLogicalProcessors
    physicalMemoryBytes = [long]$machine.TotalPhysicalMemory
    processorModels = $cpu
}
[Console]::WriteLine((@{version=1; id=0; ok=$true; environment=$environment} | ConvertTo-Json -Depth 5 -Compress))
$clock = [Diagnostics.Stopwatch]::StartNew()
$lastCpu = @{}
$cpuMilliseconds = 0.0
$baselineMs = $null
$lastId = 0
while ($null -ne ($line = [Console]::ReadLine())) {
    try {
        if ($line.Length -gt 65536) { throw 'invalid_frame' }
        $request = $line | ConvertFrom-Json
        $ids = @($request.pids)
        if ($request.version -ne 1 -or $request.id -le $lastId -or $ids.Count -lt 1 -or $ids.Count -gt 128) { throw 'invalid_request' }
        $lastId = $request.id
        $first = $null -eq $baselineMs
        if ($first) { $baselineMs = $clock.Elapsed.TotalMilliseconds }
        $workingSet = [long]0
        $privateBytes = [long]0
        $observed = 0
        $missing = 0
        foreach ($processId in $ids) {
            if ($processId -isnot [long] -and $processId -isnot [int]) { throw 'invalid_pid' }
            if ($processId -le 0) { throw 'invalid_pid' }
            try {
                # The caller supplies only its own Node/Rust/sampler and managed
                # Chromium IDs. No process enumeration or names/titles are saved.
                $process = Get-Process -Id ([int]$processId) -ErrorAction Stop
                $key = "$processId/$($process.StartTime.Ticks)"
                $currentCpu = [double]$process.CPU * 1000
                if (-not $first) {
                    $previous = if ($lastCpu.ContainsKey($key)) { [double]$lastCpu[$key] } else { 0.0 }
                    $cpuMilliseconds += [Math]::Max(0.0, $currentCpu - $previous)
                }
                $lastCpu[$key] = $currentCpu
                $workingSet += $process.WorkingSet64
                $privateBytes += $process.PrivateMemorySize64
                $observed++
                $process.Dispose()
            } catch { $missing++ }
        }
        $sample = [ordered]@{
            elapsedMs = [Math]::Round($clock.Elapsed.TotalMilliseconds - $baselineMs, 3)
            cpuMilliseconds = [Math]::Round($cpuMilliseconds, 3)
            workingSetBytes = $workingSet
            privateBytes = $privateBytes
            processCount = $observed
            missingProcesses = $missing
        }
        [Console]::WriteLine((@{version=1; id=$request.id; ok=$true; sample=$sample} | ConvertTo-Json -Depth 4 -Compress))
    } catch {
        [Console]::WriteLine('{"version":1,"id":0,"ok":false,"code":"sampler_failed"}')
        exit 1
    }
}
