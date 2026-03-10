#!/usr/bin/env bash
# ─────────────────────────────────────────────
# meeting-cli — instalação rápida (WSL + Windows)
# Rode de dentro do WSL:  bash install.sh
# ─────────────────────────────────────────────
set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}🎙  Meeting CLI — Instalador${NC}\n"

# 1. Check Node.js (WSL)
if ! command -v node &>/dev/null; then
  echo -e "${RED}❌ Node.js não encontrado no WSL.${NC}"
  echo "   Instale com:  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs"
  exit 1
fi
echo -e "  ✓ Node.js (WSL): $(node --version)"

# 2. Check node.exe (Windows)
if ! command -v node.exe &>/dev/null; then
  echo -e "${RED}❌ node.exe (Windows) não encontrado no PATH.${NC}"
  echo "   Instale Node.js no Windows: https://nodejs.org"
  exit 1
fi
echo -e "  ✓ node.exe (Windows): $(node.exe --version 2>/dev/null || echo '?')"

# 3. Check npm
if ! command -v npm &>/dev/null; then
  echo -e "${RED}❌ npm não encontrado.${NC}"
  exit 1
fi
echo -e "  ✓ npm: $(npm --version)"

# 4. Install dependencies + build
echo -e "\n${YELLOW}📦 Instalando dependências...${NC}"
npm install

echo -e "${YELLOW}🔨 Compilando...${NC}"
npm run build

# 5. Install globally
echo -e "${YELLOW}🌐 Instalando globalmente...${NC}"
npm install -g .

# 6. Install sidecar (WASAPI capture on Windows side)
echo -e "${YELLOW}🔊 Instalando sidecar WASAPI...${NC}"
meeting setup

# 7. Run config wizard if no config exists
CONFIG_FILE="$HOME/.config/meeting-cli/config.json"
if [ ! -f "$CONFIG_FILE" ]; then
  echo -e "\n${YELLOW}⚙️  Primeira vez — configurando...${NC}"
  meeting config
else
  echo -e "\n  ✓ Configuração existente: $CONFIG_FILE"
fi

echo -e "\n${GREEN}✅ Instalação completa!${NC}"
echo ""
echo "  Comandos disponíveis:"
echo "    meeting start              — grava reunião com transcrição ao vivo"
echo "    meeting start -t daily     — grava com template de daily"
echo "    meeting transcribe <file>  — transcreve arquivo de áudio"
echo "    meeting search <query>     — busca em reuniões"
echo "    meeting list               — lista reuniões"
echo "    meeting chat               — chat com contexto de reuniões"
echo "    meeting status             — mostra configuração atual"
echo ""
