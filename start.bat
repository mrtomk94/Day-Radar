@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Chua cai Node.js. Tai ban LTS tai https://nodejs.org roi chay lai file nay.
  start https://nodejs.org
  pause
  exit /b
)
echo Dang khoi dong Day Radar... (dong cua so nay = tat app)
start "" http://localhost:8081
node server.js
pause
