@echo off
rem Inicia o agente com supervisor (religa sozinho se cair). Para de verdade só com "ctl stop".
cd /d "%~dp0"
if not exist .env (
  copy .env.example .env >nul
  echo Preencha MC_PASSWORD no arquivo .env e rode de novo.
  notepad .env
  exit /b 1
)
title Minecraft AI Agent
node --env-file-if-exists=.env src\index.js
