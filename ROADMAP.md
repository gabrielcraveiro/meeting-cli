# Roadmap — meeting-cli como copiloto de produtividade

> Objetivo: sair de "gravador com notas boas" para "sistema que devolve tempo":
> nada combinado em reunião se perde, nada precisa ser reescrito à mão, e o
> contexto certo aparece sozinho na hora certa.

## Fase 0 — Validar e criar o hábito (esta semana, esforço: zero código)

O sistema já sobe sozinho no boot. O que falta é rodar em condições reais:

- [ ] 3+ calls reais com gente: conferir legendas em PT, nomes reais na nota,
      `IA (claude)` na finalização, toast no fim
- [ ] Usar o **chat ao vivo** pelo menos 1x por reunião (terminal minimizado →
      clicar → perguntar "o que ficou decidido até agora?") — é a feature mais
      subestimada e já existe
- [ ] Responder o prompt de **contexto pós-reunião** (2 frases suas valem mais
      que 10 min de transcrição pro resumo ficar certo)
- [ ] Ajustar o que incomodar (idioma da legenda, gain do mic, template errado)

**Critério de saída**: 1 semana sem precisar editar nota à mão no Obsidian.

## Fase 1 — Briefing matinal: o sistema olha pra frente (~meio dia) — ✅ implementado

Hoje tudo acontece depois da reunião. O maior ganho de produtividade é ANTES:

- [x] `meeting briefing`: motor claude lê agenda (ICS) + vault e gera o dia
      (`src/commands/briefing.ts`; flags `--quiet` para cron e `--no-note`):
  - [x] reuniões de hoje, com pendências das reuniões anteriores com as mesmas pessoas
  - [x] action items abertos no vault (formato Obsidian Tasks — ver Fase 2) que
        vencem hoje ou estão parados (>7 dias)
  - [x] "tema recorrente há 3 semanas sem decisão" (o que ninguém percebe sozinho)
  - [x] degradação: sem ICS roda só com o vault; sem o binário `claude` monta
        briefing básico (agenda + grep de `- [ ] `) e avisa
- [x] Agendado 8h seg-sex (cron WSL) → toast + nota `Briefings/YYYY-MM-DD.md` no vault.
      Instalar com `bash scripts/install-briefing-schedule.sh` (idempotente;
      `--remove` desfaz). Usa caminho absoluto do binário — fnm não está no PATH
      de shell não-interativo.
- [ ] Bônus (pendente): toast 5 min antes de cada call com o resumo da última
      reunião com aquelas pessoas ("contexto de bolso")

**Por que primeiro**: reaproveita 100% do motor claude + calendar.ts que já
existem. É prompt + comando + cron.

## Fase 2 — Tasks vivem no Obsidian (~1 dia) — ✅ implementado

Ferramenta pessoal → tasks pessoais no vault (Jira fica fora de propósito:
esfera corporativa separada). Usar o Obsidian na capacidade máxima:

- [x] Action items da nota saem no formato **Obsidian Tasks**:
      `- [ ] **Ana:** Validar fluxo de elegibilidade 📅 2026-08-05 #meeting/action`
      (claude infere prazo do contexto da conversa quando mencionado; sem prazo,
      o 📅 é omitido). Instruído nos dois motores: `<workflow>` do
      `claudeOrganizer.ts` e `DEFAULT_PROMPT` do `config.ts` (engine chat).
- [x] Nota-dashboard `Tasks.md` no vault: queries do plugin Tasks agregando
      action items abertos por prazo, mais bloco de vencidas e de concluídas
      recentes. Criada por `ensureTasksDashboard()` em `services/storage.ts`,
      chamada em `createMeetingNote` — só cria se não existir, nunca sobrescreve.
- [x] Tasks concluídas você marca no próprio Obsidian (checkbox) — o briefing
      matinal (Fase 1) ignora `- [x] ` e para de cobrar o que já foi feito
- [ ] Backlinks automáticos (parcial): o briefing referencia `[[nota de origem]]`;
      falta a linha da task na nota carregar o link para a reunião de origem
      (hoje a task já vive dentro da própria nota, então o backlink é implícito)

**Métrica**: abrir o Obsidian de manhã e a lista de pendências estar completa
sem você ter digitado nenhuma task.

## Fase 3 — Memória institucional consultável (~1 dia)

O vault vira ativo composto conforme cresce — se der pra perguntar:

- `meeting ask "o que já decidimos sobre elegibilidade?"` — claude headless
  com Grep/Read no vault inteiro, resposta com citações e datas
- Digest semanal (sexta 17h): decisões da semana, action items abertos por
  pessoa, temas que voltaram — pronto pra colar no status report
- Detecção de contradição: "isso contradiz o que foi decidido em 12/07" como
  seção da nota quando aplicável

## Fase 4 — Copiloto ativo na call: Tauri (sessão dedicada, ~2-3 dias)

Só depois do fluxo passivo estar sólido:

- App tray Tauri substitui o script PowerShell: janela com transcript ao vivo,
  insights e o chat (daemon já é HTTP; falta expor /transcript, /chat via SSE)
- Notificações contextuais em tempo real: "seu nome foi citado", "action item
  atribuído a você", respeitando a supressão de screen-share
- Daemon vira serviço systemd (terminal morre de vez — o chat já terá casa nova)

## Fase 5 — Robustez (contínuo, fazer junto com as outras)

- Testes nos contratos frágeis: parse título/participantes da saída da IA,
  protocolo do bridge file, merge de legendas
- `meeting stats`: custo por engine (claude vs chat) por semana, pra decidir
  modelo com dados
- Alerta quando os seletores do Teams quebrarem (extensão detecta call mas
  0 legendas/roster em 5 min → toast "extensão precisa de manutenção")

---

## Princípios (pra não virar over-engineering)

1. **Funcionar > qualidade fina** — fallbacks em tudo (captions→deepgram,
   claude→chat); uma nota medíocre existe, uma nota perfeita que falhou não.
2. **Semi-automático em ações externas** — criar Jira, mandar mensagem:
   sempre com aprovação. Automação total só no que é reversível.
3. **Cada fase útil sozinha** — nunca duas fases em paralelo; validar antes
   de avançar.
