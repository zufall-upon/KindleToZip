param([Parameter(Mandatory)][int]$ReaderProcessId, [switch]$Open, [ValidateSet('ListItem', 'Group')][string]$TargetControl = 'ListItem')
$ErrorActionPreference = 'Stop'
$watch = [Diagnostics.Stopwatch]::StartNew()
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$targetDigest = 'bc07c3ce5582b105e3a7f5eb4912b72c7100fb32847695776ee01415db7dabd3'
$condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ReaderProcessId)
$window = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)
if (!$window) { throw 'reader_window_not_found' }
$sha = [Security.Cryptography.SHA256]::Create()
try {
  do {
  $all = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  if (@($all | Where-Object { $_.Current.IsPassword }).Count) { throw 'authentication_boundary' }
  $candidates = @($all | Where-Object {
    $element = $_
    $expectedType = if ($TargetControl -eq 'Group') { [System.Windows.Automation.ControlType]::Group } else { [System.Windows.Automation.ControlType]::ListItem }
    if ($element.Current.ControlType -ne $expectedType -or $element.Current.IsOffscreen -or !$element.Current.IsEnabled) { return $false }
    foreach ($match in [regex]::Matches($element.Current.AutomationId, '(?i)(?<![a-z0-9])[a-z0-9]{10}(?![a-z0-9])')) {
      $hash = [Convert]::ToHexString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($match.Value.Trim().ToUpperInvariant()))).ToLowerInvariant()
      if ($hash -eq $targetDigest) { return $true }
    }
    return $false
  })
  if ($candidates.Count -gt 0) { break }
  Start-Sleep -Milliseconds 200
  } while ($watch.ElapsedMilliseconds -lt 10000)
} finally { $sha.Dispose() }
if ($candidates.Count -ne 1) { throw 'target_not_unique_visible_card' }
$invoke = $null
if (!$candidates[0].TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) { throw 'target_public_invoke_unavailable' }
if ($Open) { $invoke.Invoke() }
[ordered]@{ matchingVisibleCards = $candidates.Count; targetControl = $TargetControl; publicInvokeAvailable = $true; invoked = [bool]$Open; elapsedMs = $watch.ElapsedMilliseconds } | ConvertTo-Json -Compress
