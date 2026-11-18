<#
.SYNOPSIS
  Opens Office files in the real desktop application through COM (read-only, hidden)
  and prints one JSON result line per file.

.DESCRIPTION
  Used by tools/lab-builder/validate-office.mjs to prove that generated .pptx/.docx
  files open in real PowerPoint/Word without a corruption error or repair prompt.
  Windows only; requires PowerPoint and/or Word to be installed.

  Safety rules (the user may have their own Office session open):
    - Files are opened read-only and without a window.
    - Only the presentation/document opened here is closed.
    - An application is quit ONLY when this script started it. A pre-existing
      instance is never quit, killed, or reconfigured.
    - Files run in a background job with a no-progress timeout, because a repair or
      password dialog can otherwise block the call forever. After a timeout only
      processes that did not exist before the job started are stopped.

.PARAMETER Path
  One or more .pptx/.docx files.

.PARAMETER TimeoutSeconds
  Seconds without a finished file before the job is abandoned (default 90).
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0, ValueFromRemainingArguments = $true)]
  [string[]]$Path,
  [int]$TimeoutSeconds = 90
)

$ErrorActionPreference = 'Stop'

$pptxBlock = {
  param($files)
  $before = @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  $app = $null
  try {
    $app = New-Object -ComObject PowerPoint.Application
    foreach ($file in $files) {
      $sw = [Diagnostics.Stopwatch]::StartNew()
      $pres = $null
      try {
        # Open(FileName, ReadOnly = msoTrue, Untitled = msoFalse, WithWindow = msoFalse)
        $pres = $app.Presentations.Open($file, -1, 0, 0)
        $slides = [int]$pres.Slides.Count
        $withNotes = 0
        foreach ($slide in $pres.Slides) {
          if (-not $slide.HasNotesPage) { continue }
          foreach ($shape in $slide.NotesPage.Shapes) {
            if ($shape.Type -eq 14 -and $shape.PlaceholderFormat.Type -eq 2 -and $shape.HasTextFrame -and $shape.TextFrame.TextRange.Text.Trim().Length -gt 0) {
              $withNotes += 1
              break
            }
          }
        }
        [pscustomobject]@{ file = $file; ok = $true; slides = $slides; slidesWithNotes = $withNotes; ms = $sw.ElapsedMilliseconds; error = $null }
      }
      catch {
        [pscustomobject]@{ file = $file; ok = $false; slides = 0; slidesWithNotes = 0; ms = $sw.ElapsedMilliseconds; error = ("{0} (0x{1:X8})" -f $_.Exception.Message.Trim(), $_.Exception.HResult) }
      }
      finally {
        if ($pres) { try { $pres.Close() } catch {} }
      }
    }
  }
  finally {
    $created = @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue | ForEach-Object { $_.Id } | Where-Object { $before -notcontains $_ })
    if ($app -and $created.Count -gt 0) { try { $app.Quit() } catch {} }
  }
}

$docxBlock = {
  param($files)
  $before = @(Get-Process -Name WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  $app = $null
  try {
    $app = New-Object -ComObject Word.Application
    $missing = [Type]::Missing
    foreach ($file in $files) {
      $sw = [Diagnostics.Stopwatch]::StartNew()
      $doc = $null
      try {
        # Open(FileName, ConfirmConversions=false, ReadOnly=true, AddToRecentFiles=false, ..., Visible=false, OpenAndRepair=false)
        $doc = $app.Documents.Open($file, $false, $true, $false, $missing, $missing, $false, $missing, $missing, $missing, $missing, $false, $false)
        [pscustomobject]@{ file = $file; ok = $true; paragraphs = [int]$doc.Paragraphs.Count; tables = [int]$doc.Tables.Count; ms = $sw.ElapsedMilliseconds; error = $null }
      }
      catch {
        [pscustomobject]@{ file = $file; ok = $false; paragraphs = 0; tables = 0; ms = $sw.ElapsedMilliseconds; error = ("{0} (0x{1:X8})" -f $_.Exception.Message.Trim(), $_.Exception.HResult) }
      }
      finally {
        if ($doc) { try { $doc.Close($false) } catch {} }
      }
    }
  }
  finally {
    $created = @(Get-Process -Name WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id } | Where-Object { $before -notcontains $_ })
    if ($app -and $created.Count -gt 0) { try { $app.Quit($false) } catch {} }
  }
}

$apps = @{
  '.pptx' = @{ Process = 'POWERPNT'; Block = $pptxBlock }
  '.docx' = @{ Process = 'WINWORD'; Block = $docxBlock }
}

function Get-ProcessIds([string]$name) {
  @(Get-Process -Name $name -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
}

function Write-Result($result) {
  $result | Select-Object * -ExcludeProperty PSComputerName, RunspaceId, PSShowComputerName | ConvertTo-Json -Compress
}

$script:failed = $false

foreach ($ext in @('.pptx', '.docx')) {
  $app = $apps[$ext]
  $files = @($Path | ForEach-Object { [IO.Path]::GetFullPath($_) } | Where-Object { [IO.Path]::GetExtension($_).ToLowerInvariant() -eq $ext })
  if ($files.Count -eq 0) { continue }
  $remaining = [System.Collections.Generic.List[string]]::new()
  $files | ForEach-Object { $remaining.Add($_) }

  while ($remaining.Count -gt 0) {
    $before = Get-ProcessIds $app.Process
    $job = Start-Job -ScriptBlock $app.Block -ArgumentList (, $remaining.ToArray())
    $lastProgress = Get-Date
    $timedOut = $false
    while ($true) {
      Wait-Job $job -Timeout 2 | Out-Null
      foreach ($result in @(Receive-Job $job -ErrorAction SilentlyContinue)) {
        if ($remaining.Count -gt 0) { $remaining.RemoveAt(0) }
        if (-not $result.ok) { $script:failed = $true }
        Write-Result $result
        $lastProgress = Get-Date
      }
      if ($job.State -ne 'Running') { break }
      if (((Get-Date) - $lastProgress).TotalSeconds -gt $TimeoutSeconds) { $timedOut = $true; break }
    }
    Stop-Job $job -ErrorAction SilentlyContinue
    Remove-Job $job -Force -ErrorAction SilentlyContinue

    if ($timedOut -and $remaining.Count -gt 0) {
      $script:failed = $true
      Write-Result ([pscustomobject]@{ file = $remaining[0]; ok = $false; ms = $TimeoutSeconds * 1000; error = "Timed out after $TimeoutSeconds seconds (a repair or password dialog may be blocking the application)" })
      $remaining.RemoveAt(0)
    }
    elseif (-not $timedOut -and $remaining.Count -gt 0) {
      # The job ended early (for example the application could not start); report the rest instead of looping.
      foreach ($file in $remaining) {
        Write-Result ([pscustomobject]@{ file = $file; ok = $false; ms = 0; error = 'The Office application could not be started or exited unexpectedly.' })
      }
      $script:failed = $true
      $remaining.Clear()
    }

    # Stop only processes this job started; a pre-existing instance is left alone.
    foreach ($id in (Get-ProcessIds $app.Process | Where-Object { $before -notcontains $_ })) {
      Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
    }
  }
}

if ($script:failed) { exit 1 } else { exit 0 }
