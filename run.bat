@echo off
cd /d "%~dp0"

echo ============================================
echo  Urban Landscape Lab - Backend Launcher
echo ============================================
echo.

echo [1/3] Killing processes on port 8000...
for /f "tokens=5" %%p in ('netstat -aon 2^>nul ^| findstr ":8000 " ^| findstr "LISTENING"') do (
    taskkill /F /PID %%p >nul 2>&1
)
taskkill /F /IM python.exe >nul 2>&1
echo       Done.
echo.

echo [2/3] Checking virtual environment...
if not exist ".venv\Scripts\python.exe" (
    echo [ERROR] .venv not found. Rebuilding...
    C:\Users\User\AppData\Local\Programs\Python\Python313\python.exe -m venv .venv
    .venv\Scripts\python.exe -m pip install fastapi "uvicorn[standard]" google-genai python-dotenv pillow python-multipart --quiet
)
echo       OK.
echo.

echo [3/3] Starting FastAPI server...
echo.
echo   URL  : http://127.0.0.1:8000
echo   DOCS : http://127.0.0.1:8000/docs
echo   Press Ctrl+C to stop
echo ============================================
echo.

.venv\Scripts\python.exe -m uvicorn main:app --reload --port 8000 --host 127.0.0.1

echo.
echo [Server stopped]
pause
