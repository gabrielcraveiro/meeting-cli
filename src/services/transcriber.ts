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

function formatDiarized(utterances: DeepgramUtterance[]): string {
  return utterances
    .map(u => `[Speaker ${u.speaker}] ${u.transcript.trim()}`)
    .join('\n');
}

function formatFromWords(words: DeepgramWord[]): string {
  // fallback: group consecutive words by speaker
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

export async function transcribeFile(filePath: string, config: Config): Promise<string> {
  if (!config.deepgramApiKey) {
    throw new Error('deepgramApiKey não configurado. Run: meeting config');
  }

  const audioBuffer = fs.readFileSync(filePath);

  const params = new URLSearchParams({
    model: config.deepgramModel || 'nova-2',
    diarize: 'true',
    utterances: 'true',
    punctuate: 'true',
    smart_format: 'true',
    detect_language: 'true',
  });

  // Detect content type from file extension
  const ext = filePath.split('.').pop()?.toLowerCase() || 'mp3';
  const contentTypeMap: Record<string, string> = {
    mp3: 'audio/mp3',
    wav: 'audio/wav',
    m4a: 'audio/m4a',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    webm: 'audio/webm',
  };
  const contentType = contentTypeMap[ext] || 'audio/mp3';

  const response = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${config.deepgramApiKey}`,
      'Content-Type': contentType,
    },
    body: audioBuffer,
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Deepgram error ${response.status}: ${err}`);
  }

  const data = (await response.json()) as DeepgramResponse;

  // Use utterances (grouped by speaker) when available — best quality
  if (data.results.utterances && data.results.utterances.length > 0) {
    return formatDiarized(data.results.utterances);
  }

  // Fallback: build from words array
  const words = data.results.channels?.[0]?.alternatives?.[0]?.words;
  if (words && words.length > 0) {
    return formatFromWords(words);
  }

  // Last resort: plain transcript
  return data.results.channels?.[0]?.alternatives?.[0]?.transcript?.trim() || '';
}
