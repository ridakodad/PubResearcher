@echo off
rem Lanceur Windows : double-clic. Installe les dependances a la premiere utilisation, demarre l'application
rem (npm start la compile si besoin) et ouvre le navigateur.
cd /d "%~dp0"
title PubResearcher

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js n'est pas installe sur cet ordinateur.
  echo Installez la version "LTS" depuis https://nodejs.org puis relancez ce fichier.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo.
  echo Premiere utilisation : installation des dependances ^(environ une minute, connexion internet necessaire^)...
  echo.
  call npm ci
  if errorlevel 1 (
    echo.
    echo L'installation a echoue. Verifiez la connexion internet puis relancez ce fichier.
    echo.
    pause
    exit /b 1
  )
)

echo.
echo L'application demarre : http://localhost:4000
echo Laissez cette fenetre ouverte tant que vous travaillez ; fermez-la pour arreter.
echo.
start "" /min cmd /c "timeout /t 10 /nobreak >nul & start http://localhost:4000"
call npm start
echo.
pause
