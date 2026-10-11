@echo off
rem PubResearcher {{VERSION}} pour Windows : double-clic. Node.js {{NODE_VERSION}} est fourni dans app\node :
rem rien a installer, aucune connexion necessaire. Les donnees sont rangees dans %LOCALAPPDATA%\PubResearcher
rem (ou dans le dossier designe par DATA_DIR), jamais dans ce dossier : une mise a jour le remplace entierement.
setlocal
cd /d "%~dp0"
title PubResearcher
rem Affichage des accents.
chcp 65001 >nul 2>nul

if not exist "%~dp0app\node\node.exe" (
  echo.
  echo Fichiers introuvables : l'archive n'a pas ete decompressee, ou elle est incomplete.
  echo Faites un clic droit sur le fichier .zip, choisissez "Extraire tout...",
  echo puis double-cliquez sur PubResearcher.cmd dans le dossier extrait.
  echo.
  pause
  exit /b 1
)

"%~dp0app\node\node.exe" --disable-warning=ExperimentalWarning "%~dp0app\launcher.mjs" %*
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)
