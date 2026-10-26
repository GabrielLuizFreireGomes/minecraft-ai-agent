# Instala/reinstala dependências (inclui dados 26.2 do minecraft-data, PR #1339).
Set-Location (Split-Path $PSScriptRoot)
if (-not (Test-Path vendor\minecraft-data)) {
  git clone --depth 1 https://github.com/PrismarineJS/minecraft-data.git vendor/minecraft-data
  git -C vendor/minecraft-data fetch --depth 1 origin refs/pull/1339/head:pr1339
  git -C vendor/minecraft-data checkout -q pr1339
}
npm install
if (-not (Test-Path .env)) { Copy-Item .env.example .env; Write-Host "Preencha MC_PASSWORD em .env" }
