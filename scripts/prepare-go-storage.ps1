param(
  [string]$BackendRoot = 'D:\project\gogames',
  [switch]$Apply
)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$BackendRoot = (Resolve-Path -LiteralPath $BackendRoot).Path
$ConfigFile = Join-Path $BackendRoot 'lottery\config.yaml'
Push-Location (Join-Path $BackendRoot 'data-center')
try {
  $PrepareArgs = @('run', (Join-Path $ProjectRoot 'scripts\prepare-backend-storage.go'), '--config', $ConfigFile,
    '--report', (Join-Path $ProjectRoot 'cache\storage-preparation-2026-11-12.json'))
  if ($Apply) { $PrepareArgs += '--apply' }
  & go @PrepareArgs
  if ($LASTEXITCODE -ne 0) { throw 'Storage preparation failed; inspect the sanitized report. Existing configuration was not overwritten.' }
  if ($Apply) {
    & go run (Join-Path $ProjectRoot 'test\integration\check-backend-environment.go') --config $ConfigFile `
      --output (Join-Path $ProjectRoot 'cache\backend-environment-2026-11-12.json')
    if ($LASTEXITCODE -ne 0) { throw 'Storage preparation completed; readiness checks still found missing prerequisites.' }
  }
}
finally { Pop-Location }
