# Contrato de API — daemon ↔ app Tauri (v1)

Base: `http://127.0.0.1:7899`. CORS: além de extensões, o daemon aceita
`Origin: http://localhost:1420` (dev), `tauri://localhost` (prod macOS/Linux)
e `http(s)://tauri.localhost` (prod Windows/WebView2).
Requisições sem Origin (curl) continuam aceitas. SSE = `text/event-stream`,
eventos JSON por linha `data:`.

## Estado & controle

- `GET /status` → `{ recording, title?, elapsedSec?, sharing, phase }`
  - `phase`: `idle | recording | finalizing`
- `POST /start` `{ title?, template? }` — já existe (extensão usa)
- `POST /stop` — já existe

## Logs do daemon

O daemon mantém um tail em memória (buffer circular de 500 linhas, ANSI removido)
com os próprios logs e — em modo headless — todo o stdout/stderr da sessão filha.
O buffer é do daemon, não da sessão: sobrevive ao fim da reunião e pode ser lido
fora de sessão (nunca responde 409).

- `GET /daemon/logs` → `{ lines: [{ line, at }] }` (`at` = epoch ms)
- `GET /daemon/logs/stream` — SSE. Ao conectar: `snapshot` `{ lines: [...] }`;
  depois `log` `{ line, at }` por linha nova

### Flag `--headless` do daemon

`meeting daemon --headless` (opcionalmente com `--port`) faz o daemon spawnar a
sessão como `meeting start --browser --headless` com `stdio: ['ignore','pipe','pipe']`:
a sessão não abre TUI, não lê stdin e não faz nenhuma pergunta interativa; tudo que
ela imprime vira linha em `/daemon/logs`. Sem `--headless` o comportamento é o
antigo (`stdio: 'inherit'`, TUI toma o terminal do daemon).

## Agenda & notas prontas (fora de sessão)

- `GET /meetings/today` → `[{ title, startIso, endIso, attendees[] }]` (ICS; `[]` sem icsUrl)
- `GET /notes/recent?limit=20` → `[{ file, title, date, time, participants[], tags[] }]`
  (lê frontmatter das notas do vault, mais recentes primeiro)
- `GET /notes/content?file=<relpath>` → `{ markdown }` (path SEMPRE validado dentro do vault)
- `GET /briefing/today` → `{ markdown }` ou 404

## Sessão ao vivo (só respondem 409 se não gravando)

- `GET /session/transcript/stream` — SSE. Ao conectar: evento `snapshot`
  `{ lines: [...] }`; depois `line` `{ ts, speaker, text }` (ts = segundos)
- `GET /session/insights/stream` — SSE. Eventos `insight` `{ ts, text }`
- `POST /session/notes` `{ text }` → `{ ok, ts }` — anotação do usuário,
  timestampada pelo daemon com o elapsed atual
- `GET /session/notes` → `{ notes: [{ ts, text }] }`
- `POST /session/chat` `{ message }` → `{ reply }` (síncrono, pode demorar ~5-15s)
- `POST /session/context` `{ text }` → `{ ok }` — contexto extra para a nota final.
  Aceito em `phase` `recording` (pré-digitado) ou `finalizing`; 409 fora disso,
  400 se `text` não for string. **String vazia é resposta válida**: significa
  "sem contexto, prossiga" e encerra a janela de 45s imediatamente (botão
  "Pular" do app). Entregue à sessão pelo mesmo long-poll (`{ type: 'context' }`).
  Substitui o prompt "Contexto extra para a nota?" quando a sessão é headless.

### Contexto pós-reunião em headless

Numa sessão `--headless` não existe terminal para o prompt de contexto. Ao entrar em
`finalizing`, a sessão abre uma **janela de 45s** long-pollando a fila do daemon: o app
deve fazer `POST /session/context` nesse intervalo (ou antes, ainda durante `recording`
— o valor fica guardado). Passados os 45s sem contexto, a nota é gerada sem ele. O
wizard de speakers não identificados também é pulado em headless.

## Interno (sessão de gravação → daemon; mesma porta, prefixo /internal)

A sessão (`meeting start --browser`, processo filho) REPORTA ao daemon:

- `POST /internal/transcript` `{ lines: [{ ts, speaker, text }] }` (batch, a cada segmento)
- `POST /internal/insight` `{ ts, text }`
- `POST /internal/state` `{ phase, title?, elapsedSec? }` (a cada ~5s)
- `POST /internal/chat-context` — NÃO existe: o chat do app é respondido PELO
  processo de sessão. Fluxo: daemon guarda a pergunta numa fila em memória;
  a sessão faz long-poll `GET /internal/chat-queue` (timeout 25s) e responde
  `POST /internal/chat-reply { id, reply }`; o daemon resolve o POST original
  do app. Motivo: o contexto do chat (buildSystemMsg) vive na sessão.

Anotações do usuário (`POST /session/notes`) também são entregues à sessão via
o mesmo long-poll (evento `{ type: 'note' }`) para entrarem no enhance final
como esqueleto (userNotes em OrganizeOptions). O contexto pós-reunião
(`POST /session/context`) usa a mesma fila (`{ type: 'context', text }`).

## Enhance (contrato de dados na nota final)

A nota final ganha no frontmatter: `sourceNotes: true` quando houve anotações
do usuário. O organizer recebe `userNotes: [{ ts, text }]` e as trata como
ESQUELETO (prioridade sobre estrutura padrão).

## Regras

- Nada de estado em disco novo: sessão ao vivo é memória do daemon (morre com ele).
- Timeouts SSE: heartbeat `: ping` a cada 15s.
- Tudo 127.0.0.1; validação de Origin já existente continua valendo.
