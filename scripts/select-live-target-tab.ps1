param([Parameter(Mandatory)][int]$ControlProcessId, [Parameter(Mandatory)][int]$ReaderProcessId)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
function Get-Window([int]$id) {
  $window = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $id))
  if (!$window) { throw 'window_not_found' }
  return $window
}
$reader = Get-Window $ReaderProcessId
$sha = [Security.Cryptography.SHA256]::Create()
$ready = [Diagnostics.Stopwatch]::StartNew()
try {
  do {
  $documents = @($reader.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document })
  $matched = @($documents | Where-Object {
    $value = $null
    if ($_.Current.IsOffscreen -or !$_.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$value)) { return $false }
    foreach ($match in [regex]::Matches($value.Current.Value, '(?i)(?<![a-z0-9])[a-z0-9]{10}(?![a-z0-9])')) {
      if ([Convert]::ToHexString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($match.Value.ToUpperInvariant()))).ToLowerInvariant() -eq 'bc07c3ce5582b105e3a7f5eb4912b72c7100fb32847695776ee01415db7dabd3') { return $true }
    }
    return $false
  })
  if ($documents.Count -eq 2 -and $matched.Count -eq 1 -and $documents[1] -eq $matched[0]) { break }
  if ($documents.Count -gt 2 -or $matched.Count -gt 1) { throw 'target_document_ambiguous' }
  Start-Sleep -Milliseconds 200
  } while ($ready.ElapsedMilliseconds -lt 10000)
} finally { $sha.Dispose() }
# This bounded helper is for the observed library + newly opened target pair.
# Never infer an arbitrary tab number when the observed layout is different.
if ($documents.Count -ne 2 -or $matched.Count -ne 1 -or $documents[1] -ne $matched[0]) { throw 'expected_library_target_pair_not_observed' }
$control = Get-Window $ControlProcessId
$combo = $control.FindFirst([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'readerTab'))
if (!$combo -or !$combo.Current.IsEnabled) { throw 'tab_selector_unavailable' }
$combo.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand()
$items = @($control.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::ListItem -and $_.Current.Name -match '^専用タブ [0-9]+$' })
if ($items.Count -ne 2 -or $items[1].Current.Name -ne '専用タブ 2') { throw 'expected_two_public_tab_options_not_observed' }
$items[1].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
$combo.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Collapse()
$settled = [Diagnostics.Stopwatch]::StartNew()
do {
  $combo = $control.FindFirst([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'readerTab'))
  if ($combo.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value -eq '専用タブ 2') { break }
  Start-Sleep -Milliseconds 100
} while ($settled.ElapsedMilliseconds -lt 2000)
if ($combo.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value -ne '専用タブ 2') { throw 'public_tab_selection_not_applied' }
[ordered]@{ targetDocumentMatched = $true; publicTabSelected = $true } | ConvertTo-Json -Compress
