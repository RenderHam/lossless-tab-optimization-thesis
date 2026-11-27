@echo off
rem One-line shim for cmd.exe or double-clicking in Windows Explorer.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bootstrap.ps1" %*
