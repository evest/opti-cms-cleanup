@echo off
rem Runs the cleanup CLI without going through npm, so all arguments reach the tool.
node "%~dp0bin\cleanup.mjs" %*
