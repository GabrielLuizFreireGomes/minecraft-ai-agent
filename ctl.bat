@echo off
rem Uso: ctl status ^| pause ^| resume ^| stop ^| restart ^| inventory
rem stop = desliga de vez (supervisor não religa); restart = reinicia (supervisor sobe de novo)
cd /d "%~dp0"
set CMD=%1
if "%CMD%"=="" set CMD=status
if /i "%CMD%"=="status" (curl -s http://127.0.0.1:3077/status & echo. & exit /b)
if /i "%CMD%"=="inventory" (curl -s http://127.0.0.1:3077/inventory & echo. & exit /b)
if /i "%CMD%"=="stop" (type nul > data\stop.flag)
if /i "%CMD%"=="restart" (curl -s -X POST http://127.0.0.1:3077/stop & echo. & exit /b)
curl -s -X POST http://127.0.0.1:3077/%CMD%
echo.
