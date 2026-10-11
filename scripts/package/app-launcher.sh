#!/bin/bash
# PubResearcher.app : ouvre PubResearcher.command (dans le même dossier) dans le Terminal, dont la fenêtre est celle
# de l'application (la fermer arrête PubResearcher). Paquet non signé : voir LISEZMOI.txt pour le premier lancement.
BUNDLE="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="$(dirname "$BUNDLE")"

case "$BUNDLE" in
  */AppTranslocation/*)
    # Application téléchargée et jamais autorisée : macOS l'exécute depuis une copie provisoire, isolée du dossier.
    osascript -e 'display dialog "Pour le premier lancement, faites un clic droit sur « PubResearcher.command » (dans le dossier PubResearcher), puis « Ouvrir ». Ensuite, PubResearcher.app s’ouvrira normalement." buttons {"OK"} default button "OK" with title "PubResearcher" with icon caution' >/dev/null 2>&1
    exit 1
    ;;
esac

if [ ! -f "$DIR/PubResearcher.command" ]; then
  osascript -e 'display dialog "PubResearcher.app doit rester dans le dossier PubResearcher, à côté de PubResearcher.command et du dossier app. Déplacez le dossier entier, pas l’application seule." buttons {"OK"} default button "OK" with title "PubResearcher" with icon caution' >/dev/null 2>&1
  exit 1
fi

xattr -dr com.apple.quarantine "$DIR" 2>/dev/null
exec open -a Terminal "$DIR/PubResearcher.command"
