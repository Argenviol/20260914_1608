@echo off
rem ============================================================
rem  무제체스 실행기
rem  이 파일의 안내문은 일부러 영문입니다. cmd 가 배치 파일 자체를
rem  읽을 때의 코드페이지 때문에 한글이 깨질 수 있기 때문입니다.
rem  실제 게임 화면과 launch.py 의 안내는 모두 한글로 나옵니다.
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"

rem -- find python ---------------------------------------------
rem  괄호 블록 안에서는 %errorlevel% 이 파싱 시점 값으로 굳으므로
rem  블록 없이 goto 로만 분기한다.
set "PY="

where py.exe >nul 2>&1
if not errorlevel 1 set "PY=py"
if defined PY goto run

where python.exe >nul 2>&1
if not errorlevel 1 set "PY=python"
if defined PY goto run

where python3.exe >nul 2>&1
if not errorlevel 1 set "PY=python3"
if defined PY goto run

echo.
echo   Python not found - opening the game file directly.
echo   (The game still works this way.)
echo.
goto direct

:run
%PY% "tools\launch.py"
if not errorlevel 1 goto end
echo.
echo   Could not start the local server - opening the file directly.
echo.

:direct
start "" "game\index.html"
timeout /t 4 >nul

:end
