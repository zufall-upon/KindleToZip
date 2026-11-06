@echo off
setlocal
node "%~dp0release-status.mjs" %*
exit /b %errorlevel%
