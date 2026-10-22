@echo off
rem Saves a new GitHub token for git and Publish.cmd. See tools\set-github-token.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\set-github-token.ps1"
pause
