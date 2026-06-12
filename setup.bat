@echo off
chcp 65001 >nul
echo ============================================
echo  Urban Landscape Lab -- 環境安裝程式
echo ============================================
echo.

cd /d "%~dp0"
echo [1/5] 目前目錄：%CD%
echo.

REM --- 找 Python ---
set PYTHON=
where py >nul 2>&1
if %ERRORLEVEL%==0 (
    set PYTHON=py
    goto found_python
)
where python >nul 2>&1
if %ERRORLEVEL%==0 (
    set PYTHON=python
    goto found_python
)
echo [錯誤] 找不到 Python！請先從 https://python.org 安裝 Python 3.11 或 3.12
pause
exit /b 1

:found_python
echo [2/5] 使用 Python：%PYTHON%
%PYTHON% --version
echo.

REM --- 建立虛擬環境 ---
echo [3/5] 建立虛擬環境 .venv ...
if exist ".venv\Scripts\python.exe" (
    echo      已存在，略過
) else (
    %PYTHON% -m venv .venv
    if not exist ".venv\Scripts\python.exe" (
        echo [錯誤] 虛擬環境建立失敗！
        echo       若使用 Windows Store Python 請改裝 python.org 版本
        pause
        exit /b 1
    )
    echo      建立完成
)
echo.

REM --- 升級 pip ---
echo [4/5] 升級 pip ...
.venv\Scripts\python.exe -m pip install --upgrade pip --quiet
echo.

REM --- 安裝套件 ---
echo [5/5] 安裝套件 (requirements.txt) ...
.venv\Scripts\pip.exe install -r requirements.txt
if %ERRORLEVEL% NEQ 0 (
    echo [錯誤] 套件安裝失敗！
    pause
    exit /b 1
)

echo.
echo ============================================
echo  安裝完成！現在可以雙擊 run.bat 啟動服務
echo ============================================
pause
