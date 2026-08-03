#!/usr/bin/env bash
# Instala o briefing matinal no crontab do WSL (7h40, seg-sex).
#
# Por que caminho absoluto: o fnm nao entra no PATH de shells nao-interativos,
# entao o cron nao encontraria `meeting` nem `node`. Usamos o binario da versao
# de node instalada pelo fnm diretamente.
#
# Idempotente: se a entrada ja existir no crontab, nao duplica.
#
# Uso:  bash scripts/install-briefing-schedule.sh
#       bash scripts/install-briefing-schedule.sh --remove

set -euo pipefail

MEETING_BIN="/home/gabriel/.local/share/fnm/node-versions/v24.13.0/installation/bin/meeting"
SCHEDULE="40 7 * * 1-5"
MARKER="# meeting-cli briefing matinal"
LOG="$HOME/.local/state/meeting-cli/briefing.log"
CRON_LINE="$SCHEDULE $MEETING_BIN briefing --quiet >> $LOG 2>&1 $MARKER"

current_crontab() {
  crontab -l 2>/dev/null || true
}

if [[ "${1:-}" == "--remove" ]]; then
  if current_crontab | grep -Fq "$MARKER"; then
    current_crontab | grep -Fv "$MARKER" | crontab -
    echo "Entrada do briefing removida do crontab."
  else
    echo "Nada a remover — briefing nao esta no crontab."
  fi
  exit 0
fi

if [[ ! -x "$MEETING_BIN" ]]; then
  echo "AVISO: $MEETING_BIN nao existe ou nao e executavel."
  echo "       Rode 'npm run install-global' no repo do meeting-cli antes de agendar."
  echo "       (a entrada do cron sera criada de qualquer forma)"
fi

if ! command -v crontab >/dev/null 2>&1; then
  echo "ERRO: crontab nao encontrado. Instale o cron:  sudo apt install cron"
  exit 1
fi

mkdir -p "$(dirname "$LOG")"

if current_crontab | grep -Fq "$MARKER"; then
  echo "Briefing matinal ja esta agendado — nada a fazer."
  current_crontab | grep -F "$MARKER"
  exit 0
fi

{ current_crontab; echo "$CRON_LINE"; } | crontab -
echo "Briefing matinal agendado: $SCHEDULE (seg-sex, 7h40)"
echo "  comando: $MEETING_BIN briefing --quiet"
echo "  log:     $LOG"
echo ""
echo "No WSL o cron nao sobe sozinho. Garanta que o servico esta ativo:"
echo "  sudo service cron start        # e, para persistir, habilite systemd no wsl.conf"
