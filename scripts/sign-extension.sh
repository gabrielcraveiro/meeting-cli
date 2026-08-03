#!/usr/bin/env bash
# Assina a extensão na Mozilla (canal unlisted) e gera o .xpi instalável.
# Credenciais em ~/.config/meeting-cli/amo-credentials.json (fora do repo).
# Uso: ./scripts/sign-extension.sh
# Lembre de subir o "version" no extension/manifest.json a cada assinatura.
set -euo pipefail

CREDS="$HOME/.config/meeting-cli/amo-credentials.json"
if [ ! -f "$CREDS" ]; then
  echo "Credenciais AMO não encontradas em $CREDS" >&2
  exit 1
fi

API_KEY=$(python3 -c "import json;print(json.load(open('$CREDS'))['apiKey'])")
API_SECRET=$(python3 -c "import json;print(json.load(open('$CREDS'))['apiSecret'])")

cd "$(dirname "$0")/.."

npx --yes web-ext sign \
  --source-dir extension \
  --channel unlisted \
  --api-key "$API_KEY" \
  --api-secret "$API_SECRET" \
  --artifacts-dir dist-ext

echo ""
echo "✅ .xpi assinado em dist-ext/ — arrasta pro Firefox pra instalar."
