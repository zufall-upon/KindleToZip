param([Parameter(Mandatory)][int]$OwnerPid, [ValidateSet('select','cancel')][string]$Action = 'cancel', [string]$Destination = '', [string]$Screenshot = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class OwnedDialogCapture {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
}
'@
$deadline = [DateTime]::UtcNow.AddSeconds(15)
$window = $null
while (-not $window -and [DateTime]::UtcNow -lt $deadline) {
    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $OwnerPid" | Where-Object Name -eq 'powershell.exe')
    foreach ($child in $children) {
        $condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$child.ProcessId)
        $windows = [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children, $condition)
        foreach ($candidate in $windows) {
            if ($candidate.Current.Name -eq 'KindleToZip - Choose save destination (selection only)') { $window = $candidate; break }
        }
    }
    if (-not $window) { Start-Sleep -Milliseconds 100 }
}
if (-not $window) { throw 'Owned native save dialog did not appear.' }
$file = $null
$readyDeadline = [DateTime]::UtcNow.AddSeconds(8)
do {
    $edits = $window.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Edit))
    foreach ($edit in $edits) { if ($edit.Current.AutomationId -eq '1001') { $file = $edit; break } }
    if (-not $file) { Start-Sleep -Milliseconds 100 }
} while (-not $file -and [DateTime]::UtcNow -lt $readyDeadline)
if (-not $file) { throw 'Native filename edit not found.' }
$value = $file.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
$initial = $value.Current.Value
if ($Screenshot) {
    $bounds = $window.Current.BoundingRectangle
    $bitmap = [Drawing.Bitmap]::new([int]$bounds.Width, [int]$bounds.Height)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $hdc = $graphics.GetHdc()
    try { if (-not [OwnedDialogCapture]::PrintWindow([IntPtr]$window.Current.NativeWindowHandle, $hdc, 2)) { throw 'PrintWindow failed.' } }
    finally { $graphics.ReleaseHdc($hdc); $graphics.Dispose() }
    try { $bitmap.Save($Screenshot, [Drawing.Imaging.ImageFormat]::Png) } finally { $bitmap.Dispose() }
}
if ($Action -eq 'select') { $value.SetValue($Destination) }
$buttonId = if ($Action -eq 'select') { '1' } else { '2' }
$buttonCondition = [Windows.Automation.AndCondition]::new(
    [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty, $buttonId),
    [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Button))
$button = $window.FindAll([Windows.Automation.TreeScope]::Descendants, $buttonCondition) | Where-Object {
    -not $_.Current.IsOffscreen -and $_.Current.IsEnabled -and $(if ($Action -eq 'select') { $_.Current.Name -match '^(Save|保存)' } else { $_.Current.Name -match '^(Cancel|キャンセル)' })
} | Select-Object -First 1
if (-not $button) { throw 'Native dialog action not found.' }
$invokedName = $button.Current.Name
$dialogPid = $window.Current.ProcessId
$button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
$exitDeadline = [DateTime]::UtcNow.AddSeconds(8)
while ((Get-Process -Id $dialogPid -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $exitDeadline) { Start-Sleep -Milliseconds 100 }
if (Get-Process -Id $dialogPid -ErrorAction SilentlyContinue) { throw 'Owned native dialog did not finish after its public button.' }
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
@{ initialFilename = $initial; action = $Action; invokedButton = $invokedName; nativeWindowFound = $true; osInputOrClipboardUsed = $false } | ConvertTo-Json -Compress
