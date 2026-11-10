param([string]$TargetRoot='D:\project\gogames')
$ErrorActionPreference='Stop'
$source=Join-Path $TargetRoot 'data-center\dao\gogame_cash.go'
$testSource=Join-Path $PSScriptRoot ('..\doc\'+[char]0x5F85+[char]0x5E94+[char]0x7528+'\cash-capacity\gogame_cash_capacity_test.go')
$targetTest=Join-Path $TargetRoot 'data-center\dao\gogame_cash_capacity_test.go'
if(-not [System.IO.File]::Exists($testSource)){throw 'Capacity regression test source is missing.'}
$content=[System.IO.File]::ReadAllText($source)
if(-not $content.Contains('const cashMaxAccounts = 1024')) {
  if(-not $content.Contains('len(request.Accounts) > 64') -or -not $content.Contains('len(request.Steps) > 1024')) {
    throw 'Unexpected cash API source; refusing to overwrite another capacity change.'
  }
  $limits=@('const cashMax int64 = 9007199254740991','const cashMaxAccounts = 1024','const cashMaxSteps = 4096') -join [Environment]::NewLine
  $content=$content.Replace('const cashMax int64 = 9007199254740991',$limits)
  $content=$content.Replace('len(request.Accounts) > 64','len(request.Accounts) > cashMaxAccounts')
  $content=$content.Replace('len(request.Steps) > 1024','len(request.Steps) > cashMaxSteps')
  [System.IO.File]::WriteAllText($source,$content,[System.Text.UTF8Encoding]::new($false))
}
if([System.IO.File]::Exists($targetTest) -and
  [System.IO.File]::ReadAllText($targetTest) -ne [System.IO.File]::ReadAllText($testSource)) {
  throw 'An existing capacity test differs; refusing to replace it.'
}
[System.IO.File]::WriteAllText($targetTest,[System.IO.File]::ReadAllText($testSource),[System.Text.UTF8Encoding]::new($false))
Write-Output 'Updated atomic cash capacity and installed regression tests. No services restarted.'
