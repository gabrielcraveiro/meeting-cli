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
como esqueleto (userNotes em OrganizeOptions).

## Enhance (contrato de dados na nota final)

A nota final ganha no frontmatter: `sourceNotes: true` quando houve anotações
do usuário. O organizer recebe `userNotes: [{ ts, text }]` e as trata como
ESQUELETO (prioridade sobre estrutura padrão).

## Regras

- Nada de estado em disco novo: sessão ao vivo é memória do daemon (morre com ele).
- Timeouts SSE: heartbeat `: ping` a cada 15s.
- Tudo 127.0.0.1; validação de Origin já existente continua valendo.
