# Exports only an explicitly rebuilt historical deck; never overwrites preserved originals.
param([string]$Deck = (Join-Path $PSScriptRoot '..\Eldhall-Pitch-ARCHIVE-2026-10-31-REBUILT.pptx'))
$deck = (Resolve-Path $Deck).Path
$pdf = [IO.Path]::ChangeExtension($deck, '.pdf')
if ([IO.Path]::GetFileName($deck) -ne 'Eldhall-Pitch-ARCHIVE-2026-10-31-REBUILT.pptx') { throw 'Only the dated archival rebuild may be exported by this helper' }
if (Test-Path -LiteralPath $pdf) { throw 'Refusing to overwrite an existing PDF' }
$app = New-Object -ComObject PowerPoint.Application
try {
  # MsoTriState: -1 = true, 0 = false → read-only, not untitled, no window
  $presentation = $app.Presentations.Open($deck, -1, 0, 0)
  $presentation.SaveAs($pdf, 32)  # ppSaveAsPDF
  $presentation.Close()
  Write-Output "wrote $pdf"
} finally {
  $app.Quit()
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app)
}
