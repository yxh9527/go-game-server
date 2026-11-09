$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$package = Join-Path $repository ('doc/' + [char]0x5f85 + [char]0x5e94 + [char]0x7528 + '/player-panel')
$manifest = Get-Content -LiteralPath (Join-Path $package 'install-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$destinationRoot = [IO.Path]::GetFullPath('D:/project/gogames')
$planned = @()
foreach ($entry in $manifest.files) {
  $target = [IO.Path]::GetFullPath((Join-Path $destinationRoot $entry.relative))
  $source = [IO.Path]::GetFullPath((Join-Path $package $entry.relative))
  if (-not $target.StartsWith($destinationRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Target escaped gogames root' }
  if (-not $source.StartsWith([IO.Path]::GetFullPath($package) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Source escaped staged package' }
  if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sourceHash) { throw "Staged file changed: $source" }
  if (Test-Path -LiteralPath $target) {
    $current = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($current -eq $entry.sourceHash) { continue }
    if (-not $entry.originalHash -or $current -ne $entry.originalHash) { throw "Existing edits require review: $target" }
  } elseif ($entry.originalHash) { throw "Original target is missing: $target" }
  $planned += @{ target = $target; source = $source; relative = $entry.relative }
}
foreach ($entry in $planned) {
  if (Test-Path -LiteralPath $entry.target) {
    $backup = Join-Path (Join-Path $package 'backups') $entry.relative
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($backup)) | Out-Null
    Copy-Item -LiteralPath $entry.target -Destination $backup
  }
  Copy-Item -LiteralPath $entry.source -Destination $entry.target
  Write-Output ("Applied " + $entry.target)
}
Write-Output 'Source files applied. Services were not restarted and databases were not migrated.'
