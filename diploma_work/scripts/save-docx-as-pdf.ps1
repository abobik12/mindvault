$ErrorActionPreference = "Stop"

$Root = "D:\Univer\AI-Workspace-Hub\diploma_work"
$FinalDir = Join-Path $Root "final"
$Names = Get-Content -LiteralPath (Join-Path $FinalDir "output-names.json") -Encoding UTF8 | ConvertFrom-Json
$DocxPath = Join-Path $FinalDir $Names.docx
$PdfPath = Join-Path $FinalDir $Names.pdf

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0

try {
  $doc = $word.Documents.Open($DocxPath, $false, $true)
  if (Test-Path -LiteralPath $PdfPath) { Remove-Item -LiteralPath $PdfPath -Force }
  [void] $doc.SaveAs2($PdfPath, 17)
  $doc.Close($false)
  [pscustomobject]@{
    Pdf = $PdfPath
    Exists = (Test-Path -LiteralPath $PdfPath)
    Length = if (Test-Path -LiteralPath $PdfPath) { (Get-Item -LiteralPath $PdfPath).Length } else { 0 }
  } | ConvertTo-Json -Depth 2
}
finally {
  if ($doc -ne $null) {
    try { $doc.Close($false) } catch {}
  }
  $word.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
}
