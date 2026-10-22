@echo off
rem Double-click to publish a new build, or see status. See README.md.
cd /d "%~dp0"
node tools\zgs.mjs
pause
