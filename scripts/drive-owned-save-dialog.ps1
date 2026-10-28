param([Parameter(Mandatory)][int]$OwnerPid, [ValidateSet('select','cancel')][string]$Action = 'cancel', [string]$Destination = '', [string]$Screenshot = '')
$ErrorActionPreference = 'Stop'
$watch = [Diagnostics.Stopwatch]::StartNew()
$timings = [ordered]@{}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public static class OwnedDialogCapture {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  private delegate bool EnumProc(IntPtr hwnd, IntPtr param);
  [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr hwnd, EnumProc callback, IntPtr param);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int size);
  [DllImport("user32.dll")] private static extern int GetDlgCtrlID(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, IntPtr wparam, StringBuilder text, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, IntPtr wparam, string text, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, IntPtr wparam, IntPtr lparam, uint flags, uint timeout, out IntPtr result);
  public static int ControlId(IntPtr hwnd) { return GetDlgCtrlID(hwnd); }
  public static string ReadText(IntPtr hwnd) {
    var text = new StringBuilder(32768);
    IntPtr result;
    if (SendMessageTimeout(hwnd, 0x000D, (IntPtr)text.Capacity, text, 2, 1000, out result) == IntPtr.Zero) throw new Exception("Owned edit read timed out.");
    return text.ToString();
  }
  public static void SetText(IntPtr hwnd, string text) {
    IntPtr result;
    if (SendMessageTimeout(hwnd, 0x000C, IntPtr.Zero, text, 2, 1000, out result) == IntPtr.Zero || result == IntPtr.Zero) throw new Exception("Owned edit write failed.");
    // Some shell providers update the displayed edit without notifying the
    // dialog's selected-name model. Deliver the edit's normal EN_CHANGE to
    // its own parent, never keyboard/mouse input to the desktop.
    IntPtr command = (IntPtr)((0x0300 << 16) | (GetDlgCtrlID(hwnd) & 0xffff));
    if (SendMessageTimeout(GetParent(hwnd), 0x0111, command, hwnd, 2, 1000, out result) == IntPtr.Zero) throw new Exception("Owned edit notification timed out.");
  }
  public static void Click(IntPtr hwnd) {
    IntPtr result;
    if (SendMessageTimeout(hwnd, 0x00F5, IntPtr.Zero, IntPtr.Zero, 2, 1000, out result) == IntPtr.Zero) throw new Exception("Owned button invocation timed out.");
  }
  public static string[] ChildStructure(IntPtr hwnd) {
    var result = new List<string>();
    EnumChildWindows(hwnd, (child, _) => {
      var name = new StringBuilder(256);
      GetClassName(child, name, name.Capacity);
      result.Add(GetDlgCtrlID(child) + ":" + name);
      return true;
    }, IntPtr.Zero);
    return result.ToArray();
  }
  public static IntPtr[] FilenameEdits(IntPtr hwnd) {
    var result = new List<IntPtr>();
    EnumChildWindows(hwnd, (child, _) => {
      var name = new StringBuilder(256);
      GetClassName(child, name, name.Capacity);
      int id = GetDlgCtrlID(child);
      if (name.ToString() == "Edit" && (id == 1001 || id == 1148 || id == 1152)) result.Add(child);
      return true;
    }, IntPtr.Zero);
    return result.ToArray();
  }
  public static IntPtr[] ActionButtons(IntPtr hwnd, int id) {
    var result = new List<IntPtr>();
    EnumChildWindows(hwnd, (child, _) => {
      var name = new StringBuilder(256);
      GetClassName(child, name, name.Capacity);
      if (name.ToString() == "Button" && GetDlgCtrlID(child) == id) result.Add(child);
      return true;
    }, IntPtr.Zero);
    return result.ToArray();
  }
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
$timings.windowFound = $watch.ElapsedMilliseconds
[Console]::Error.WriteLine('KTZ_DIALOG:owned_window_found')
$file = $null
$readyDeadline = [DateTime]::UtcNow.AddSeconds(8)
do {
    $edits = $window.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Edit))
    # Vista-style dialogs expose 1001; classic common dialogs expose the
    # filename combo's edit as 1148 (or edt1 / 1152 on older variants).
    # Never fall back to an arbitrary edit (for example the search/address box).
    $matches = @($edits | Where-Object {
        $_.Current.AutomationId -in @('1001', '1148', '1152') -and -not $_.Current.IsOffscreen -and $_.Current.IsEnabled
    })
    if ($matches.Count -eq 1) { $file = $matches[0] }
    if ($matches.Count -eq 0) {
        # A cold classic dialog may have real child HWNDs before its root UIA
        # provider exposes descendants. Resolve only its unique known Edit.
        $handles = [OwnedDialogCapture]::FilenameEdits([IntPtr]$window.Current.NativeWindowHandle)
        if ($handles.Count -eq 1) {
            $candidate = [Windows.Automation.AutomationElement]::FromHandle($handles[0])
            if ($candidate.Current.ProcessId -eq $window.Current.ProcessId -and -not $candidate.Current.IsOffscreen -and $candidate.Current.IsEnabled) { $file = $candidate }
        }
    }
    if (-not $file) { Start-Sleep -Milliseconds 100 }
} while (-not $file -and [DateTime]::UtcNow -lt $readyDeadline)
if (-not $file) {
    $ids = @($edits | ForEach-Object { $_.Current.AutomationId }) -join ','
    $structure = [OwnedDialogCapture]::ChildStructure([IntPtr]$window.Current.NativeWindowHandle) -join ','
    throw "Native filename edit not found or ambiguous (edit IDs: $ids; native structure: $structure)."
}
$nativeEdits = [OwnedDialogCapture]::FilenameEdits([IntPtr]$window.Current.NativeWindowHandle)
$fileHandle = if ($nativeEdits.Count -eq 1) { $nativeEdits[0] } else { [IntPtr]::Zero }
$value = $null
if ($fileHandle -ne [IntPtr]::Zero) {
    $filenameEditId = [string][OwnedDialogCapture]::ControlId($fileHandle)
    $initial = [OwnedDialogCapture]::ReadText($fileHandle)
} else {
    $value = $file.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
    $filenameEditId = $file.Current.AutomationId
    $initial = $value.Current.Value
}
$timings.filenameRead = $watch.ElapsedMilliseconds
[Console]::Error.WriteLine('KTZ_DIALOG:filename_read')
function Save-OwnedDialogScreenshot([string]$Path) {
    $bounds = $window.Current.BoundingRectangle
    $bitmap = [Drawing.Bitmap]::new([int]$bounds.Width, [int]$bounds.Height)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $hdc = $graphics.GetHdc()
    try { if (-not [OwnedDialogCapture]::PrintWindow([IntPtr]$window.Current.NativeWindowHandle, $hdc, 2)) { throw 'PrintWindow failed.' } }
    finally { $graphics.ReleaseHdc($hdc); $graphics.Dispose() }
    try { $bitmap.Save($Path, [Drawing.Imaging.ImageFormat]::Png) } finally { $bitmap.Dispose() }
}
if ($Screenshot) { Save-OwnedDialogScreenshot $Screenshot }
function Set-OwnedControlFocus($Control) {
    $Control.SetFocus()
    $focusDeadline = [DateTime]::UtcNow.AddSeconds(2)
    while (-not $Control.Current.HasKeyboardFocus -and [DateTime]::UtcNow -lt $focusDeadline) { Start-Sleep -Milliseconds 50 }
    if (-not $Control.Current.HasKeyboardFocus) { throw 'Owned dialog control did not receive focus.' }
}
if ($Action -eq 'select') {
    if ($fileHandle -ne [IntPtr]::Zero) {
        [OwnedDialogCapture]::SetText($fileHandle, $Destination)
        if ([OwnedDialogCapture]::ReadText($fileHandle) -ne $Destination) { throw 'Native filename edit did not retain the selected destination.' }
    } else {
        Set-OwnedControlFocus $file
        $value.SetValue($Destination)
        if ($value.Current.Value -ne $Destination) { throw 'Native filename edit did not retain the selected destination.' }
    }
}
$buttonId = if ($Action -eq 'select') { '1' } else { '2' }
$buttonCondition = [Windows.Automation.AndCondition]::new(
    [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty, $buttonId),
    [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Button))
$button = $window.FindAll([Windows.Automation.TreeScope]::Descendants, $buttonCondition) | Where-Object {
    -not $_.Current.IsOffscreen -and $_.Current.IsEnabled -and $(if ($Action -eq 'select') { $_.Current.Name -match '^(Save|保存)' } else { $_.Current.Name -match '^(Cancel|キャンセル)' })
} | Select-Object -First 1
if (-not $button) {
    $handles = [OwnedDialogCapture]::ActionButtons([IntPtr]$window.Current.NativeWindowHandle, [int]$buttonId)
    if ($handles.Count -eq 1) {
        $candidate = [Windows.Automation.AutomationElement]::FromHandle($handles[0])
        if ($candidate.Current.ProcessId -eq $window.Current.ProcessId -and -not $candidate.Current.IsOffscreen -and $candidate.Current.IsEnabled -and
            $(if ($Action -eq 'select') { $candidate.Current.Name -match '^(Save|保存)' } else { $candidate.Current.Name -match '^(Cancel|キャンセル)' })) { $button = $candidate }
    }
}
if (-not $button) { throw 'Native dialog action not found.' }
$invokedName = $button.Current.Name
$dialogPid = $window.Current.ProcessId
$timings.beforeInvoke = $watch.ElapsedMilliseconds
[Console]::Error.WriteLine('KTZ_DIALOG:invoking_owned_button')
# Commit the filename edit through a normal focus change. The upgraded shell
# can otherwise return its old selected name even though ValuePattern changed.
if ($Action -eq 'select' -and $fileHandle -eq [IntPtr]::Zero) { Set-OwnedControlFocus $button }
$invoke = $null
if ($button.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) { $invoke.Invoke() }
else {
    $nativeButtons = [OwnedDialogCapture]::ActionButtons([IntPtr]$window.Current.NativeWindowHandle, [int]$buttonId)
    if ($nativeButtons.Count -ne 1) { throw 'Owned native dialog action is unavailable or ambiguous.' }
    [OwnedDialogCapture]::Click($nativeButtons[0])
}
$exitDeadline = [DateTime]::UtcNow.AddSeconds(8)
while ((Get-Process -Id $dialogPid -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $exitDeadline) { Start-Sleep -Milliseconds 100 }
if (Get-Process -Id $dialogPid -ErrorAction SilentlyContinue) {
    if ($Screenshot) { Save-OwnedDialogScreenshot ($Screenshot + '.failure.png') }
    throw 'Owned native dialog did not finish after its public button.'
}
$timings.hostExited = $watch.ElapsedMilliseconds
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
@{ initialFilename = $initial; filenameEditId = $filenameEditId; action = $Action; invokedButton = $invokedName; nativeWindowFound = $true; osInputOrClipboardUsed = $false; timingsMs = $timings } | ConvertTo-Json -Compress
