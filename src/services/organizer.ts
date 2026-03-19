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
  if (options?.extraContext) {
    userContent += `\nContexto adicional:\n${options.extraContext}\n`;
  }
  userContent += `\nTranscription:\n\n${transcript}`;

  const payload = {
    model: config.chatModel || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: config.organizationPrompt },
      { role: 'user', content: userContent },
    ],
    temperature: 1,
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
