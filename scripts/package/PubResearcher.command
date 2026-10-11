#!/bin/bash
# PubResearcher {{VERSION}} pour macOS : double-clic dans le Finder (la première fois : clic droit › Ouvrir).
# Node.js {{NODE_VERSION}} est fourni dans app/node : rien à installer, aucune connexion nécessaire. Les données sont
# rangées dans ~/Library/Application Support/PubResearcher (ou dans DATA_DIR), jamais dans ce dossier : une mise à jour
# le remplace entièrement.
DIR="$(cd "$(dirname "$0")" && pwd)" || exit 1
cd "$DIR" || exit 1

pause() {
  printf '\nAppuyez sur Entrée pour fermer cette fenêtre… '
  read -r _
}

# macOS marque chaque fichier téléchargé (« quarantaine ») et bloquerait un à un le moteur Node.js et ses modules.
# Vous venez d'autoriser ce lanceur : la marque est levée sur le reste de l'application, une fois pour toutes.
xattr -dr com.apple.quarantine "$DIR" 2>/dev/null

NODE="$DIR/app/node/bin/node"
if [ ! -x "$NODE" ]; then
  printf '\nFichiers introuvables : l’archive est incomplète, ou ce fichier a été déplacé hors de son dossier.\n'
  printf 'Décompressez à nouveau l’archive et lancez PubResearcher.command depuis le dossier PubResearcher.\n'
  pause
  exit 1
fi

"$NODE" --disable-warning=ExperimentalWarning "$DIR/app/launcher.mjs" "$@"
status=$?
if [ "$status" -ne 0 ]; then pause; fi
exit "$status"
