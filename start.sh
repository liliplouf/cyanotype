#!/usr/bin/env sh
# Lance le calculateur de pose cyanotype en local (serveur statique Python).
# Usage : ./start.sh            (port 8000)
#         PORT=9000 ./start.sh  (autre port)
set -e
cd "$(dirname "$0")"
PORT="${PORT:-8000}"
if ! command -v python3 >/dev/null 2>&1; then
  echo "Erreur : python3 est introuvable. Installez Python 3 ou servez ce dossier avec un autre serveur statique." >&2
  exit 1
fi
echo "Calculateur cyanotype : http://localhost:${PORT}/"
echo "(Ctrl+C pour arrêter)"
exec python3 -m http.server "${PORT}"
