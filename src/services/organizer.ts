import { Config } from '../config';

export interface OrganizeResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

// LiteLLM pricing estimates (gpt-4o-mini)
const PRICING = {
  input: 0.15 / 1_000_000,
  output: 0.60 / 1_000_000,
};

// Token budget for organization input (~4 chars/token heuristic)
const TOKEN_BUDGET = 5000;
const MAX_INPUT_CHARS = TOKEN_BUDGET * 4; // 20_000 chars

function applyTokenBudget(
  transcript: string,
  extraContext: string | undefined,
): { transcript: string; extraContext: string } {
  let ctx = extraContext ?? '';
  let tx = transcript;

  const measure = () => tx.length + (ctx ? ctx.length + 20 : 0);
  if (measure() <= MAX_INPUT_CHARS) return { transcript: tx, extraContext: ctx };

  // Step 1: keep only top-1 related meeting from extraContext
  const parts = ctx.split('\n---\n');
  ctx = parts.length > 1 ? parts[0] : '';

  if (measure() <= MAX_INPUT_CHARS) return { transcript: tx, extraContext: ctx };

  // Step 2: truncate transcript to last N lines that fit
  const budget = MAX_INPUT_CHARS - (ctx ? ctx.length + 20 : 0);
  const lines = tx.split('\n');
  const kept: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    total += lines[i].length + 1;
    if (total > budget) break;
    kept.unshift(lines[i]);
  }
  tx = (kept.length < lines.length ? '[...trecho anterior omitido por limite de contexto]\n' : '') + kept.join('\n');

  return { transcript: tx, extraContext: ctx };
}

function buildUrl(config: Config): string {
  let base = config.chatEndpoint;
  if (!base.endsWith('/')) base += '/';
  return `${base}chat/completions`;
}

function authHeader(config: Config): Record<string, string> {
  return { Authorization: `Bearer ${config.chatApiKey}` };
}

export interface OrganizeOptions {
  meetingDate?: string;     // YYYY-MM-DD for date resolution
  participants?: string[];  // from calendar, helps speaker inference
  extraContext?: string;    // additional context (past meetings, etc.)
}

export async function organizeTranscript(transcript: string, config: Config, options?: OrganizeOptions): Promise<OrganizeResult> {
  const url = buildUrl(config);

  // Build user message with metadata context
  let userContent = '';
  if (options?.meetingDate) {
    userContent += `Data da reuniao: ${options.meetingDate}\n`;
  }
  if (options?.participants && options.participants.length > 0) {
    userContent += `Participantes esperados (calendario): ${options.participants.join(', ')}\n`;
  }
  const { transcript: budgetedTranscript, extraContext: budgetedExtra } =
    applyTokenBudget(transcript, options?.extraContext);
  if (budgetedExtra) {
    userContent += `\nContexto adicional:\n${budgetedExtra}\n`;
  }
  userContent += `\nTranscription:\n\n${budgetedTranscript}`;

  const payload = {
    model: config.chatModel || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: config.organizationPrompt },
      { role: 'user', content: userContent },
    ],
    temperature: 0.3,
    max_tokens: 4000,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { ...authHeader(config), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Chat error ${response.status}: ${err}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };

  const usage = data.usage;
  const costUsd =
    usage.prompt_tokens * PRICING.input +
    usage.completion_tokens * PRICING.output;

  return {
    text: data.choices[0].message.content,
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    costUsd,
  };
}

export async function chatWithMeetings(
  messages: Array<{ role: string; content: string }>,
  config: Config
): Promise<string> {
  const url = buildUrl(config);

  const payload = {
    model: config.chatModel || 'gpt-4o-mini',
    messages,
    temperature: 0.7,
    max_tokens: 2000,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { ...authHeader(config), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Chat error ${response.status}: ${err}`);
  }

  const data = (await response.json()) as { choices: Array<{ message: { content: string } }> };
  return data.choices[0].message.content;
}
