# Exports Eldhall-Pitch.pptx to PDF with the installed PowerPoint (fonts embedded).
param([string]$Deck = (Join-Path $PSScriptRoot '..\Eldhall-Pitch.pptx'))
$deck = (Resolve-Path $Deck).Path
$pdf = [IO.Path]::ChangeExtension($deck, '.pdf')
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
