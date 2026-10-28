param(
    [string]$Executable = '',
    [switch]$LatestPortable
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if ($LatestPortable -and $Executable) { throw 'Specify either -LatestPortable or -Executable, not both.' }
if (-not $LatestPortable -and -not $Executable) { throw 'Specify -LatestPortable or an exact -Executable path.' }

if ($LatestPortable) {
    . (Join-Path $PSScriptRoot 'portable-reports.ps1')
    $selected = Get-LatestPortableReport $root
    $exe = $selected.Executable
    $report = $selected.Report
    $selection = '-LatestPortable'
} else {
    $exe = (Resolve-Path -LiteralPath (Join-Path $root $Executable)).Path
    $report = Get-Content -LiteralPath ([IO.Path]::ChangeExtension($exe, '.json')) -Raw -Encoding utf8 | ConvertFrom-Json
    $selection = '-Executable'
}
if ($report.portable -ne $true) { throw 'Selected package is not reported as a Portable EXE.' }
$hash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
if ($hash -ne $report.executableSha256) { throw 'EXE SHA-256 does not match its build report.' }

$run = Join-Path $root ('artifacts/distribution-tests/window-' + [guid]::NewGuid().ToString('N').Substring(0, 12))
[IO.Directory]::CreateDirectory($run) | Out-Null
$portable = Join-Path $run 'Portable 操作画面 with spaces'
[IO.Directory]::CreateDirectory($portable) | Out-Null
# Model a removable/shared placement instead of relying on the developer's
# normally private profile directory. Limit this grant to the disposable copy.
$icacls = Join-Path $env:SystemRoot 'System32/icacls.exe'
& $icacls $portable /grant '*S-1-1-0:(OI)(CI)M' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not prepare the shared-parent ACL fixture.' }
$portableExe = Join-Path $portable ([IO.Path]::GetFileName($exe))
[IO.File]::Copy($exe, $portableExe)
if ((Get-FileHash -LiteralPath $portableExe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash) { throw 'Portable test copy SHA-256 mismatch.' }
$redirect = Join-Path $run '外部保存先は禁止'
$legacyHome = Join-Path $redirect 'legacy-portable-home'
$legacyData = Join-Path $redirect 'legacy-user-data'
$legacyTemp = Join-Path $redirect 'legacy-app-temp'
$legacyRuntime = Join-Path $redirect 'legacy-runtime'
$fakeLocalAppData = Join-Path $redirect 'local-app-data'
$fakeAppData = Join-Path $redirect 'roaming-app-data'
$fakeProfile = Join-Path $redirect 'user-profile'
$fakeTemp = Join-Path $redirect 'windows-temp'
foreach ($directory in @($fakeLocalAppData, $fakeAppData, $fakeProfile, $fakeTemp)) {
    [IO.Directory]::CreateDirectory($directory) | Out-Null
}

# Inspect and close only visible windows owned by the launched process tree.
# No foreground activation, global input, or windows from other applications.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class KtzWindowProbe {
    public sealed class Window {
        public IntPtr Handle;
        public uint ProcessId;
        public string Title;
    }
    private delegate bool EnumProc(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int size);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    public static Window[] Find(uint[] processIds) {
        var owners = new HashSet<uint>(processIds);
        var found = new List<Window>();
        EnumWindows((window, parameter) => {
            uint id;
            GetWindowThreadProcessId(window, out id);
            if (owners.Contains(id) && IsWindowVisible(window)) {
                var title = new StringBuilder(2048);
                GetWindowText(window, title, title.Capacity);
                found.Add(new Window { Handle = window, ProcessId = id, Title = title.ToString() });
            }
            return true;
        }, IntPtr.Zero);
        return found.ToArray();
    }
    public static bool Close(Window window) {
        uint owner;
        GetWindowThreadProcessId(window.Handle, out owner);
        return owner == window.ProcessId && PostMessage(window.Handle, 0x0010, IntPtr.Zero, IntPtr.Zero);
    }
}
'@

function Get-OwnedProcessIds([int]$RootId) {
    $all = @(Get-CimInstance -Query 'SELECT ProcessId, ParentProcessId FROM Win32_Process')
    $owned = [Collections.Generic.HashSet[uint32]]::new()
    [void]$owned.Add([uint32]$RootId)
    do {
        $added = $false
        foreach ($item in $all) {
            if ($owned.Contains([uint32]$item.ParentProcessId) -and $owned.Add([uint32]$item.ProcessId)) { $added = $true }
        }
    } while ($added)
    return [uint32[]]@($owned)
}

function Assert-RedirectsUnused {
    foreach ($directory in @($legacyHome, $legacyData, $legacyTemp, $legacyRuntime, (Join-Path $redirect 'external-browsers'))) {
        if (Test-Path -LiteralPath $directory) { throw "Legacy or redirected app path was created: $directory" }
    }
    foreach ($directory in @($fakeLocalAppData, $fakeAppData, $fakeProfile, $fakeTemp)) {
        if (@(Get-ChildItem -LiteralPath $directory -Force).Count -ne 0) { throw "Packaged app wrote outside the portable tree: $directory" }
    }
}

function Assert-PrivatePortablePath([string]$Path, [switch]$ProtectedRoot) {
    $acl = Get-Acl -LiteralPath $Path
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($ProtectedRoot -and -not $acl.AreAccessRulesProtected) { throw "Portable private root inherits the shared parent's ACL: $Path" }
    $allow = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object AccessControlType -eq Allow)
    if ($allow.Count -eq 0 -or @($allow | Where-Object { $_.IdentityReference.Value -ne $sid }).Count -ne 0) {
        throw "Portable runtime/temp grants access to another Windows principal: $Path"
    }
}

$systemRoot = $env:SystemRoot
if (-not $systemRoot) { $systemRoot = 'C:\Windows' }
$start = [Diagnostics.ProcessStartInfo]::new($portableExe)
$start.WorkingDirectory = $run
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.StandardOutputEncoding = [Text.Encoding]::UTF8
$start.StandardErrorEncoding = [Text.Encoding]::UTF8
foreach ($key in @($start.Environment.Keys)) {
    if ($key -match '^(NODE_OPTIONS|NODE_PATH|RUSTUP_HOME|RUSTUP_TOOLCHAIN|CARGO_HOME|CARGO_TARGET_DIR|KTZ_CONTROLLER_PATH|PLAYWRIGHT_BROWSERS_PATH|PATH)$') { [void]$start.Environment.Remove($key) }
}
$start.Environment['PATH'] = Join-Path $systemRoot 'System32'
$start.Environment['KTZ_PORTABLE_HOME'] = $legacyHome
$start.Environment['KTZ_USER_DATA_DIR'] = $legacyData
$start.Environment['KTZ_TEMP_DIR'] = $legacyTemp
$start.Environment['KTZ_RUNTIME_DIR'] = $legacyRuntime
$start.Environment['LOCALAPPDATA'] = $fakeLocalAppData
$start.Environment['APPDATA'] = $fakeAppData
$start.Environment['USERPROFILE'] = $fakeProfile
$start.Environment['HOME'] = $fakeProfile
$start.Environment['TEMP'] = $fakeTemp
$start.Environment['TMP'] = $fakeTemp
$start.Environment['TMPDIR'] = $fakeTemp
$start.Environment['PLAYWRIGHT_BROWSERS_PATH'] = Join-Path $redirect 'external-browsers'

$watch = [Diagnostics.Stopwatch]::StartNew()
$process = $null
$succeeded = $false
try {
    $process = [Diagnostics.Process]::Start($start)
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $window = $null
    while ($watch.Elapsed.TotalSeconds -lt 90 -and -not $process.HasExited) {
        $owners = Get-OwnedProcessIds $process.Id
        $window = [KtzWindowProbe]::Find($owners) | Where-Object { $_.Title -match 'KindleToZip.*手順ガイド' } | Select-Object -First 1
        if ($window) { break }
        Start-Sleep -Milliseconds 400
    }
    if (-not $window) { throw 'The normal packaged entrypoint did not open its visible control window within 90 seconds.' }
    $openedSeconds = [math]::Round($watch.Elapsed.TotalSeconds, 3)
    foreach ($name in @('runtime', 'data', 'temp')) {
        if (-not (Test-Path -LiteralPath (Join-Path $portable $name) -PathType Container)) { throw "Portable default $name directory was not created beside the copied EXE." }
    }
    $tempRoot = Join-Path $portable 'temp'
    $tempItems = @(Get-ChildItem -LiteralPath $tempRoot -Force)
    $tempProfiles = @($tempItems | Where-Object { $_.PSIsContainer -and $_.Name -like 'playwright_chromiumdev_profile-*' })
    if ($tempProfiles.Count -eq 0) { throw 'The control-window Chromium temporary profile was not observed below the portable temp directory.' }
    foreach ($name in @('runtime', 'temp')) { Assert-PrivatePortablePath (Join-Path $portable $name) -ProtectedRoot }
    $runtimeVersion = Get-ChildItem -LiteralPath (Join-Path $portable 'runtime') -Directory | Where-Object Name -NotLike '.staging-*' | Select-Object -First 1
    Assert-PrivatePortablePath (Join-Path $runtimeVersion.FullName 'app/main.mjs')
    Assert-PrivatePortablePath (Join-Path $runtimeVersion.FullName 'node/node.exe')
    foreach ($profile in $tempProfiles) { Assert-PrivatePortablePath $profile.FullName }
    if (@($tempItems | Where-Object { -not $_.FullName.StartsWith($tempRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) }).Count -ne 0) { throw 'The control-window temporary profile or cache escaped the portable temp directory.' }
    if (Test-Path -LiteralPath (Join-Path $portable 'data/jobs')) { throw 'Default launch unexpectedly created a book job.' }
    if (@(Get-ChildItem -LiteralPath (Join-Path $portable 'data') -Directory | Where-Object Name -Match '^(saved|temporary)-').Count -ne 0) { throw 'Default launch unexpectedly opened a reader session.' }
    Assert-RedirectsUnused

    # Allow the page to settle, then close exactly its own window normally.
    Start-Sleep -Seconds 2
    if (-not [KtzWindowProbe]::Close($window)) { throw 'Could not request a normal close of the owned control window.' }
    if (-not $process.WaitForExit(40000)) { throw 'The packaged process did not exit after its control window closed.' }
    if (-not $stdout.Wait(10000) -or -not $stderr.Wait(10000)) { throw 'Packaged child processes did not release their output streams.' }
    $out = $stdout.Result
    $err = $stderr.Result
    if ($process.ExitCode -ne 0) { throw "Normal EXE launch/close failed (exit $($process.ExitCode)).`n$out`n$err" }
    if (-not $out.Contains('操作画面を拡張なしの専用ウィンドウで開きました。')) { throw "Normal app/main.mjs startup confirmation was missing.`n$out`n$err" }
    $remainingTemp = @(Get-ChildItem -LiteralPath $tempRoot -Force)
    if (@($remainingTemp | Where-Object { $_.PSIsContainer -and $_.Name -like 'playwright_chromiumdev_profile-*' }).Count -ne 0) { throw 'The control-window temporary profile was not removed after normal close.' }
    if (Test-Path -LiteralPath (Join-Path $portable 'data/jobs')) { throw 'Normal window startup created a book job.' }
    Assert-RedirectsUnused
    $watch.Stop()
    $receipt = [ordered]@{
        command = if ($LatestPortable) { 'pwsh -NoProfile -File scripts/test-distribution-window.ps1 -LatestPortable' } else { "pwsh -NoProfile -File scripts/test-distribution-window.ps1 -Executable `"$Executable`"" }
        selection = $selection
        executable = $report.executablePath
        executableSha256 = $hash
        copiedIntoPortableTestTree = $true
        portableTestTree = [IO.Path]::GetRelativePath($root, $portable).Replace('\', '/')
        arguments = @()
        entrypoint = 'app/main.mjs'
        visibleOwnedWindow = $window.Title
        normalWindowClose = $true
        developerPathToolsAvailable = $false
        redirectedLegacyAndProfilePathsUnused = $true
        controlWindowTempObservedBelowPortableTree = $true
        controlWindowTempRemovedAfterClose = $true
        controlWindowCacheStayedBelowPortableTree = $true
        sharedParentAclFixture = $true
        runtimeAndTempCurrentUserOnly = $true
        cleanWindowsTested = $false
        bookJobCreated = $false
        readerSessionOpened = $false
        startupSeconds = $openedSeconds
        elapsedSeconds = [math]::Round($watch.Elapsed.TotalSeconds, 3)
        exitCode = $process.ExitCode
        observedAtUtc = [DateTime]::UtcNow.ToString('o')
    }
    $result = Join-Path $run 'window-result.json'
    [IO.File]::WriteAllText($result, ($receipt | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
    $succeeded = $true
    Write-Output ($receipt | ConvertTo-Json -Depth 4)
    Write-Output ('Evidence: ' + [IO.Path]::GetRelativePath($root, $result).Replace('\', '/'))
} finally {
    if ($process -and -not $process.HasExited) { $process.Kill($true); $process.WaitForExit(10000) | Out-Null }
    if ($process) { $process.Dispose() }
    if ($succeeded) {
        Remove-Item -LiteralPath $portable -Recurse -Force
        Remove-Item -LiteralPath $redirect -Recurse -Force
    } else {
        Write-Output ('Portable window test workspace retained for diagnosis: ' + [IO.Path]::GetRelativePath($root, $run).Replace('\', '/'))
    }
}
