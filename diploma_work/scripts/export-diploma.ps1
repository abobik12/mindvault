$ErrorActionPreference = "Stop"

$Root = "D:\Univer\AI-Workspace-Hub\diploma_work"
$FinalDir = Join-Path $Root "final"
$CountsPath = Join-Path $FinalDir "counts.json"
$NamesPath = Join-Path $FinalDir "output-names.json"

$Counts = Get-Content -LiteralPath $CountsPath -Encoding UTF8 | ConvertFrom-Json
$Names = Get-Content -LiteralPath $NamesPath -Encoding UTF8 | ConvertFrom-Json
$DocxPath = Join-Path $FinalDir $Names.docx
$PdfPath = Join-Path $FinalDir $Names.pdf

function Replace-WordText {
  param(
    [Parameter(Mandatory = $true)] $Document,
    [Parameter(Mandatory = $true)] [string] $FindText,
    [Parameter(Mandatory = $true)] [string] $ReplaceText
  )

  $range = $Document.Content
  $find = $range.Find
  [void] $find.ClearFormatting()
  [void] $find.Replacement.ClearFormatting()
  $find.Text = $FindText
  $find.Replacement.Text = $ReplaceText
  $find.Forward = $true
  $find.Wrap = 1
  [void] $find.Execute($FindText, $false, $false, $false, $false, $false, $true, 1, $false, $ReplaceText, 2)
}

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0

try {
  $doc = $word.Documents.Open($DocxPath)

  foreach ($toc in $doc.TablesOfContents) {
    [void] $toc.Update()
  }
  [void] $doc.Fields.Update()
  [void] $doc.Repaginate()

  $pageCount = $doc.ComputeStatistics(2)
  Replace-WordText -Document $doc -FindText "__PAGE_COUNT__" -ReplaceText ([string] $pageCount)
  Replace-WordText -Document $doc -FindText "__TABLE_COUNT__" -ReplaceText ([string] $Counts.tables)
  Replace-WordText -Document $doc -FindText "__FIGURE_COUNT__" -ReplaceText ([string] $Counts.figures)
  Replace-WordText -Document $doc -FindText "__SOURCE_COUNT__" -ReplaceText ([string] $Counts.sources)

  foreach ($toc in $doc.TablesOfContents) {
    [void] $toc.Update()
  }
  [void] $doc.Fields.Update()
  [void] $doc.Repaginate()
  $pageCount = $doc.ComputeStatistics(2)
  Replace-WordText -Document $doc -FindText ([string] "__PAGE_COUNT__") -ReplaceText ([string] $pageCount)

  if (Test-Path -LiteralPath $PdfPath) { Remove-Item -LiteralPath $PdfPath -Force }

  [void] $doc.Save()
  [void] $doc.ExportAsFixedFormat($PdfPath, 17)
  $doc.Close($false)

  [pscustomobject]@{
    Docx = $DocxPath
    Pdf = $PdfPath
    Pages = $pageCount
    Tables = $Counts.tables
    Figures = $Counts.figures
    Sources = $Counts.sources
  } | ConvertTo-Json -Depth 3
}
finally {
  if ($doc -ne $null) {
    try { $doc.Close($false) } catch {}
  }
  $word.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
}
