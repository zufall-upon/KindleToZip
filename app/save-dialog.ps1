$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$request = [Console]::ReadLine() | ConvertFrom-Json
if ($request.format -notin @('zip', 'cbz')) { exit 2 }
Add-Type -AssemblyName System.Windows.Forms
$dialog = [System.Windows.Forms.SaveFileDialog]::new()
try {
    $dialog.Title = 'KindleToZip - Choose save destination (selection only)'
    $dialog.Filter = if ($request.format -eq 'cbz') { 'Comic Book ZIP (*.cbz)|*.cbz' } else { 'ZIP archive (*.zip)|*.zip' }
    $dialog.DefaultExt = $request.format
    $dialog.AddExtension = $true
    $dialog.OverwritePrompt = $false # The exporter independently refuses existing files.
    $dialog.RestoreDirectory = $true
    $dialog.FileName = [IO.Path]::GetFileName($request.destination)
    $directory = [IO.Path]::GetDirectoryName($request.destination)
    if ([IO.Directory]::Exists($directory)) { $dialog.InitialDirectory = $directory }
    $result = if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.FileName } else { $null }
    if ($null -eq $result) { [Console]::WriteLine('null') }
    else { [Console]::WriteLine((ConvertTo-Json -InputObject $result -Compress)) }
} finally { $dialog.Dispose() }
