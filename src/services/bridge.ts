import fs from 'fs';
import os from 'os';
import path from 'path';

// Bridge file: communication channel between `meeting daemon` (HTTP server that
// receives events from the browser extension) and the recording session it spawns.
// The daemon writes; the session polls. File-based so the two processes stay decoupled.

const BRIDGE_DIR = path.join(os.homedir(), '.config', 'meeting-cli');
const BRIDGE_PATH = path.join(BRIDGE_DIR, 'browser-bridge.json');

export interface SpeechSpan {
  who: string;
  start: number;  // seconds since call start
  end: number;
  /** Utterance text from Teams live captions (Azure ASR) */
  text?: string;
}

export interface BridgeState {
  /** Meeting title reported by the extension (e.g. Teams call title) */
  title?: string;
  /** Platform identifier: 'teams' | 'meet' | 'zoom' */
  platform?: string;
  /** Roster scraped from the call UI — includes silent listeners */
  participants: string[];
  /** Speaker timeline from Teams live captions — ground truth for who spoke when */
  speech?: SpeechSpan[];
  /** True while the local user is screen-sharing — suppresses notifications */
  sharing?: boolean;
  /** Set to true by the daemon when the extension reports the call ended */
  stopRequested: boolean;
  /** Epoch ms of last write — sessions ignore stale files from crashed daemons */
  updatedAt: number;
}

export function writeBridge(state: BridgeState): void {
  fs.mkdirSync(BRIDGE_DIR, { recursive: true });
  const tmp = BRIDGE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, BRIDGE_PATH);  // atomic — session never reads a half-written file
}

export function readBridge(): BridgeState | null {
  try {
    const raw = fs.readFileSync(BRIDGE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.participants)) parsed.participants = [];
    return parsed as BridgeState;
  } catch {
    return null;
  }
}

export function clearBridge(): void {
  try { fs.unlinkSync(BRIDGE_PATH); } catch {}
}

/** Merge new roster names into an existing bridge file (daemon side). */
export function updateBridgeParticipants(names: string[]): BridgeState {
  const current = readBridge() ?? { participants: [], stopRequested: false, updatedAt: 0 };
  const merged = new Set([...current.participants, ...names.map(n => n.trim()).filter(Boolean)]);
  const next: BridgeState = { ...current, participants: [...merged], updatedAt: Date.now() };
  writeBridge(next);
  return next;
}

/** Replace the speech timeline (extension always sends the full span list). */
export function updateBridgeSpeech(spans: SpeechSpan[]): void {
  const current = readBridge() ?? { participants: [], stopRequested: false, updatedAt: 0 };
  const valid = spans.filter(s =>
    typeof s?.who === 'string' && s.who.length > 0 && s.who.length <= 60 &&
    Number.isFinite(s.start) && Number.isFinite(s.end)
  ).slice(0, 5000).map(s => ({
    who: s.who,
    start: s.start,
    end: s.end,
    text: typeof s.text === 'string' ? s.text.slice(0, 500) : undefined,
  }));
  writeBridge({ ...current, speech: valid, updatedAt: Date.now() });
}

/** Corrige o título mid-session (ex.: extensão trocou nome de pessoa pelo título real). */
export function updateBridgeTitle(title: string): void {
  const current = readBridge() ?? { participants: [], stopRequested: false, updatedAt: 0 };
  writeBridge({ ...current, title: title.slice(0, 200), updatedAt: Date.now() });
}

export function updateBridgeSharing(active: boolean): void {
  const current = readBridge() ?? { participants: [], stopRequested: false, updatedAt: 0 };
  writeBridge({ ...current, sharing: active, updatedAt: Date.now() });
}

export function requestBridgeStop(): void {
  const current = readBridge();
  if (!current) return;
  writeBridge({ ...current, stopRequested: true, updatedAt: Date.now() });
}
