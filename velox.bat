@echo off
setlocal
title Velox Downloader

rem ---------------------------------------------------------------------------
rem  Velox Downloader launcher
rem
rem    velox.bat           normal launch (licence checked against the live server)
rem    velox.bat bypass    skip the licence gate - local testing only
rem    velox.bat local     use a licence server on http://localhost:4000
rem    velox.bat update    update the bundled yt-dlp, then launch
rem
rem  Double-click to run. The console window stays open while the app runs and
rem  shows its log output; closing the app closes the window.
rem ---------------------------------------------------------------------------

cd /d "%~dp0"

if /i "%~1"=="bypass" (
  set "LICENSE_BYPASS=1"
  echo [velox] licence gate bypassed ^(testing mode^)
)

if /i "%~1"=="local" (
  set "LICENSE_SERVER_URL=http://localhost:4000"
  echo [velox] licence server: http://localhost:4000
)

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Node.js is not on your PATH. Install it from https://nodejs.org
  echo.
  pause
  exit /b 1
)

if not exist "bin\yt-dlp.exe" (
  echo.
  echo   bin\yt-dlp.exe is missing. See README.md, Setup step 2.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\electron" (
  echo [velox] first run - installing dependencies, this takes a minute...
  call npm install
  if errorlevel 1 goto :failed
)

if /i "%~1"=="update" (
  echo [velox] updating yt-dlp...
  "bin\yt-dlp.exe" -U
  echo.
)

for /f "delims=" %%v in ('"bin\yt-dlp.exe" --version 2^>nul') do set "YTDLP=%%v"
echo [velox] yt-dlp %YTDLP%
echo [velox] starting...
echo.

call npm start
if errorlevel 1 goto :failed
exit /b 0

:failed
echo.
echo   Velox exited with an error. Scroll up for the reason.
echo.
pause
exit /b 1
