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

## Busca & pergunta ao vault (fora de sessão, independe de gravação)

### `GET /search?q=<termo>&limit=20`

Busca léxica instantânea (índice em memória, **sem IA e sem custo**) sobre
`Meetings/*.md` e `Briefings/*.md`. Indexa `title`, `date`, `participants`, `tags`
(frontmatter) + corpo sem frontmatter, com peso maior para título/tags e boost de
recência. Normalização pt-BR: `reuniao` acha `reunião`; termos com 3+ chars também
casam por prefixo (`autoriz` acha `autorizador`).

```json
{ "results": [
  { "file": "Meetings/2026-08-01-1430-daily.md",
    "title": "Daily do time",
    "date": "2026-08-01",
    "snippet": "…trecho de ~160 chars centrado na primeira ocorrência, sem markdown…",
    "score": 12.481 }
] }
```

- `400 { error: 'q obrigatório' }` sem `q`; `404` se não há config.
- `limit` é clampado em 1..50 (default 20). Resultados ordenados por `score` desc.
- O índice se reconstrói sozinho quando passam 5 min **ou** quando o mtime de
  `Meetings/`/`Briefings/` muda — nota nova aparece na busca sem reiniciar o daemon.

### `POST /ask` `{ question }`

Pergunta agêntica ao vault: roda o `claude` headless com tools read-only
(Read/Grep/Glob) e `cwd` no vault, respondendo em PT-BR com citações.
**Custa dinheiro** e é lenta (~20-90s).

```json
{ "answer": "A última reunião registrada foi ... (2026-08-01)",
  "sources": [ { "file": "Meetings/2026-08-01-1430-daily.md", "title": "2026-08-01-1430-daily" } ],
  "costUsd": 0.0731 }
```

- `sources` vem da linha `FONTES: [[nota]] | [[nota]]` que o modelo emite no fim
  (removida do `answer`), resolvida para paths reais do vault por basename — nomes
  que não existem em disco são descartados. Fallback: wikilinks no corpo.
- **Uma pergunta por vez**: chamada concorrente → `409 { error: 'pergunta em andamento' }`.
- `400` sem `question`; `504` se passar de 3,5 min; `500 { error }` em falha do motor
  (ex: binário `claude` fora do PATH).
- Funciona gravando ou não. Início, fim, duração e custo vão para `/daemon/logs`.

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
