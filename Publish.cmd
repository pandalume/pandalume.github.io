@echo off
rem Double-click to publish a new build. See README.md.
cd /d "%~dp0"
set /p APP=App to publish (bambowl, quillix-note, cypher-vault): 
node tools\zgs.mjs publish %APP%
pause
