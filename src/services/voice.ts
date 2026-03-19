// ── Voice Fingerprinting Service ──
// Calls the Python sidecar (Resemblyzer) for speaker embedding extraction and matching.
// Graceful degradation: if Python or Resemblyzer is not installed, returns empty results.

import { execFile } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const VOICES_DIR = path.join(os.homedir(), '.config', 'meeting-cli', 'voices');
const SIDECAR_SCRIPT = path.resolve(__dirname, '..', 'sidecar', 'voice_embed.py');
const SIDECAR_FALLBACK = path.resolve(__dirname, '..', '..', 'sidecar', 'voice_embed.py');

interface VoiceMatch {
  name: string;
  similarity: number;
}

interface VoiceResult {
  embedding?: number[];
  matches?: VoiceMatch[];
  saved?: string;
  error?: string;
}

function findScript(): string {
  if (fs.existsSync(SIDECAR_SCRIPT)) return SIDECAR_SCRIPT;
  if (fs.existsSync(SIDECAR_FALLBACK)) return SIDECAR_FALLBACK;
  throw new Error('voice_embed.py not found');
}

function runPython(args: string[], timeout = 30000): Promise<VoiceResult> {
  return new Promise((resolve) => {
    const script = findScript();
    // Try multiple approaches: uv run (modern), python3, python
    const approaches = [
      { cmd: 'uv', args: ['run', '--with', 'resemblyzer', 'python3', script, ...args] },
      { cmd: 'python3', args: [script, ...args] },
      { cmd: 'python', args: [script, ...args] },
    ];

    let attemptIdx = 0;
    const tryNext = () => {
      if (attemptIdx >= approaches.length) {
        resolve({ error: 'Voice sidecar failed: python/uv not found or resemblyzer not installed' });
        return;
      }
      const { cmd, args: cmdArgs } = approaches[attemptIdx++];
      execFile(cmd, cmdArgs, { timeout, encoding: 'utf-8' }, (err, stdout) => {
        if (err) {
          tryNext();
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch {
          resolve({ error: `Invalid JSON from voice sidecar: ${stdout.slice(0, 200)}` });
        }
      });
    };
    tryNext();
  });
}

/**
 * Check if voice fingerprinting is available (Python + Resemblyzer installed)
 */
export async function isVoiceAvailable(): Promise<boolean> {
  try {
    findScript();
    const result = await runPython(['extract', '/dev/null'], 5000);
    // If we get a proper error (not "command not found"), Python works
    return !result.error?.includes('failed');
  } catch {
    return false;
  }
}

/**
 * Extract a voice embedding from a WAV file (or segment).
 */
export async function extractEmbedding(
  wavPath: string,
  startSec?: number,
  endSec?: number
): Promise<number[] | null> {
  const args = ['extract', wavPath];
  if (startSec !== undefined) args.push('--start', String(startSec));
  if (endSec !== undefined) args.push('--end', String(endSec));

  const result = await runPython(args);
  return result.embedding && result.embedding.length > 0 ? result.embedding : null;
}

/**
 * Match a WAV segment against stored voice profiles.
 * @param candidates - Optional list of expected names (from calendar) to narrow the search
 */
export async function matchSpeaker(
  wavPath: string,
  candidates?: string[],
  startSec?: number,
  endSec?: number
): Promise<VoiceMatch[]> {
  const args = ['match', wavPath, '--profiles', VOICES_DIR];
  if (startSec !== undefined) args.push('--start', String(startSec));
  if (endSec !== undefined) args.push('--end', String(endSec));
  if (candidates && candidates.length > 0) {
    args.push('--candidates', candidates.join(','));
  }

  const result = await runPython(args);
  return result.matches || [];
}

/**
 * Enroll a speaker: extract embedding and save to voice profiles.
 * If profile already exists, it's updated with weighted average (more stable over time).
 */
export async function enrollSpeaker(
  wavPath: string,
  name: string,
  startSec?: number,
  endSec?: number
): Promise<boolean> {
  const args = ['enroll', wavPath, '--name', name, '--profiles', VOICES_DIR];
  if (startSec !== undefined) args.push('--start', String(startSec));
  if (endSec !== undefined) args.push('--end', String(endSec));

  const result = await runPython(args);
  return !!result.saved;
}

/**
 * List all enrolled voice profiles.
 */
export function listProfiles(): string[] {
  if (!fs.existsSync(VOICES_DIR)) return [];
  return fs.readdirSync(VOICES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(VOICES_DIR, f), 'utf-8'));
        return data.name || f.replace('.json', '');
      } catch {
        return f.replace('.json', '');
      }
    });
}

/**
 * Get the voices directory path.
 */
export function getVoicesDir(): string {
  return VOICES_DIR;
}
