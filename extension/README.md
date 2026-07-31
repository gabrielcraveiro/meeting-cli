# Meeting CLI Bridge — Extensão Firefox

Detecta quando você entra em uma call do **Microsoft Teams (web)** e aciona o
`meeting-cli` (rodando no WSL2) para gravar, transcrever e organizar as notas
automaticamente — incluindo a lista real de participantes (até quem só ouviu).

## Arquitetura

```
Firefox (Windows)                                WSL2
┌─────────────────────────┐                     ┌──────────────────────────┐
│ content-teams.js        │                     │ meeting daemon (:7899)   │
│  - detecta call (botão  │   background.js     │  - POST /start → spawn   │
│    de desligar no DOM)  │ ──── fetch ───────▶ │    `meeting start`       │
│  - raspa roster (aria-  │   localhost:7899    │  - POST /participants →  │
│    labels e data-tids)  │                     │    browser-bridge.json   │
│  - detecta fim da call  │                     │  - POST /stop → sinaliza │
└─────────────────────────┘                     └──────────────────────────┘
```

O WSL2 faz forward de `localhost` automaticamente, então o Firefox no Windows
alcança o daemon rodando no Linux sem configuração extra.

## Instalação

1. **No WSL2**, deixe o daemon rodando num terminal:
   ```bash
   meeting daemon
   ```
   A TUI de gravação aparece nesse terminal quando uma call começa.

2. **No Firefox**, carregue a extensão:
   - `about:debugging` → *This Firefox* → *Load Temporary Add-on*
   - Selecione `C:\Documentos\meeting-cli\extension\manifest.json`

   > Extensões temporárias somem ao fechar o Firefox. Para instalação
   > permanente, assine via [AMO unlisted](https://addons.mozilla.org/developers/)
   > (`web-ext sign`) ou use Firefox Developer Edition com
   > `xpinstall.signatures.required = false`.

3. Entre numa call do Teams. O badge da extensão mostra **REC** e a gravação
   inicia no terminal do daemon.

## Dicas

- **Abra o painel de participantes** ao menos uma vez durante a call — é a
  fonte mais completa do roster (tiles de vídeo só mostram quem está visível).
- Ao sair da call, a extensão espera ~15s (contra re-renders do Teams) e envia
  `/stop`; o pipeline normal roda (transcrição final, resumo, nota no Obsidian).
- O daemon aceita `--port <n>` se 7899 estiver em uso (ajuste também em
  `background.js`).

## Limitações conhecidas

- Só funciona com Teams **web** — o app desktop do Teams não expõe DOM.
- Seletores do Teams mudam sem aviso; a detecção usa `data-tid` + `aria-label`
  com fallbacks, mas pode precisar de manutenção. Logs em
  `about:debugging` → Inspect (background) e no console da aba do Teams
  (prefixo `[meeting-cli]`).
