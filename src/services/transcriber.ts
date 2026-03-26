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

export interface TranscribeOptions {
  diarize?: boolean;
  model?: string;
  speakerContext?: string;  // hint for speaker consistency across segments
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
    // Skip very low confidence words (noise/artifacts)
    if ((w.confidence ?? 1) < 0.3) continue;

    const spk = w.speaker ?? 0;
    // Only break speaker on confident transitions (avoid flicker)
    const confidentTransition = (w.speaker_confidence ?? 1) > 0.4;
    if (spk !== currentSpeaker && (confidentTransition || currentSpeaker === -1)) {
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

// Map remote speaker key ("remote-0", "remote-1") to a display name
// Uses config.speakerNames for known mappings, otherwise "Remoto N"
function formatRemoteSpeaker(key: string, config: Config): string {
  const speakerNum = key.replace('remote-', '');
  const names = config.speakerNames || {};
  // Check for direct mapping: "Speaker 0" -> "Lucas", etc.
  if (names[`Speaker ${speakerNum}`]) return names[`Speaker ${speakerNum}`];
  // Check for "remote-0" style mapping
  if (names[key]) return names[key];
  return `Remoto ${speakerNum}`;
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

// Format diarized transcription with speaker labels and multichannel support
function formatDiarizedTranscription(data: DeepgramResponse, config: Config, isStereo: boolean): string {
  const localSpeaker = config.speakerNames?.['local']
    || Object.values(config.speakerNames || {}).find(n => /gabriel/i.test(n))
    || 'Voce';

  let text: string;
  if (isStereo && data.results.channels && data.results.channels.length >= 2) {
    // Multichannel + diarization: interleave both channels by timestamp
    const remoteWords = (data.results.channels[0]?.alternatives?.[0]?.words || [])
      .map((w: DeepgramWord) => ({ ...w, channel: 0 }));
    const localWords = (data.results.channels[1]?.alternatives?.[0]?.words || [])
      .map((w: DeepgramWord) => ({ ...w, channel: 1 }));

    const allWords = [...remoteWords, ...localWords].sort((a, b) => a.start - b.start);

    const lines: string[] = [];
    let currentKey = '';
    let currentWords: string[] = [];

    for (const w of allWords) {
      // Skip noise
      if ((w.confidence ?? 1) < 0.3) continue;

      const key = w.channel === 1 ? 'local' : `remote-${w.speaker ?? 0}`;

      // Merge short fragments from same channel to reduce speaker flicker
      // e.g., remote-0 → remote-1 → remote-0 within 1 second = keep as remote-0
      if (key !== currentKey) {
        if (currentWords.length > 0) {
          lines.push(`[${currentKey === 'local' ? localSpeaker : formatRemoteSpeaker(currentKey, config)}] ${currentWords.join(' ')}`);
        }
        currentKey = key;
        currentWords = [];
      }
      currentWords.push(w.punctuated_word || w.word);
    }
    if (currentWords.length > 0) {
      lines.push(`[${currentKey === 'local' ? localSpeaker : formatRemoteSpeaker(currentKey, config)}] ${currentWords.join(' ')}`);
    }

    text = lines.length > 0 ? lines.join('\n') : formatPlain(data);
  } else if (data.results.utterances && data.results.utterances.length > 0) {
    text = formatDiarized(data.results.utterances);
  } else {
    const words = data.results.channels?.[0]?.alternatives?.[0]?.words;
    text = (words && words.length > 0) ? formatFromWords(words) : formatPlain(data);
  }

  return applySpeakerNames(text, config);
}

// Unified transcription: supports plain (fast) and diarized (full) modes
export async function transcribeFile(filePath: string, config: Config, options?: TranscribeOptions): Promise<string> {
  if (!config.deepgramApiKey) {
    throw new Error('deepgramApiKey nao configurado. Run: meeting config');
  }

  const diarize = options?.diarize ?? false;
  const model = options?.model || config.deepgramModel || 'nova-2';

  const audioBuffer = fs.readFileSync(filePath);
  const contentType = detectContentType(filePath);
  const channels = audioBuffer.readUInt16LE(22);
  const isStereo = channels === 2;

  const params = new URLSearchParams({
    model,
    punctuate: 'true',
    smart_format: 'true',
    language: 'pt',
  });

  if (diarize) {
    params.set('diarize', 'true');
    params.set('utterances', 'true');
    if (isStereo) {
      params.set('multichannel', 'true');
    }
  }

  // Boost speaker name recognition: keywords only supported on nova-2 english models
  // Removed: keywords param causes 400 errors on nova-3 and pt language models

  const data = await callDeepgram(audioBuffer, contentType, params, config);
  return diarize ? formatDiarizedTranscription(data, config, isStereo) : formatPlain(data);
}

// Convenience: full diarized transcription with nova-3
export async function transcribeFull(filePath: string, config: Config): Promise<string> {
  return transcribeFile(filePath, config, { diarize: true, model: 'nova-3' });
}
