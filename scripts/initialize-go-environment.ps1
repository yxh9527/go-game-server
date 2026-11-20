param(
  [string]$BackendRoot = 'D:\project\gogames',
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$BackendRoot = (Resolve-Path -LiteralPath $BackendRoot).Path
$ConfigFile = Join-Path $BackendRoot 'lottery\config.yaml'
$ReportFile = Join-Path $ProjectRoot 'cache\backend-environment-2026-11-12.json'

Write-Host 'Checking reviewed backend source package...'
$SourceArgs = @((Join-Path $ProjectRoot 'scripts\apply-backend-integration.mjs'), $BackendRoot)
if ($Apply) { $SourceArgs += '--apply' }
& node @SourceArgs
if ($LASTEXITCODE -ne 0) { throw 'Backend source validation/application failed.' }

if (-not $Apply) {
  & node (Join-Path $ProjectRoot 'scripts\rename-backend-databases.mjs') $BackendRoot
  if ($LASTEXITCODE -ne 0) { throw 'Database-name configuration validation failed.' }
}

Push-Location (Join-Path $BackendRoot 'data-center')
try {
  Write-Host 'Checking empty go_manager/go_player targets with the existing backend initializer...'
  $InitArgs = @('run', (Join-Path $ProjectRoot 'scripts\initialize-backend-databases.go'), '--config', $ConfigFile)
  if ($Apply) { $InitArgs += '--apply' }
  & go @InitArgs
  if ($LASTEXITCODE -ne 0) { throw 'Empty-target check or database initialization failed. Service configuration has not been switched.' }

  if ($Apply) {
    Write-Host 'Updating database names in six service configurations, with backups...'
    & node (Join-Path $ProjectRoot 'scripts\rename-backend-databases.mjs') $BackendRoot --apply
    if ($LASTEXITCODE -ne 0) { throw 'Configuration update failed. New databases may exist; original configurations were retained or rolled back.' }
    Write-Host 'Preparing missing empty ES indices and Redis configuration...'
    & go run (Join-Path $ProjectRoot 'scripts\prepare-backend-storage.go') --config $ConfigFile --apply `
      --report (Join-Path $ProjectRoot 'cache\storage-preparation-2026-11-12.json')
    if ($LASTEXITCODE -ne 0) { throw 'Databases/configuration initialized; storage preparation still needs attention. Use prepare-go-storage.ps1 to retry.' }
    Write-Host 'Running read-only connectivity and schema checks...'
    & go run (Join-Path $ProjectRoot 'test\integration\check-backend-environment.go') --config $ConfigFile --output $ReportFile
    if ($LASTEXITCODE -ne 0) {
      Write-Warning 'Initialization/configuration commands completed, but readiness checks found missing prerequisites. Read the sanitized JSON report.'
      exit 1
    }
  } else {
    Write-Host 'Preview only. Add -Apply to initialize empty targets and update configuration. No services are started or restarted.'
  }
}
finally { Pop-Location }
