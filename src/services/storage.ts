import * as fs from 'fs';
import * as path from 'path';
import { Config } from '../config';

export interface MeetingMeta {
  fileName: string;
  filePath: string;
  date: string;
  time: string;
  audioSeconds: number;
  estimatedCostUsd: number;
  aiModel: string;
  status: string;
  hasSummary: boolean;
}

export function parseFrontmatter(content: string): Record<string, string> {
  const meta: Record<string, string> = {};
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return meta;
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    meta[key] = value;
  }
  return meta;
}

export function extractSection(content: string, heading: string): string {
  // Match heading with optional emoji prefix (compat with old notes)
  const regex = new RegExp(`## (?:[^\\w]*)?${heading}\\n([\\s\\S]*?)(?=\\n## |$)`);
  const match = content.match(regex);
  return match ? match[1].trim() : '';
}

export function listMeetings(config: Config): MeetingMeta[] {
  const meetingsDir = path.join(config.vaultPath, 'Meetings');
  if (!fs.existsSync(meetingsDir)) return [];

  const files = fs.readdirSync(meetingsDir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .reverse();

  return files.map(fileName => {
    const filePath = path.join(meetingsDir, fileName);
    const content = fs.readFileSync(filePath, 'utf-8');
    const meta = parseFrontmatter(content);
    const summary = extractSection(content, 'AI Summary');

    return {
      fileName,
      filePath,
      date: meta['date'] || '',
      time: meta['time'] || '',
      audioSeconds: parseInt(meta['audio_seconds'] || '0') || 0,
      estimatedCostUsd: parseFloat(meta['estimated_cost_usd'] || '0') || 0,
      aiModel: meta['ai_model'] || '',
      status: meta['status'] || '',
      hasSummary: !!summary && !summary.includes('Generating summary'),
    };
  });
}

export function loadMeetingContent(config: Config, limit = 10): string[] {
  const meetings = listMeetings(config).slice(0, limit);
  return meetings.map(m => {
    const content = fs.readFileSync(m.filePath, 'utf-8');
    const transcript = extractSection(content, 'Transcription');
    const summary = extractSection(content, 'AI Summary');
    const text = summary && !summary.includes('Generating') ? summary : transcript;
    return `[${m.date} ${m.time}]\n${text}`;
  });
}

// Lightweight version: only summaries, no transcripts — for context injection
export function loadMeetingSummaries(config: Config, limit = 5): string[] {
  const meetings = listMeetings(config).slice(0, limit);
  const results: string[] = [];
  for (const m of meetings) {
    const content = fs.readFileSync(m.filePath, 'utf-8');
    const summary = extractSection(content, 'AI Summary');
    if (summary && !summary.includes('Generating')) {
      results.push(`[${m.date} ${m.time}]\n${summary}`);
    }
  }
  return results;
}

export async function createMeetingNote(
  config: Config,
  params: {
    transcript: string;
    summary: string;
    audioPath?: string;
    durationSec: number;
    whisperCost: number;
    chatCost: number;
    chatDeployment: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    date: string;
    time: string;
    tags?: string[];
    title?: string;
    participants?: string[];
  }
): Promise<string> {
  const meetingsDir = path.join(config.vaultPath, 'Meetings');
  fs.mkdirSync(meetingsDir, { recursive: true });

  const title = params.title || 'Meeting';
  const timeLabel = params.time.replace(':', '-');
  const fileName = `${params.date} ${timeLabel} - ${title.replace(/[/\\:*?"<>|]/g, '-').slice(0, 60)}.md`;
  const filePath = path.join(meetingsDir, fileName);
  const totalCost = (params.whisperCost + params.chatCost).toFixed(4);

  const baseTags = ['meeting'];
  const allTags = [...new Set([...baseTags, ...(params.tags || [])])];
  const participantsList = params.participants && params.participants.length > 0
    ? `\nparticipants: [${params.participants.join(', ')}]` : '';

  const content = `---
type: meeting
tags: [${allTags.join(', ')}]${participantsList}
date: ${params.date}
time: ${params.time}
title: "${title}"
status: done
audio_seconds: ${Math.round(params.durationSec)}
transcription_model: deepgram
ai_model: ${params.chatDeployment}
ai_input_tokens: ${params.inputTokens}
ai_output_tokens: ${params.outputTokens}
ai_total_tokens: ${params.totalTokens}
transcription_cost_usd: ${params.whisperCost.toFixed(4)}
ai_cost_usd: ${params.chatCost.toFixed(4)}
estimated_cost_usd: ${totalCost}
---
# ${title}

${params.audioPath ? `![[${params.audioPath}]]` : ''}

## AI Summary
${params.summary}

## Transcription
${params.transcript}
`;

  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}
