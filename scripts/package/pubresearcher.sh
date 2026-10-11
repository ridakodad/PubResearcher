#!/bin/sh
# PubResearcher {{VERSION}} pour Linux : ./pubresearcher.sh dans un terminal (ou double-clic, selon le gestionnaire de
# fichiers). Node.js {{NODE_VERSION}} est fourni dans app/node : rien à installer, aucune connexion nécessaire. Les
# données sont rangées dans ~/.local/share/pubresearcher (ou $XDG_DATA_HOME/pubresearcher, ou DATA_DIR), jamais dans
# ce dossier : une mise à jour le remplace entièrement.
DIR="$(cd "$(dirname "$0")" && pwd)" || exit 1
cd "$DIR" || exit 1

NODE="$DIR/app/node/bin/node"
if [ ! -x "$NODE" ]; then
  printf '\nFichiers introuvables : l’archive est incomplète, ou ce fichier a été déplacé hors de son dossier.\n'
  printf 'Décompressez à nouveau l’archive (tar -xzf PubResearcher-….tar.gz) et lancez ./pubresearcher.sh depuis le dossier PubResearcher.\n\n'
  exit 1
fi

exec "$NODE" --disable-warning=ExperimentalWarning "$DIR/app/launcher.mjs" "$@"
