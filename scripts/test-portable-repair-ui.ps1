param([switch]$LatestPortable)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if (-not $LatestPortable) { throw 'Use -LatestPortable to select a hash-bound build report.' }
$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'portable-reports.ps1')
$selected = Get-LatestPortableReport $root
$report = $selected.Report
if (-not $report -or [IO.Path]::GetFileName($report.executable) -ne $report.executable) { throw 'Invalid Portable build report.' }
$source = $selected.Executable
$portable = Join-Path $root '_testenv'
$exe = Join-Path $portable $report.executable
$hash = (Get-FileHash $source -Algorithm SHA256).Hash.ToLowerInvariant()
if ($hash -ne $report.executableSha256) { throw 'Build hash mismatch.' }
if (-not (Test-Path $exe) -or (Get-FileHash $exe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash) { throw 'Run npm run dist:build to deploy the current EXE first.' }
# Exercise the identical fixed-name EXE in an owned anonymous directory. Never
# open, lock, edit or close the user's currently running Portable workspace.
$evidence = Join-Path $root ('artifacts/indicator-review/p' + (Get-Date -Format 'MMddHHmmss'))
[void][IO.Directory]::CreateDirectory($evidence)
$portable = $evidence
$exe = Join-Path $portable 'KindleToZip-Portable.exe'
Copy-Item -LiteralPath $source -Destination $exe
if ((Get-FileHash $exe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash) { throw 'Anonymous Portable copy hash mismatch.' }

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class KtzRepairWindow {
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
}
'@
function Get-Owners([int]$RootId) {
    $all = @(Get-CimInstance Win32_Process)
    $owners = [Collections.Generic.HashSet[int]]::new()
    [void]$owners.Add($RootId)
    do {
        $added = $false
        foreach ($item in $all) {
            if ($owners.Contains([int]$item.ParentProcessId) -and $owners.Add([int]$item.ProcessId)) { $added = $true }
        }
    } while ($added)
    return ,$owners
}
function Wait-Value([scriptblock]$Get, [int]$Seconds = 35) {
    $until = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        $result = & $Get
        if ($result) { return $result }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $until)
    throw "Owned public UI deadline: $script:phase"
}
function Get-Windows($Owners) {
    $children = [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition)
    return @($children | Where-Object { $Owners.Contains($_.Current.ProcessId) })
}
function Get-Elements($Window) {
    return $Window.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
}
function Find-Control($Window, [string]$Name) {
    return Get-Elements $Window | Where-Object { $_.Current.Name -eq $Name -and -not $_.Current.IsOffscreen } | Select-Object -First 1
}
function Invoke-Control($Window, [string]$Name) {
    $script:phase = "公開UI操作: $Name"
    Write-Host $script:phase
    $offscreen = Get-Elements $Window | Where-Object { $_.Current.Name -eq $Name -and $_.Current.ControlType -eq [Windows.Automation.ControlType]::Button } | Select-Object -First 1
    if ($offscreen -and $offscreen.Current.IsOffscreen) {
        $scroll = $null
        if ($offscreen.TryGetCurrentPattern([Windows.Automation.ScrollItemPattern]::Pattern, [ref]$scroll)) { $scroll.ScrollIntoView() }
        else {
            # Scroll only the app's control document, never the official reader.
            $ancestor = [Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($offscreen)
            while ($ancestor -and -not $ancestor.TryGetCurrentPattern([Windows.Automation.ScrollPattern]::Pattern, [ref]$scroll)) {
                $ancestor = [Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($ancestor)
            }
            if ($scroll) {
                for ($step = 0; $step -lt 8 -and $offscreen.Current.IsOffscreen; $step++) {
                    $scroll.Scroll([Windows.Automation.ScrollAmount]::NoAmount, [Windows.Automation.ScrollAmount]::LargeIncrement)
                }
            }
        }
    }
    try { $element = Wait-Value { $e = Find-Control $Window $Name; if ($e -and $e.Current.IsEnabled) { $e } } }
    catch {
        Get-Elements $Window | Where-Object { $_.Current.Name -eq $Name -or $_.Current.Name -match '^処理中|^対象の専用タブ|^専用タブ \d+$|^対象の専用タブを選び|^操作を反映|^対象タブを選択|^自作試料' } | ForEach-Object {
            Write-Host ("UI診断: {0} / {1} / enabled={2} offscreen={3}" -f $_.Current.ControlType.ProgrammaticName, $_.Current.Name, $_.Current.IsEnabled, $_.Current.IsOffscreen)
        }
        throw
    }
    $pattern = $null
    if ($element.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { $pattern.Invoke() }
    elseif ($element.TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern)) { $pattern.Expand() }
    else { throw "No public Invoke/Expand pattern: $Name" }
}
function Start-Owned([string[]]$Arguments = @()) {
    $start = [Diagnostics.ProcessStartInfo]::new($exe)
    $start.WorkingDirectory = $portable
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($arg in $Arguments) { $start.ArgumentList.Add($arg) }
    $process = [Diagnostics.Process]::Start($start)
    $out = $process.StandardOutput.ReadToEndAsync()
    $err = $process.StandardError.ReadToEndAsync()
    $window = Wait-Value {
        $owners = Get-Owners $process.Id
        Get-Windows $owners | Where-Object { $_.Current.Name -like 'KindleToZip*手順ガイド*' } | Select-Object -First 1
    } 90
    # Query twice: Chromium enables its accessibility provider on first request.
    [void](Get-Elements $window)
    [void](Wait-Value { Find-Control $window '決定・次へ' })
    return @{ Process = $process; Window = $window; Out = $out; Err = $err }
}
function Close-Owned($Run) {
    $window = $Run.Window.Current
    if (-not [KtzRepairWindow]::PostMessage([IntPtr]$window.NativeWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'Owned normal close failed.' }
    if (-not $Run.Process.WaitForExit(40000)) { throw 'Normal EXE exit timed out.' }
    if ($Run.Process.ExitCode -ne 0) { throw 'Normal EXE exit was not successful.' }
    if (-not $Run.Out.Wait(10000) -or -not $Run.Err.Wait(10000)) { throw 'Owned streams did not close.' }
}
function Select-OwnedLanguage($Run, [string]$Name, [string]$ExpectedNext, [string]$Screenshot) {
    $script:phase = "言語の公開選択: $Name"
    $combo = Wait-Value { Get-Elements $Run.Window | Where-Object { $_.Current.Name -eq '言語 / Language / 语言' -and $_.Current.ControlType -eq [Windows.Automation.ControlType]::ComboBox } | Select-Object -First 1 }
    $scroll = $null
    if ($combo.Current.IsOffscreen -and $combo.TryGetCurrentPattern([Windows.Automation.ScrollItemPattern]::Pattern, [ref]$scroll)) { $scroll.ScrollIntoView() }
    $expand = $combo.GetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern)
    $expand.Expand()
    $option = Wait-Value {
        $owners = Get-Owners $Run.Process.Id
        foreach ($ownedWindow in Get-Windows $owners) {
            $found = Find-Control $ownedWindow $Name
            if ($found) { return $found }
        }
    }
    $selection = $option.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern)
    $selection.Select()
    try { $expand.Collapse() } catch { # Some Chromium versions close the popup on selection.
    }
    [void](Wait-Value { Find-Control $Run.Window $ExpectedNext })
    Save-OwnedWindow $Run.Window $Screenshot
    return @{ language = $Name; nextAction = $ExpectedNext; publicSelection = $true; screenshot = $Screenshot }
}
function Get-Profile($Run) {
    $profile = Wait-Value {
        # --kindle opens the reader after its control window is ready.
        $owners = Get-Owners $Run.Process.Id
        foreach ($p in Get-CimInstance Win32_Process) {
            if ($owners.Contains([int]$p.ProcessId) -and $p.Name -eq 'chrome.exe' -and $p.CommandLine -match '--user-data-dir=(?:"([^"]+)"|(\S+))') {
                $value = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
                if ((Split-Path -Parent $value) -eq (Join-Path $portable 'data')) { return $value }
            }
        }
    }
    return $profile
}
function Get-ExistingHashes {
    $result = @{}
    foreach ($file in Get-ChildItem (Join-Path $portable 'data/jobs') -File -Recurse -ErrorAction SilentlyContinue) {
        if ($file.Name -ne '.job.lock') { $result[$file.FullName] = (Get-FileHash $file.FullName -Algorithm SHA256).Hash }
    }
    foreach ($file in Get-ChildItem $portable -File -Filter '*.exe') { $result[$file.FullName] = (Get-FileHash $file.FullName -Algorithm SHA256).Hash }
    return $result
}

function Wait-Idle($Window) {
    Start-Sleep -Milliseconds 300
    [void](Wait-Value { Get-Elements $Window | Where-Object { $_.Current.ControlType -eq [Windows.Automation.ControlType]::Text -and $_.Current.Name -match '^(完了：|失敗：|取消：|待機中$)' -and -not $_.Current.IsOffscreen } | Select-Object -First 1 })
}
function Save-OwnedWindow($Window, [string]$Name) {
    Add-Type -AssemblyName System.Drawing
    $bounds = $Window.Current.BoundingRectangle
    $bitmap = [Drawing.Bitmap]::new([int]$bounds.Width, [int]$bounds.Height)
    $graphics = [Drawing.Graphics]::FromImage($bitmap); $dc = $graphics.GetHdc()
    try { if (-not [KtzRepairWindow]::PrintWindow([IntPtr]$Window.Current.NativeWindowHandle, $dc, 2)) { throw 'Owned screenshot failed.' } }
    finally { $graphics.ReleaseHdc($dc); $graphics.Dispose() }
    try { $bitmap.Save((Join-Path $evidence $Name), [Drawing.Imaging.ImageFormat]::Png) } finally { $bitmap.Dispose() }
}
function Get-MeasuredProgress($Window, [int]$Expected) {
    $text = Find-Control $Window ($Expected.ToString() + '%')
    $bar = Get-Elements $Window | Where-Object { $_.Current.ControlType -eq [Windows.Automation.ControlType]::ProgressBar -and -not $_.Current.IsOffscreen } | Select-Object -First 1
    if (-not $text -or -not $bar) { return $null }
    $pattern = $null
    if (-not $bar.TryGetCurrentPattern([Windows.Automation.RangeValuePattern]::Pattern, [ref]$pattern)) { return $null }
    if ($pattern.Current.Value -ne $Expected) { throw 'Portable bar/percent mismatch.' }
    return @{ percent = $Expected; barValue = $pattern.Current.Value; visible = $true }
}
function Get-UnknownProgress($Window) {
    if ((Find-Control $Window '割合未確定') -and (Get-Elements $Window | Where-Object { $_.Current.Name -match '総量未確定.*残り不明' -and -not $_.Current.IsOffscreen } | Select-Object -First 1)) {
        return @{ totalUnknown = $true; remainingUnknown = $true; percentageUnknown = $true }
    }
}
function Test-PackagedWholeProgress($Window) {
    $bundle = Get-ChildItem (Join-Path $portable 'runtime') -Directory | Select-Object -First 1
    # Copy only this quiescent anonymous job, never its lock. The companion
    # exercises the exact packaged modules/binary without taking the EXE's job.
    $job = Get-ChildItem (Join-Path $portable 'data/jobs') -Filter manifest.json -File -Recurse | Select-Object -First 1
    $copy = Join-Path $evidence 'measured-job-copy'
    [void][IO.Directory]::CreateDirectory($copy)
    Get-ChildItem -LiteralPath $job.DirectoryName | Where-Object Name -ne '.job.lock' | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $copy -Recurse }
    $env:KTZ_REVIEW_BUNDLE = $bundle.FullName
    $env:KTZ_REVIEW_JOB = $copy
    $env:KTZ_REVIEW_EVIDENCE = $evidence
    try {
        $result = & (Join-Path $bundle.FullName 'node/node.exe') (Join-Path $root 'tests/support/portable-whole-progress.mjs')
        if ($LASTEXITCODE -ne 0) { throw 'Packaged multiple-image public UI regression failed.' }
        & (Join-Path $bundle.FullName 'node/node.exe') (Join-Path $root 'tests/support/portable-capture-resume.mjs') | Write-Host
        if ($LASTEXITCODE -ne 0) { throw 'Packaged retained-image resume public UI regression failed.' }
        return $result | ConvertFrom-Json
    } finally {
        Remove-Item Env:KTZ_REVIEW_BUNDLE, Env:KTZ_REVIEW_JOB, Env:KTZ_REVIEW_EVIDENCE -ErrorAction SilentlyContinue
    }
}
function Get-Manifest {
    $file = Get-ChildItem (Join-Path $portable 'data/jobs') -Filter manifest.json -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($file) { Get-Content -LiteralPath $file.FullName -Raw -Encoding utf8 | ConvertFrom-Json }
}
function Approve-And-Capture($Window) {
    $checkbox = Wait-Value { Get-Elements $Window | Where-Object { $_.Current.Name -eq 'この本・領域・次へ方向・位置が正しい' -and $_.Current.ControlType -eq [Windows.Automation.ControlType]::CheckBox } | Select-Object -First 1 }
    $scroll = $null
    if ($checkbox.Current.IsOffscreen -and $checkbox.TryGetCurrentPattern([Windows.Automation.ScrollItemPattern]::Pattern, [ref]$scroll)) { $scroll.ScrollIntoView() }
    $toggle = $checkbox.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern)
    if ($toggle.Current.ToggleState -ne [Windows.Automation.ToggleState]::On) { $toggle.Toggle() }
    Invoke-Control $Window '決定・次へ'; Wait-Idle $Window
    if (@((Get-Manifest).images).Count -ne 0) { throw 'Approval started acquisition.' }
    Invoke-Control $Window '決定・次へ'
    [void](Wait-Value { $m = Get-Manifest; if (@($m.images).Count -ge 1 -and $m.state -ne 'capturing') { $m } } 60)
    Wait-Idle $Window
}
$watch = [Diagnostics.Stopwatch]::StartNew()
$runs = @()
try {
    $sample = Start-Owned; $runs += $sample; $window = $sample.Window
    $nativeLanguages = @(
        (Select-OwnedLanguage $sample 'English' 'Confirm / Next' 'portable-language-en.png'),
        (Select-OwnedLanguage $sample '简体中文' '确定／下一步' 'portable-language-zh-CN.png'),
        (Select-OwnedLanguage $sample '日本語' '決定・次へ' 'portable-language-ja.png')
    )
    Invoke-Control $window '決定・次へ'; Wait-Idle $window
    Invoke-Control $window '専用セッション・自作試料（補助）'
    Invoke-Control $window '選択した自作試料を開く'; Wait-Idle $window
    Invoke-Control $window '決定・次へ'; Wait-Idle $window
    Invoke-Control $window '決定・次へ'
    Wait-Idle $window
    $info = (Wait-Value { Get-Elements $window | Where-Object { $_.Current.Name -match '^表示範囲 \d+×\d+ CSS px → 元PNG \d+×\d+ px' } | Select-Object -First 1 }).Current.Name
    Approve-And-Capture $window
    $firstCount = @((Get-Manifest).images).Count
    $wholeProgress = Test-PackagedWholeProgress $window
    Invoke-Control $window '決定・次へ'; Wait-Idle $window
    Invoke-Control $window '決定・次へ'; Wait-Idle $window
    $navigationProgress = Wait-Value { Get-UnknownProgress $window }
    [void](Wait-Value { Find-Control $window '待機中' })
    if (@((Get-Manifest).exports).Count -ne 0) { throw 'Navigation exported early.' }
    Save-OwnedWindow $window 'portable-export-operation-wait.png'
    $nodePid = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($sample.Process.Id)" | Where-Object Name -eq 'node.exe')[0].ProcessId
    Invoke-Control $window '保存先を選ぶ…'
    [void](Wait-Value { Find-Control $window '保存先ダイアログの選択待ち' })
    $pendingProgress = Wait-Value { Get-UnknownProgress $window }
    Save-OwnedWindow $window 'portable-dialog-pending.png'
    Start-Sleep -Milliseconds 1200
    [void](Wait-Value { Get-UnknownProgress $window })
    $cancelled = & (Join-Path $PSScriptRoot 'drive-owned-save-dialog.ps1') -OwnerPid $nodePid -Action cancel -Screenshot (Join-Path $evidence 'portable-native-dialog.png') | ConvertFrom-Json
    Wait-Idle $window
    [void](Wait-Value { Find-Control $window '取消：保存先ダイアログの選択待ち' })
    if (-not $cancelled.nativeWindowFound -or $cancelled.initialFilename -eq 'export.zip') { throw 'Owned title-based dialog default was not observed.' }
    Invoke-Control $window '保存先を選ぶ…'
    $destination = Join-Path $portable 'anonymous-selected.zip'
    $selectedDialog = & (Join-Path $PSScriptRoot 'drive-owned-save-dialog.ps1') -OwnerPid $nodePid -Action select -Destination $destination | ConvertFrom-Json
    Wait-Idle $window
    if (Test-Path $destination) { throw 'Selecting a path exported early.' }
    Invoke-Control $window '決定・次へ'; Wait-Idle $window
    if (-not (Test-Path $destination)) { throw 'Public ZIP export failed.' }
    $archiveHash = (Get-FileHash $destination).Hash
    # The same basename in a different folder is a distinct output. Exercise
    # the primary three-button flow, not the auxiliary individual-save entry.
    $jobManifest = Get-ChildItem (Join-Path $portable 'data/jobs') -Filter manifest.json -File -Recurse | Select-Object -First 1
    $sameNameInsideJob = Join-Path $jobManifest.DirectoryName ([IO.Path]::GetFileName($destination))
    Invoke-Control $window '保存先を選ぶ…'
    [void](& (Join-Path $PSScriptRoot 'drive-owned-save-dialog.ps1') -OwnerPid $nodePid -Action select -Destination $sameNameInsideJob)
    Wait-Idle $window
    if (Test-Path $sameNameInsideJob) { throw 'Same-name selection exported early.' }
    Invoke-Control $window '決定・次へ'; Wait-Idle $window
    if (-not (Test-Path $sameNameInsideJob) -or (Get-FileHash $destination).Hash -ne $archiveHash) { throw 'Same-name distinct-folder save failed.' }
    $sameNameHash = (Get-FileHash $sameNameInsideJob).Hash
    Invoke-Control $window 'キャンセル・前へ'
    [void](Wait-Value { Find-Control $window '取得画像を削除して最初からやり直す' })
    # Chromium's modal accessibility tree hides the background status region.
    # Assert it through the packaged companion's public DOM/render instead.
    $resetDecisionProgress = $wholeProgress.resetDecisionWait
    Save-OwnedWindow $window 'portable-reset-confirm.png'
    Invoke-Control $window 'キャンセル'; Wait-Idle $window
    if (@((Get-Manifest).images).Count -ne $firstCount) { throw 'Cancel deleted images.' }
    Invoke-Control $window 'キャンセル・前へ'
    Invoke-Control $window '画像を残して戻る'; Wait-Idle $window
    if (@((Get-Manifest).images).Count -ne $firstCount) { throw 'Keep deleted images.' }
    Invoke-Control $window 'キャンセル・前へ'
    Invoke-Control $window '取得画像を削除して最初からやり直す'; Wait-Idle $window
    if (@((Get-Manifest).images).Count -ne 0 -or (Get-FileHash $destination).Hash -ne $archiveHash -or (Get-FileHash $sameNameInsideJob).Hash -ne $sameNameHash) { throw 'Reset scope mismatch.' }
    Invoke-Control $window '決定・次へ'; Wait-Idle $window
    Approve-And-Capture $window
    Save-OwnedWindow $window 'portable-retaken.png'
    Invoke-Control $window '決定・次へ'; Wait-Idle $window
    Invoke-Control $window '決定・次へ'; Wait-Idle $window
    Invoke-Control $window '保存先を選ぶ…'
    $retakenZip = Join-Path $portable 'anonymous-retaken.zip'
    [void](& (Join-Path $PSScriptRoot 'drive-owned-save-dialog.ps1') -OwnerPid $nodePid -Action select -Destination $retakenZip)
    Wait-Idle $window
    if (Test-Path $retakenZip) { throw 'Retaken path selection exported early.' }
    Invoke-Control $window '決定・次へ'; Wait-Idle $window
    if (-not (Test-Path $retakenZip) -or (Get-FileHash $destination).Hash -ne $archiveHash) { throw 'Retaken ZIP or previous output protection failed.' }
    Save-OwnedWindow $window 'portable-retaken-zip.png'
    Close-Owned $sample
    $receipt = [ordered]@{ executableSha256 = $hash; anonymousPortable = $true; publicEntrypoint = 'fixed-name Portable / UIAutomation';
        firstCaptureCount = $firstCount; retakenCount = @((Get-Manifest).images).Count; nativeDialog = $cancelled;
        nativeSelection = $selectedDialog; sameNameDistinctFoldersSaved = $true; resetCancelKeepAndConsent = $true; zipPreserved = $true; retakenZipSaved = $true;
        measuredPendingProgress = $pendingProgress; measuredWaitStayedFixed = $true; wholeStepProgress = $wholeProgress;
        navigationOperationWait = $navigationProgress; resetDecisionWait = $resetDecisionProgress; nativeLanguages = $nativeLanguages;
        userDataOpened = $false; realBookAcquisition = $false; authenticationPerformed = $false;
        samplePublicUiPreview = $info; elapsedSeconds = [math]::Round($watch.Elapsed.TotalSeconds, 3) }
    $output = Join-Path $evidence 'result.json'
    [IO.File]::WriteAllText($output, ($receipt | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
    $receipt | ConvertTo-Json -Depth 6
    Write-Output ('Evidence: ' + [IO.Path]::GetRelativePath($root, $output))
} catch {
    if ($window) {
        Save-OwnedWindow $window 'portable-failure.png'
        Get-Elements $window | Where-Object { -not $_.Current.IsOffscreen -and $_.Current.Name } | Select-Object -First 90 | ForEach-Object { Write-Host ($_.Current.ControlType.ProgrammaticName + ': ' + $_.Current.Name) }
    }
    throw
} finally {
    foreach ($run in $runs) { if (-not $run.Process.HasExited) { Close-Owned $run }; $run.Process.Dispose() }
}
