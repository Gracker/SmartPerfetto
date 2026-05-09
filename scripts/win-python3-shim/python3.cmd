@echo off
:: SmartPerfetto: forward `python3` to Windows Python (Perfetto build.js 硬编码 python3)
setlocal
where py >nul 2>&1
if %ERRORLEVEL% equ 0 (
  py -3 %*
  exit /b %ERRORLEVEL%
)
where python >nul 2>&1
if %ERRORLEVEL% equ 0 (
  python %*
  exit /b %ERRORLEVEL%
)
echo python3: Python 3 not found. Install from https://www.python.org/ and ensure "py" or "python" is in PATH. >&2
exit /b 9009
