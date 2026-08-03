# Spec — Meeting App (paridade Granola, contexto meeting-cli)

> Alvo: a experiência Granola 1:1 — tela de anotação + agente + visualização —
> sobre o motor que já existe (daemon HTTP, legendas do Teams, claude engine,
> vault Obsidian). O Obsidian NÃO é abandonado: vira a camada de arquivo/
> conhecimento (notas finais, tasks, grafo). A UI nova é onde a reunião
> ACONTECE; o vault é onde ela DESCANSA.

## Princípio de design (roubado do Granola)

Durante a reunião, a tela é um bloco de notas e NADA MAIS. Sem transcript
rolando na cara, sem IA falante, sem métricas. A inteligência trabalha
invisível e só aparece quando chamada. "Human-led outline" — o que VOCÊ
digita é o sinal do que importa.

## Telas

### 1. Home (janela ancorada no tray, ~380x560)

┌──────────────────────────────────┐
│ ☀ Briefing do dia            [>] │  ← colapsa/expande (meeting briefing)
├──────────────────────────────────┤
│ HOJE                             │
│ ● 10:00 Alinhamento Regulação    │  ← do ICS; bolinha verde = em call agora
│   14:00 1:1 Fulana               │
│   16:30 Planning PBM             │
├──────────────────────────────────┤
│ RECENTES                         │
│   ontem  Retro squad · 4 tasks   │  ← notas finais (lê do vault)
│   30/07  Kickoff elegibilidade   │
├──────────────────────────────────┤
│ [+ Nota manual]        [⚙]       │
└──────────────────────────────────┘

- Call detectada (extensão→daemon) → toast + item de hoje pulsa → clique abre a Nota.
- Reunião agendada: nota pode ser aberta ANTES (pré-anotações entram no enhance).

### 2. Nota (tela principal — in-meeting)

┌──────────────────────────────────────────────┐
│ Alinhamento Regulação Digital       ● REC 12:34 │  ← discreto, sem vermelho gritante
├──────────────────────────────────────────────┤
│                                              │
│  - maria manda dados piloto amanhã           │  ← SEU notepad (markdown livre,
│  - decidido: fluxo B                         │     bullets timestampados por baixo)
│  - conferir número 340k                      │
│                                              │
│                                              │
├──────────────────────────────────────────────┤
│ [〰]  Pergunte qualquer coisa…          [→]  │  ← waveform: toggle transcript
└──────────────────────────────────────────────┘     barra = chat com a reunião AO VIVO

- [〰] abre painel lateral com o transcript ao vivo (legendas Teams + Deepgram),
  atualizando linha a linha. Fechado por padrão.
- Barra "Pergunte qualquer coisa": usa o buildSystemMsg() que já existe no
  start.ts (contexto = transcript ao vivo + vault + notas passadas).
- Insights (3/3min, já existem) chegam como cartõezinhos dispensáveis no rodapé,
  NUNCA como popup. Suprimidos durante screen-share (flag já existe).

### 3. Nota Enhanced (pós-reunião — a visualização)

- Enhance roda AUTOMÁTICO no fim da call (pipeline atual: claude engine).
- Suas anotações = esqueleto; transcript = músculo. Cada bullet seu vira
  parágrafo/seção expandida; o que você não anotou entra depois (Resumo,
  Decisões, Tasks — contrato atual).
- **Lupinha (🔍) por bloco**: hover em qualquer trecho da nota → pop-up com o
  trecho EXATO do transcript que o sustenta (timestamp + speaker). Implementação:
  o organizer já emite [MM:SS] — a UI ancora cada bloco ao intervalo e recorta
  o transcript correspondente.
- Toggle "Original / Enhanced": suas notas cruas nunca são destruídas.
- Botão "Abrir no Obsidian" (obsidian://open?vault=...&file=...).

## Arquitetura (tudo já aponta pra cá)

┌───────────┐ SSE/HTTP ┌────────────────────┐      ┌──────────────┐
│ Tauri app │ ◀──────▶ │ meeting daemon     │ ───▶ │ vault (.md)  │
│ (webview) │          │ (vira o cérebro)   │      │ notas+tasks  │
└───────────┘          └────────────────────┘      └──────────────┘
                          ▲            ▲
                   extensão Firefox   sidecar WASAPI

Daemon ganha (a sessão de gravação passa a reportar pro daemon em vez de TUI):
- GET  /meetings/today        (ICS + estado)
- GET  /transcript/stream     (SSE — linhas ao vivo)
- GET  /insights/stream       (SSE — cartões 3/3min)
- POST /notes                 (bullets do usuário, timestampados)
- POST /chat                  (pergunta → resposta com contexto ao vivo)
- GET  /note/:id              (nota final + mapa bloco→[MM:SS] pra lupinha)

A TUI continua existindo (meeting start puro) — o app é outro cliente do
mesmo daemon, igual a extensão. Nada é reescrito, só exposto.

## Divisão em entregas (sessão dedicada, ordem de valor)

1. **Notepad + enhance** — janela Tauri com editor, POST /notes, notas do
   usuário entram no organizer como esqueleto (Granola-core). Sem chat ainda.
2. **Barra "pergunte qualquer coisa" + transcript toggle** (SSE).
3. **Lupinha nota→transcript** + Home com agenda + briefing embutido.
4. **Insights como cartões** + polimento (atalho global, autostart, ícone).

## O que NÃO copiar do Granola

- Compartilhamento/links públicos (ferramenta pessoal, vault local).
- Pastas próprias (o vault já organiza; a Home só lê).
- Cloud sync (nosso "sync" é o vault).
