@echo off
REM ─────────────────────────────────────────────────────────────────────────
REM Claude Code Flow Dashboard — Start script (Windows CMD)
REM ─────────────────────────────────────────────────────────────────────────
setlocal enabledelayedexpansion

set "ROOT_DIR=%~dp0.."
set "DASH_DIR=%ROOT_DIR%\flow-dashboard"
set "VENV=%DASH_DIR%\.venv"
set "REQS=%DASH_DIR%\requirements.txt"
set "VENV_PY=%VENV%\Scripts\python.exe"
set "VENV_PIP=%VENV%\Scripts\pip.exe"

if "%~1"=="-h"     goto :usage
if "%~1"=="--help" goto :usage

REM ── Parse args ─────────────────────────────────────────────────────────
set "PORT=7842"
set "LOGS_DIR=%USERPROFILE%\.claude\flow-logs"

:parse_args
if "%~1"=="" goto :done_args
if "%~1"=="--port" (
    set "PORT=%~2"
    shift & shift
    goto :parse_args
)
if "%~1"=="--logs-dir" (
    set "LOGS_DIR=%~2"
    shift & shift
    goto :parse_args
)
echo Unknown option: %~1
goto :usage
:done_args

REM ── Find Python ────────────────────────────────────────────────────────
set "PYTHON="
for %%P in (python3 python py) do (
    where %%P >nul 2>&1 && (
        for /f "tokens=*" %%V in ('%%P -c "import sys; print(sys.version_info >= (3,11))" 2^>nul') do (
            if "%%V"=="True" (
                set "PYTHON=%%P"
                goto :found_python
            )
        )
    )
)
echo ERROR: Python 3.11+ is required but not found.
echo Install from https://www.python.org/downloads/
exit /b 1
:found_python
echo [info] Using Python at %PYTHON%

REM ── Virtualenv ─────────────────────────────────────────────────────────
if not exist "%VENV_PY%" (
    echo [setup] Creating virtualenv ...
    %PYTHON% -m venv "%VENV%"
)

if not exist "%VENV%\.reqs_hash" (
    goto :install_deps
)
goto :check_deps

:install_deps
echo [setup] Installing dependencies ...
"%VENV_PIP%" install -q --upgrade pip
"%VENV_PIP%" install -q -r "%REQS%"
echo installed > "%VENV%\.reqs_hash"

:check_deps

REM ── Start ──────────────────────────────────────────────────────────────
if not exist "%LOGS_DIR%" mkdir "%LOGS_DIR%"

set "FLOW_LOG_DIR=%LOGS_DIR%"
set "FLOW_SERVER_PORT=%PORT%"

echo.
echo   Flow Dashboard starting on http://localhost:%PORT%
echo   Logs directory: %LOGS_DIR%
echo.

"%VENV_PY%" "%DASH_DIR%\flow_server.py"
goto :eof

:usage
echo Usage: %~nx0 [--port PORT] [--logs-dir PATH]
echo.
echo Options:
echo   --port PORT        Server port          (default: 7842)
echo   --logs-dir PATH    JSONL logs directory  (default: %%USERPROFILE%%\.claude\flow-logs)
echo   -h, --help         Show this help
exit /b 0
