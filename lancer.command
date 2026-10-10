#!/bin/bash
# Lanceur macOS et Linux. macOS : double-clic dans le Finder. Linux : ./lancer.command dans un terminal.
# Installe les dépendances à la première utilisation, démarre l'application (npm start la compile si besoin)
# et ouvre le navigateur.
cd "$(dirname "$0")" || exit 1

pause() {
  printf '\nAppuyez sur Entrée pour fermer cette fenêtre… '
  read -r _
}

if ! command -v node >/dev/null 2>&1; then
  printf '\nNode.js n’est pas installé sur cet ordinateur.\nInstallez la version « LTS » depuis https://nodejs.org, puis relancez ce fichier.\n'
  pause
  exit 1
fi

if [ ! -d node_modules ]; then
  printf '\nPremière utilisation : installation des dépendances (environ une minute, connexion internet nécessaire)…\n\n'
  if ! npm ci; then
    printf '\nL’installation a échoué. Vérifiez la connexion internet, puis relancez ce fichier.\n'
    pause
    exit 1
  fi
fi

URL="http://localhost:${PORT:-4000}"
printf '\nL’application démarre : %s\nLaissez cette fenêtre ouverte tant que vous travaillez ; fermez-la (ou Ctrl+C) pour arrêter.\n\n' "$URL"
(
  sleep 8
  if command -v open >/dev/null 2>&1; then
    open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL"
  fi
) >/dev/null 2>&1 &

npm start
pause
