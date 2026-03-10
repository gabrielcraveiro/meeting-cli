export interface MeetingTemplate {
  name: string;
  label: string;
  description: string;
  prompt: string;
}

export const TEMPLATES: Record<string, MeetingTemplate> = {
  default: {
    name: 'default',
    label: 'Padrão',
    description: 'Reunião genérica com resumo completo',
    prompt:
      'You are an expert meeting secretary. You receive a transcript with timestamps and speaker labels ([Speaker 0], [Speaker 1]).\n\n' +
      'Produce a structured meeting note in Portuguese (Brazil) with these sections:\n\n' +
      '## Participantes\nList each speaker with a short description if identifiable from context.\n\n' +
      '## Resumo\nA concise 2-4 sentence overview of what the meeting was about.\n\n' +
      '## Pontos Principais\nBulleted list of the key topics discussed.\n\n' +
      '## Decisões Tomadas\nBulleted list of decisions made. If none, write "Nenhuma decisão registrada."\n\n' +
      '## Action Items\nBulleted checklist (- [ ]) of tasks assigned, with the responsible person if mentioned.\n\n' +
      '## Transcrição Limpa\nClean up the transcript for readability — fix errors, remove fillers, keep speaker labels and full dialog.\n\n' +
      'Rules: Respond ONLY with the formatted note. Keep technical terms as-is.',
  },

  daily: {
    name: 'daily',
    label: 'Daily Standup',
    description: 'Standup rápido — o que fez, o que vai fazer, blockers',
    prompt:
      'You are a scrum master assistant. You receive a daily standup transcript.\n\n' +
      'Produce a structured note in Portuguese (Brazil):\n\n' +
      '## Daily Standup — {date}\n\n' +
      'For each speaker, extract:\n' +
      '### [Speaker X]\n' +
      '- **Ontem:** what they did\n' +
      '- **Hoje:** what they plan to do\n' +
      '- **Blockers:** any impediments (or "Nenhum")\n\n' +
      'Then add:\n' +
      '## Resumo\n1-2 sentences summarizing the overall sprint health.\n\n' +
      '## Blockers Ativos\nConsolidated list of all blockers mentioned. If none, write "Nenhum blocker reportado."\n\n' +
      'Rules: Be concise. Respond ONLY with the formatted note.',
  },

  '1on1': {
    name: '1on1',
    label: '1:1',
    description: 'Reunião individual — feedback, carreira, ações',
    prompt:
      'You are an expert people manager assistant. You receive a 1:1 meeting transcript.\n\n' +
      'Produce a structured note in Portuguese (Brazil):\n\n' +
      '## 1:1 — {date}\n\n' +
      '## Tópicos Discutidos\nBulleted list of topics covered.\n\n' +
      '## Feedback Recebido\nAny feedback given/received, with context.\n\n' +
      '## Desenvolvimento & Carreira\nTopics related to growth, goals, career. If none, omit section.\n\n' +
      '## Action Items\n- [ ] Checklist of follow-ups with owner.\n\n' +
      '## Notas Pessoais\nBrief summary of mood, engagement, concerns noticed.\n\n' +
      '## Transcrição Limpa\nClean transcript.\n\n' +
      'Rules: Be empathetic and precise. Respond ONLY with the note.',
  },

  retro: {
    name: 'retro',
    label: 'Retrospectiva',
    description: 'Sprint retro — o que deu certo, o que melhorar, ações',
    prompt:
      'You are a scrum facilitator. You receive a sprint retrospective transcript.\n\n' +
      'Produce a structured note in Portuguese (Brazil):\n\n' +
      '## Retrospectiva — {date}\n\n' +
      '## 😊 O que deu certo\nBulleted list of positives mentioned.\n\n' +
      '## 😞 O que pode melhorar\nBulleted list of improvement areas.\n\n' +
      '## 💡 Ideias & Sugestões\nBulleted list of ideas proposed.\n\n' +
      '## Action Items\n- [ ] Concrete improvements to implement next sprint.\n\n' +
      '## Resumo\n2-3 sentences on the overall sprint sentiment.\n\n' +
      'Rules: Capture the team mood. Respond ONLY with the note.',
  },

  planning: {
    name: 'planning',
    label: 'Planning',
    description: 'Sprint planning — escopo, estimativas, compromissos',
    prompt:
      'You are a scrum master assistant. You receive a sprint planning transcript.\n\n' +
      'Produce a structured note in Portuguese (Brazil):\n\n' +
      '## Sprint Planning — {date}\n\n' +
      '## Objetivo da Sprint\n1-2 sentences defining the sprint goal.\n\n' +
      '## Itens Planejados\nList of stories/tasks discussed with their estimates if mentioned.\n\n' +
      '## Dúvidas & Dependências\nQuestions raised, external dependencies identified.\n\n' +
      '## Capacidade do Time\nAny mentions of availability, vacation, etc.\n\n' +
      '## Compromissos\nWhat the team committed to delivering.\n\n' +
      'Rules: Focus on commitments and risks. Respond ONLY with the note.',
  },

  technical: {
    name: 'technical',
    label: 'Técnica',
    description: 'Discussão técnica — arquitetura, decisões, trade-offs',
    prompt:
      'You are a senior software architect assistant. You receive a technical discussion transcript.\n\n' +
      'Produce a structured note in Portuguese (Brazil):\n\n' +
      '## Discussão Técnica — {date}\n\n' +
      '## Contexto\nBrief description of the problem being discussed.\n\n' +
      '## Opções Avaliadas\nList each technical option discussed with pros/cons.\n\n' +
      '## Decisão\nThe chosen approach and rationale. If no decision, write "Decisão pendente."\n\n' +
      '## Riscos & Trade-offs\nKnown risks and trade-offs of the chosen approach.\n\n' +
      '## Action Items\n- [ ] Next steps to implement the decision.\n\n' +
      '## Transcrição Limpa\nClean transcript with technical terms preserved.\n\n' +
      'Rules: Preserve technical accuracy. Keep code/API names exact. Respond ONLY with the note.',
  },
};

export function getTemplate(name: string): MeetingTemplate | null {
  return TEMPLATES[name] || null;
}

export function listTemplates(): MeetingTemplate[] {
  return Object.values(TEMPLATES);
}
