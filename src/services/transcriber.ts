import * as fs from 'fs';
import { Config } from '../config';

interface DeepgramWord {
  word: string;
  punctuated_word: string;
  start: number;
  end: number;
  speaker: number;
  speaker_confidence: number;
  confidence: number;
}

interface DeepgramUtterance {
  start: number;
  end: number;
  transcript: string;
  speaker: number;
  confidence: number;
}

interface DeepgramResponse {
  metadata: { duration: number };
  results: {
    channels: Array<{
      alternatives: Array<{
        transcript: string;
        words: DeepgramWord[];
      }>;
    }>;
    utterances?: DeepgramUtterance[];
  };
}

// Apply speaker name mapping from config
function applySpeakerNames(text: string, config: Config): string {
  const names = config.speakerNames;
  if (!names || Object.keys(names).length === 0) return text;
  let result = text;
  for (const [id, name] of Object.entries(names)) {
    result = result.replace(new RegExp(`\\[Speaker ${id}\\]`, 'g'), `[${name}]`);
  }
  return result;
}

function formatDiarized(utterances: DeepgramUtterance[]): string {
  return utterances
    .map(u => `[Speaker ${u.speaker}] ${u.transcript.trim()}`)
    .join('\n');
}

function formatFromWords(words: DeepgramWord[]): string {
  const lines: string[] = [];
  let currentSpeaker = -1;
  let currentWords: string[] = [];
  for (const w of words) {
    const spk = w.speaker ?? 0;
    if (spk !== currentSpeaker) {
      if (currentWords.length > 0) {
        lines.push(`[Speaker ${currentSpeaker}] ${currentWords.join(' ')}`);
      }
      currentSpeaker = spk;
      currentWords = [];
    }
    currentWords.push(w.punctuated_word || w.word);
  }
  if (currentWords.length > 0) {
    lines.push(`[Speaker ${currentSpeaker}] ${currentWords.join(' ')}`);
  }
  return lines.join('\n');
}

function formatPlain(data: DeepgramResponse): string {
  return data.results.channels?.[0]?.alternatives?.[0]?.transcript?.trim() || '';
}

function detectContentType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || 'mp3';
  const map: Record<string, string> = {
    mp3: 'audio/mp3', wav: 'audio/wav', m4a: 'audio/m4a',
    ogg: 'audio/ogg', flac: 'audio/flac', webm: 'audio/webm',
  };
  return map[ext] || 'audio/mp3';
}

async function callDeepgram(audioBuffer: Buffer, contentType: string, params: URLSearchParams, config: Config): Promise<DeepgramResponse> {
  const url = `https://api.deepgram.com/v1/listen?${params}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Token ${config.deepgramApiKey}`,
      'Content-Type': contentType,
    },
    body: audioBuffer as unknown as BodyInit,
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Deepgram error ${response.status}: ${err}`);
  }
  const data = (await response.json()) as DeepgramResponse;

  // Debug: log if response has no transcript
  const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
  const duration = data.metadata?.duration || 0;
  if (!transcript.trim() && duration > 1) {
    console.error(`[deepgram] Empty transcript for ${(audioBuffer.length / 1024).toFixed(0)}KB audio (${duration.toFixed(1)}s). Model: ${params.get('model')}`);
  }

  return data;
}

// Fast mode: for live segments — no diarization, fast response
export async function transcribeFile(filePath: string, config: Config): Promise<string> {
  if (!config.deepgramApiKey) {
    throw new Error('deepgramApiKey nao configurado. Run: meeting config');
  }

  const audioBuffer = fs.readFileSync(filePath);
  const contentType = detectContentType(filePath);

  const params = new URLSearchParams({
    model: config.deepgramModel || 'nova-2',
    punctuate: 'true',
    smart_format: 'true',
    language: 'pt',
  });

  const data = await callDeepgram(audioBuffer, contentType, params, config);
  return formatPlain(data);
}

// Full mode: for final transcription — diarization + speaker names + nova-3
export async function transcribeFull(filePath: string, config: Config): Promise<string> {
  if (!config.deepgramApiKey) {
    throw new Error('deepgramApiKey nao configurado. Run: meeting config');
  }

  const audioBuffer = fs.readFileSync(filePath);
  const contentType = detectContentType(filePath);

  const params = new URLSearchParams({
    model: 'nova-3',
    diarize: 'true',
    utterances: 'true',
    punctuate: 'true',
    smart_format: 'true',
    language: 'pt',
  });

  const data = await callDeepgram(audioBuffer, contentType, params, config);

  let text: string;
  if (data.results.utterances && data.results.utterances.length > 0) {
    text = formatDiarized(data.results.utterances);
  } else {
    const words = data.results.channels?.[0]?.alternatives?.[0]?.words;
    if (words && words.length > 0) {
      text = formatFromWords(words);
    } else {
      text = formatPlain(data);
    }
  }

  return applySpeakerNames(text, config);
}
