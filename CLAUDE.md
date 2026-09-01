# meeting-cli — notas para o Claude

Ferramenta pessoal de reuniões (local-first, estilo Granola). Três artefatos que se
buildam de formas DIFERENTES — leia a seção de build antes de tentar compilar.

## Arquitetura em 30 segundos

| Peça | Onde roda | Como atualiza |
|---|---|---|
| CLI + daemon (`meeting`, porta 7899) | WSL (Node) | `npm run build` → `meeting daemon restart` |
| App desktop (Tauri 2 + React) | Windows | build pelo lado Windows → instalar o NSIS |
| Extensão Firefox (`extension/`) | Firefox | assinar no AMO → arrastar o `.xpi` |

Fluxo: extensão detecta call do Teams → `POST /start` no daemon → daemon spawna
`meeting start --browser` (sessão) → sessão grava/transcreve e no fim dispara o
worker destacado `meeting organize-job <job.json>`, que escreve a nota no vault.

**Onde cada mudança entra em produção:**
- `src/commands/daemon.ts` → só com `meeting daemon restart`.
- Resto do `src/` (sessão, organizador, briefing, prep) → **automático**: sessão e
  worker nascem novos a cada call lendo `dist/cli.js`.
- `app/` → precisa buildar + instalar o exe.
- `extension/` → precisa assinar + instalar o xpi.

## Build — armadilhas reais (todas já custaram horas)

### CLI (WSL, fácil)
```bash
npm run build            # esbuild → dist/cli.js
npx tsc --noEmit         # type-check (rode sempre)
meeting daemon restart   # só se mexeu no daemon.ts
```
Nunca rode `npm run build` de dentro de `app/` — lá esse script é o do Vite e
quebra com erro de rollup nativo. Confira o `pwd` primeiro.

### App Tauri — SEMPRE pelo lado Windows
O `node_modules` de `app/` tem binários **Windows** (rollup, esbuild): rodar do
WSL falha com `Cannot find module @rollup/rollup-linux-x64-gnu`. O jeito certo:
```bash
powershell.exe -NoProfile -Command "cd C:\Documentos\meeting-cli\app; npm run tauri:build 2>&1 | Select-Object -Last 4"
```
Saída: `app/src-tauri/target/release/bundle/nsis/Meeting_<versão>_x64-setup.exe`.
Type-check antes (`cd app && npx tsc --noEmit`) — o build só falha depois de
minutos de Rust se o TS estiver quebrado.

**Se o build do Rust falhar de formas bizarras** (`TOML parse error`, `key with no
value`, `invalid gzip header`, `␀␀␀` no meio de um Cargo.toml): o registry do
cargo corrompeu (acontece quando a sessão morre no meio de um download). Escalone:
```powershell
Remove-Item app/src-tauri/Cargo.lock                       # 1. lockfile
Remove-Item -Recurse "$env:USERPROFILE\.cargo\registry\src","$env:USERPROFILE\.cargo\registry\cache"   # 2. registry
cd app/src-tauri; cargo clean                              # 3. target
```
Depois rode o `tauri:build` normal — ele rebaixa tudo validando checksum.

Plugins Tauri em uso: `opener`, `deep-link` (protocolo `meeting://`),
`single-instance`, `autostart`. Ao adicionar plugin, lembre dos **três** pontos:
`Cargo.toml`, `.plugin()` no `lib.rs` **e** a permissão em
`app/src-tauri/capabilities/default.json` (esquecer a capability = falha silenciosa
em runtime, não no build).

### Extensão Firefox
```bash
# 1. SEMPRE suba o "version" em extension/manifest.json (AMO rejeita repetido)
./scripts/sign-extension.sh      # web-ext sign, canal unlisted
# → dist-ext/<uuid>-<versão>.xpi ; arrastar pro Firefox
```
O AMO cai às vezes ("Service Unavailable") — vale retry com espera, não é bug
nosso. Validar sintaxe antes de assinar:
`node -e "new Function(require('fs').readFileSync('extension/content-teams.js','utf8'))"`.

## Regras de ouro aprendidas em produção

- **Título do Teams não é identidade**: já vimos nome de participante, título com
  `|` truncado, sufixo `(Externo)` intermitente e painel de legendas fantasma
  causando fatiamento de nota. Compare sempre o menor invariante (base sem
  parênteses, minúsculo) — ver `normTitle` em `daemon.ts` e `baseTitle` na extensão.
- **Spawn de `claude`**: use `resolveClaudeBin()` + `claudeSpawnEnv()` de
  `src/services/claudeBin.ts`. O shim tem shebang `#!/usr/bin/env node`; sem o
  PATH do node injetado, cron e contextos headless falham silenciosamente.
- **Modelos de raciocínio (GPT-5.x/luna)**: `max_completion_tokens` cobre
  pensamento + resposta. Teto baixo devolve **texto vazio sem erro** — use ≥16k
  no organizador e valide corpo vazio antes de gravar nota.
- **Timers do app no tray**: o WebView2 estrangula `setInterval` de janela oculta.
  `backgroundThrottling: "disabled"` no `tauri.conf.json` + janelas de tolerância
  generosas no daemon (ex.: `APP_ALIVE_MS = 5min`, nunca segundos).
- **Flex + `overflow: hidden`** zera o `min-height` do item: o card do briefing
  "aparecia e sumia" até ganhar `flex: 0 0 auto`.
- **Nunca reiniciar o daemon durante uma call.** Padrão usado sempre aqui:
  `until curl -s http://127.0.0.1:7899/status | grep -q '"recording":false'; do sleep 15; done; meeting daemon restart`
- Vault em `/mnt/c` (drvfs) é lento por arquivo: leia só o frontmatter (primeiros
  ~4KB) quando precisar de metadados de muitas notas.

## Verificações rápidas
```bash
curl -s http://127.0.0.1:7899/status              # recording, phase, binMtime
stat -c %Y dist/cli.js                            # compare com binMtime: daemon velho?
tail -20 ~/.config/meeting-cli/daemon.log         # detecção de call, prep, alertas
tail -5  ~/.local/state/meeting-cli/briefing.log  # cron das 7h40
ls -t ~/.config/meeting-cli/organize-jobs/        # jobs de nota órfãos
```

Config (chaves, vaultPath, modelos): `~/.config/meeting-cli/config.json` — fora do
git. Contexto de produto/decisões: `ROADMAP.md` e `ONBOARDING.md`.
