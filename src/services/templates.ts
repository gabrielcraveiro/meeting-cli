export interface MeetingTemplate {
  name: string;
  label: string;
  description: string;
  prompt: string;
}

// Shared rules appended to all prompts
const SHARED_RULES = `
Rules:
- TITLE: The FIRST line must be a short descriptive title for the meeting (no # prefix, no date, just the topic). Example: "Alinhamento Regulação Digital" or "Sprint Planning S14".
- PARTICIPANTS: The SECOND line must be: Participantes: Name1, Name2 (comma-separated). If names are not identifiable, use Speaker 0, Speaker 1.
- SPEAKER INFERENCE: If names are mentioned in the conversation (e.g., "valeu, Ana" or "o Gabriel falou"), use those real names INSTEAD of Speaker labels throughout the entire note.
- TIMESTAMPS: Include [MM:SS] references in decisions and action items, pointing to the approximate time in the transcript where they were discussed.
- ACTION ITEMS: Format as a markdown table: | Acao | Responsavel | Prazo | Prioridade |
- NO "Transcrição Limpa" section — the raw transcript is saved separately.
- Respond ONLY with the formatted note, no preamble.
- Write in Portuguese (Brazil). Keep technical terms and proper nouns as-is.
- Skip sections that have no content — do NOT write "Nenhuma decisão registrada" or similar. Just omit the section entirely.`;

// Adaptive wrappers: injected BEFORE the template prompt based on duration
export const ADAPTIVE_WRAPPERS: Record<string, string> = {
  quick: // < 2 min
    'This is a VERY SHORT recording (under 2 minutes). Generate a QUICK NOTE:\n' +
    '- Title (first line)\n' +
    '- Participantes (second line)\n' +
    '- One paragraph summary (3-5 sentences max)\n' +
    '- Action items table ONLY if any were mentioned\n' +
    '- Nothing else. No formal sections, no headers except Action Items.\n\n',

  short: // 2-10 min
    'This is a SHORT recording (2-10 minutes). Generate a CONCISE NOTE with only these sections:\n' +
    '- Title (first line)\n' +
    '- Participantes (second line)\n' +
    '- ## Resumo (2-4 sentences)\n' +
    '- ## Pontos Principais (bulleted)\n' +
    '- ## Action Items (table, if any)\n' +
    '- Skip all other sections.\n\n',

  standard: // 10-30 min — uses full template prompt as-is
    '',

  deep: // > 30 min
    'This is a LONG recording (30+ minutes). Generate a COMPREHENSIVE note.\n' +
    'In addition to the standard sections, include:\n' +
    '- ## Timeline — chronological list of topics with timestamps [MM:SS]\n' +
    '- ## Riscos & Preocupacoes — any risks, concerns, or blockers raised\n' +
    '- Be thorough but concise. Group related points.\n\n',
};

export function getAdaptiveWrapper(durationSec: number): string {
  if (durationSec < 120) return ADAPTIVE_WRAPPERS.quick;
  if (durationSec < 600) return ADAPTIVE_WRAPPERS.short;
  if (durationSec < 1800) return ADAPTIVE_WRAPPERS.standard;
  return ADAPTIVE_WRAPPERS.deep;
}

export const TEMPLATES: Record<string, MeetingTemplate> = {
  default: {
    name: 'default',
    label: 'Padrão',
    description: 'Reunião genérica com resumo completo',
    prompt:
      'You are an expert meeting secretary. You receive a transcript with timestamps and speaker labels.\n\n' +
      'Produce a structured meeting note in Portuguese (Brazil) with these sections:\n\n' +
      '## Resumo\nA concise 2-4 sentence executive overview. This should be meaningful enough to understand the meeting without reading further.\n\n' +
      '## Pontos Principais\nBulleted list of key topics discussed.\n\n' +
      '## Decisoes Tomadas\nBulleted list with [MM:SS] timestamp references.\n\n' +
      '## Action Items\nTable format: | Acao | Responsavel | Prazo | Prioridade |\n\n' +
      SHARED_RULES,
  },

  daily: {
    name: 'daily',
    label: 'Daily Standup',
    description: 'Standup rápido — o que fez, o que vai fazer, blockers',
    prompt:
      'You are a scrum master assistant. You receive a daily standup transcript.\n\n' +
      'Produce a structured note in Portuguese (Brazil):\n\n' +
      'For each participant, extract:\n' +
      '### [Name]\n' +
      '- **Ontem:** what they did\n' +
      '- **Hoje:** what they plan to do\n' +
      '- **Blockers:** any impediments\n\n' +
      'Then:\n' +
      '## Resumo\n1-2 sentences on sprint health.\n\n' +
      '## Blockers Ativos\nConsolidated list. Omit if none.\n\n' +
      SHARED_RULES,
  },

  '1on1': {
    name: '1on1',
    label: '1:1',
    description: 'Reunião individual — feedback, carreira, ações',
    prompt:
      'You are an expert people manager assistant. You receive a 1:1 meeting transcript.\n\n' +
      'Produce a structured note in Portuguese (Brazil):\n\n' +
      '## Topicos Discutidos\nBulleted list.\n\n' +
      '## Feedback\nAny feedback given/received, with context.\n\n' +
      '## Desenvolvimento & Carreira\nGrowth, goals, career topics. Omit if not discussed.\n\n' +
      '## Action Items\nTable format: | Acao | Responsavel | Prazo | Prioridade |\n\n' +
      '## Observacoes\nBrief note on mood, engagement, concerns.\n\n' +
      SHARED_RULES,
  },

  retro: {
    name: 'retro',
    label: 'Retrospectiva',
    description: 'Sprint retro — o que deu certo, o que melhorar, ações',
    prompt:
      'You are a scrum facilitator. You receive a sprint retrospective transcript.\n\n' +
      'Produce a structured note in Portuguese (Brazil):\n\n' +
      '## O que deu certo\nBulleted list of positives.\n\n' +
      '## O que pode melhorar\nBulleted list of improvement areas.\n\n' +
      '## Ideias & Sugestoes\nBulleted list of ideas proposed.\n\n' +
      '## Action Items\nTable format: | Acao | Responsavel | Prazo | Prioridade |\n\n' +
      '## Resumo\n2-3 sentences on sprint sentiment.\n\n' +
      SHARED_RULES,
  },

  planning: {
    name: 'planning',
    label: 'Planning',
    description: 'Sprint planning — escopo, estimativas, compromissos',
    prompt:
      'You are a scrum master assistant. You receive a sprint planning transcript.\n\n' +
      'Produce a structured note in Portuguese (Brazil):\n\n' +
      '## Objetivo da Sprint\n1-2 sentences.\n\n' +
      '## Itens Planejados\nTable: | Item | Estimativa | Responsavel |\n\n' +
      '## Duvidas & Dependencias\nQuestions, external deps.\n\n' +
      '## Capacidade do Time\nAvailability, vacation mentions.\n\n' +
      '## Compromissos\nWhat the team committed to.\n\n' +
      SHARED_RULES,
  },

  technical: {
    name: 'technical',
    label: 'Técnica',
    description: 'Discussão técnica — arquitetura, decisões, trade-offs',
    prompt:
      'You are a senior software architect assistant. You receive a technical discussion transcript.\n\n' +
      'Produce a structured note in Portuguese (Brazil):\n\n' +
      '## Contexto\nBrief description of the problem.\n\n' +
      '## Opcoes Avaliadas\nEach option with pros/cons.\n\n' +
      '## Decisao\nChosen approach with [MM:SS] reference and rationale.\n\n' +
      '## Riscos & Trade-offs\nKnown risks.\n\n' +
      '## Action Items\nTable format: | Acao | Responsavel | Prazo | Prioridade |\n\n' +
      SHARED_RULES,
  },

  knowledge: {
    name: 'knowledge',
    label: 'Conhecimento',
    description: 'Sessão de conhecimento — onboarding, explicação de domínio, treinamento',
    prompt:
      'You are a domain knowledge analyst. You receive a transcript of a knowledge transfer / onboarding / training session.\n\n' +
      'Your goal is to CAPTURE ALL DOMAIN KNOWLEDGE explained, structured for future reference. This is NOT a status meeting — the value is in the concepts, rules and flows explained.\n\n' +
      'Produce a structured note in Portuguese (Brazil):\n\n' +
      '## Resumo\n2-4 sentences: what domain/system was explained, who was teaching, who was learning.\n\n' +
      '## Glossario\nBulleted list of domain terms defined or explained in the conversation. Format:\n' +
      '- **Term**: definition/explanation as described in the meeting\n' +
      'Include ALL terms, even if they seem obvious — this note serves as reference.\n\n' +
      '## Regras de Negocio\nBulleted list of business rules, constraints, and conditions explained. Be SPECIFIC — include percentages, limits, exceptions, edge cases. Format:\n' +
      '- Rule description with concrete examples when given\n\n' +
      '## Fluxos\nDescribe each workflow/process explained. Use numbered steps or sub-bullets. Include:\n' +
      '- The happy path\n' +
      '- Variations and exceptions mentioned\n' +
      '- Which system/team handles each step\n\n' +
      '## Exemplos Citados\nSpecific real-world examples given during the explanation (company names, products, scenarios). These are valuable for understanding the rules in practice.\n\n' +
      '## Pontos de Atencao\nGotchas, edge cases, "cuidado com isso", historical context ("isso foi discutido em 2025 mas caiu"). Things that are easy to get wrong.\n\n' +
      '## Action Items\nTable format: | Acao | Responsavel | Prazo | Prioridade |\n\n' +
      SHARED_RULES,
  },
};

export function getTemplate(name: string): MeetingTemplate | null {
  return TEMPLATES[name] || null;
}

export function listTemplates(): MeetingTemplate[] {
  return Object.values(TEMPLATES);
}
