# Meeting — app desktop (Tauri v2)

Cliente desktop do `meeting-cli`. Não fala com Deepgram, Teams nem com o vault
diretamente: **tudo passa pelo daemon** em `http://127.0.0.1:7899`
(contrato em `docs/app-api.md`). Se o daemon está fora, o app mostra
"Daemon offline" e continua tentando.

Três telas, roteadas por estado (sem router):

| Tela          | Quando                          | O que faz                                                                 |
| ------------- | ------------------------------- | ------------------------------------------------------------------------- |
| `Home`        | padrão                          | briefing colapsável, agenda de hoje, notas recentes, `+ Nota manual`      |
| `NoteSession` | `/status.recording === true`    | notepad + transcript ao vivo (SSE) + "Pergunte qualquer coisa" + insights |
| `NoteReader`  | clique numa nota recente        | markdown da nota final em estilo editorial + "Abrir no Obsidian"          |

A troca para `NoteSession` é automática: o poll de `/status` (3s) detecta a
gravação, não importa quem a iniciou (extensão, CLI ou o botão do app).

## Build no Windows

Pré-requisitos:

- **Node** ≥ 20.19 (o Vite 7 exige; Node 22/24 ok)
- **Rust** via [rustup](https://rustup.rs) (toolchain `stable-x86_64-pc-windows-msvc`)
- **Visual Studio Build Tools** com "Desktop development with C++"
- **WebView2 Runtime** (já vem no Windows 10/11 atualizado)

```powershell
cd C:\Documentos\meeting-cli\app
npm install
npm run icons        # gera src-tauri/icons/* (só se precisar regerar)

npm run tauri:dev    # dev: Vite em 127.0.0.1:1420 + janela Tauri
npm run tauri:build  # release: instalador NSIS em src-tauri\target\release\bundle\nsis
```

Só o frontend (útil no WSL/Linux, onde não há toolchain de webview):

```bash
npm run build        # tsc --noEmit + vite build
```

## Comportamento da janela

- **Frameless** (`decorations: false`) com barra própria: rótulo à esquerda,
  minimizar e fechar à direita. A área de arraste usa `data-tauri-drag-region`.
- **Fechar = esconder.** O `CloseRequested` é interceptado no Rust
  (`api.prevent_close()` + `hide()`); sair de verdade só pelo tray → *Sair*.
- **Tray** com *Abrir* / *Iniciar daemon* / *Sair*; clique esquerdo mostra a
  janela. O ícone do tray vem do `default_window_icon()` — o bloco
  `app.trayIcon` do `tauri.conf.json` foi **deixado de fora de propósito**,
  senão apareceriam dois ícones na bandeja (um do config, um do Rust).
- *Iniciar daemon* roda `cmd /C start "Meeting Daemon" cmd /K meeting daemon`,
  ou seja abre um terminal de verdade — o chat da TUI depende disso.

## Pontos de risco — validar no Windows

Nada disso pôde ser exercitado no WSL (sem WebView2/toolchain). Em ordem de
probabilidade de dar problema:

1. **Origin do webview em produção ≠ `tauri://localhost`.** No Windows o
   WebView2 serve o app como `http://tauri.localhost`, então o header `Origin`
   das chamadas ao daemon será `http://tauri.localhost` (em dev é
   `http://localhost:1420`, que o daemon já aceita). Se as requisições
   voltarem **403** no build release, a allowlist de Origin do daemon precisa
   incluir `http://tauri.localhost` além de `tauri://localhost`. Testar com o
   DevTools aberto no bundle instalado, não só em `tauri dev`.
2. **CSP.** Está restritiva no `tauri.conf.json`:

   ```
   default-src 'self';
   connect-src 'self' ipc: http://ipc.localhost http://127.0.0.1:7899 http://localhost:7899;
   style-src 'self' 'unsafe-inline';
   img-src 'self' data:
   ```

   `connect-src` é o que governa **tanto `fetch` quanto `EventSource`**, e cobre
   o daemon nos dois hostnames. `ipc: http://ipc.localhost` é **obrigatório**,
   senão o `invoke()` (barra de título, opener) para de funcionar no Windows.
   `style-src 'unsafe-inline'` é necessário porque o React escreve `style` em
   elemento (textarea auto-expansível). Fontes caem no `default-src 'self'`
   (são assets do bundle). Em dev o CSP **não** é aplicado: o HTML vem do Vite
   (`devUrl`) e não passa pelo asset protocol do Tauri — logo, um dev limpo não
   prova que o CSP está certo, **teste no bundle instalado**. Como o app roda em
   `http://` no Windows, `fetch` para `http://127.0.0.1` não é mixed content;
   mantivemos `fetch` nativo, **sem** `@tauri-apps/plugin-http`. Se ainda assim
   houver bloqueio, o plano B é o plugin http (sai pelo reqwest do Rust) com
   `http:allow-fetch` escopado a `http://127.0.0.1:7899/*`.
3. **`EventSource` para SSE.** Idem: é o EventSource nativo do WebView2 contra
   `127.0.0.1`. Reconexão própria com backoff (1s → 15s) em `src/lib/sse.ts`,
   porque o EventSource não retenta quando o servidor fecha o handshake (ex.:
   409 fora de sessão). Verificar que `snapshot` + `line` chegam.
4. **Ícone do tray.** Gerado por `scripts/gen-icons.mjs` (pngjs puro, sem
   ImageMagick). O `icon.ico` é multi-resolução com entradas **PNG** — formato
   válido no Vista+, mas se o NSIS reclamar do ícone, regerar com um `.ico`
   BMP/DIB clássico é a saída.
5. **`obsidian://`.** Aberto pelo comando Rust `open_obsidian`, que recebe só o
   relpath da nota e monta a URI do lado nativo. Se não abrir, conferir se o
   Obsidian está registrado como handler do protocolo no Windows.
6. **Nome do vault.** O daemon não expõe o path do vault, então na primeira vez
   que se clica em "Abrir no Obsidian" o app pergunta o nome do vault e guarda
   em `localStorage` (`meeting.vaultName`). Vazio = abre no vault ativo. Quando
   o daemon passar a expor o path, usar `vaultNameFromPath()` em
   `src/lib/format.ts` e remover o prompt.

## Notas de implementação

- **Notepad → daemon**: cada linha "fechada" com Enter vai num `POST
  /session/notes`; o texto completo fica em `sessionStorage` (sobrevive a
  reload). Um `Set` de linhas já enviadas evita duplicata quando se edita o
  meio do texto; ao sair do campo ou parar a gravação, tudo que sobrou é
  enviado.
- **Chat e insights** viram cartões dispensáveis acima da barra. Pergunta
  pendente aparece como "Pensando…" e é substituída pela resposta (timeout de
  60s, já que o contrato avisa 5–15s).
- **Markdown** por `marked` + **DOMPurify** (`USE_PROFILES: { html: true }`).
  O conteúdo passa por um modelo e por arquivos do vault, então é tratado como
  não-confiável. Clique em link não navega o webview: `https://` sai para o
  navegador via `open_https` (que valida o esquema no Rust), qualquer outro
  esquema é ignorado.
- **Superfície nativa mínima.** Não existe comando genérico do tipo
  `open_external(url)`: só `open_obsidian(file, vault?)` (monta a URI e faz o
  percent-encoding no Rust) e `open_https(url)` (rejeita o que não começa com
  `https://` ou tem espaço/controle). Assim nem um markdown malicioso nem um
  bug de UI conseguem disparar `file://` ou outro esquema.
- **Sem Tailwind, sem dark theme, sem azul de framework.** Tokens em
  `src/styles.css`: creme `#FAF9F5`, sálvia `#8A9A5B`, títulos em
  Source Serif 4 (subset latin, empacotado via `@fontsource`), corpo no sans do
  sistema.

## Estrutura

```
app/
├─ index.html
├─ package.json
├─ tsconfig.json
├─ vite.config.ts               # porta 1420 fixa (CORS do daemon)
├─ scripts/gen-icons.mjs        # gera os PNG/ICO do bundle
├─ src/
│  ├─ main.tsx  App.tsx  styles.css
│  ├─ hooks/useStatus.ts        # poll de /status a cada 3s
│  ├─ lib/  api.ts sse.ts markdown.ts format.ts shell.ts
│  ├─ components/  TitleBar BriefingCard TranscriptPanel Markdown ErrorBanner Icons
│  └─ screens/  Home.tsx NoteSession.tsx NoteReader.tsx
└─ src-tauri/
   ├─ Cargo.toml  build.rs  tauri.conf.json
   ├─ capabilities/default.json
   ├─ icons/
   └─ src/  main.rs  lib.rs
```

## Fora de escopo nesta entrega

- Lupinha nota → transcript (fase 3 da spec).
- Tela de ajustes (a engrenagem está desabilitada).
- Toggle "Original / Enhanced" na nota final.
