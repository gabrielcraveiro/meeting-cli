// Meeting CLI — WASAPI Audio Capture Sidecar
// Runs on Windows Node.js, captures system audio + microphone via WASAPI loopback
// Writes mixed WAV segments to output directory for the WSL CLI to pick up
const { SystemAudioRecorder, MicrophoneRecorder } = require('native-audio-node');
const fs = require('fs');
const path = require('path');

// --- CLI args ---
const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : defaultVal;
}

const OUTPUT_DIR = getArg('output', '.');
const SEGMENT_SEC = parseInt(getArg('segment-duration', '10'), 10);
const SAMPLE_RATE = parseInt(getArg('sample-rate', '16000'), 10);
const MIC_GAIN = parseFloat(getArg('mic-gain', '1.0'));
const MIC_DEVICE_ID = getArg('mic-device', undefined);

// --- State ---
const CHUNK_MS = 100;
let sysBuffers = [];
let micBuffers = [];
let sysSamples = 0;
let micSamples = 0;
let segIndex = 0;
let running = true;

// --- WAV writer ---
function writeWav(filePath, pcmF32, sampleRate, channels) {
  const numSamples = pcmF32.length;
  // Convert float32 to int16
  const pcm16 = new Int16Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, pcmF32[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  const dataSize = pcm16.length * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);           // fmt chunk size
  header.writeUInt16LE(1, 20);            // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28); // byte rate
  header.writeUInt16LE(channels * 2, 32); // block align
  header.writeUInt16LE(16, 34);           // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  const pcmBuf = Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
  fs.writeFileSync(filePath, Buffer.concat([header, pcmBuf]));
}

// --- Mix and flush a segment ---
function flushSegment() {
  if (sysBuffers.length === 0 && micBuffers.length === 0) return;

  const sysAll = sysBuffers.length > 0 ? Buffer.concat(sysBuffers) : Buffer.alloc(0);
  const micAll = micBuffers.length > 0 ? Buffer.concat(micBuffers) : Buffer.alloc(0);

  const sysF32 = new Float32Array(sysAll.buffer, sysAll.byteOffset, sysAll.length / 4);
  const micF32 = new Float32Array(micAll.buffer, micAll.byteOffset, micAll.length / 4);

  const len = Math.max(sysF32.length, micF32.length);
  if (len === 0) return;

  const mixed = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const s = i < sysF32.length ? sysF32[i] : 0;
    const m = i < micF32.length ? micF32[i] * MIC_GAIN : 0;
    mixed[i] = Math.max(-1, Math.min(1, s + m));
  }

  const segName = `seg_${String(segIndex).padStart(3, '0')}.wav`;
  const segPath = path.join(OUTPUT_DIR, segName);
  writeWav(segPath, mixed, SAMPLE_RATE, 1);

  const peakSys = sysF32.length > 0 ? Math.max(...Array.from(sysF32.slice(0, 1000)).map(Math.abs)) : 0;
  const peakMic = micF32.length > 0 ? Math.max(...Array.from(micF32.slice(0, 1000)).map(Math.abs)) : 0;
  console.log(JSON.stringify({
    event: 'segment',
    index: segIndex,
    file: segName,
    samples: len,
    durationSec: (len / SAMPLE_RATE).toFixed(1),
    peakSys: peakSys.toFixed(4),
    peakMic: peakMic.toFixed(4),
  }));

  segIndex++;
  sysBuffers = [];
  micBuffers = [];
  sysSamples = 0;
  micSamples = 0;
}

// --- Main ---
async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const sysRec = new SystemAudioRecorder({
    sampleRate: SAMPLE_RATE,
    chunkDurationMs: CHUNK_MS,
    stereo: false,
    emitSilence: true,
  });

  const micOpts = {
    sampleRate: SAMPLE_RATE,
    chunkDurationMs: CHUNK_MS,
    stereo: false,
    emitSilence: true,
  };
  if (MIC_DEVICE_ID) micOpts.deviceId = MIC_DEVICE_ID;
  const micRec = new MicrophoneRecorder(micOpts);

  sysRec.on('data', (chunk) => {
    if (!running) return;
    sysBuffers.push(Buffer.from(chunk.data));
    sysSamples += chunk.data.length / 4;
  });

  micRec.on('data', (chunk) => {
    if (!running) return;
    micBuffers.push(Buffer.from(chunk.data));
    micSamples += chunk.data.length / 4;
  });

  sysRec.on('error', (err) => console.error(JSON.stringify({ event: 'error', source: 'system', message: err.message })));
  micRec.on('error', (err) => console.error(JSON.stringify({ event: 'error', source: 'mic', message: err.message })));

  sysRec.on('metadata', (m) => console.log(JSON.stringify({ event: 'metadata', source: 'system', ...m })));
  micRec.on('metadata', (m) => console.log(JSON.stringify({ event: 'metadata', source: 'mic', ...m })));

  // Flush segments on a strict time-based interval
  const segInterval = setInterval(() => {
    if (running) {
      flushSegment();
    }
  }, SEGMENT_SEC * 1000);

  // Graceful shutdown
  process.on('SIGINT', () => shutdown(sysRec, micRec, segInterval));
  process.on('SIGTERM', () => shutdown(sysRec, micRec, segInterval));
  process.on('message', (msg) => {
    if (msg === 'stop') shutdown(sysRec, micRec, segInterval);
  });
  // Also handle stdin 'q' (like ffmpeg)
  process.stdin?.on('data', (data) => {
    if (data.toString().trim() === 'q') shutdown(sysRec, micRec, segInterval);
  });
  process.stdin?.resume?.();

  console.log(JSON.stringify({ event: 'ready', sampleRate: SAMPLE_RATE, segmentSec: SEGMENT_SEC, micGain: MIC_GAIN }));

  await sysRec.start();
  await micRec.start();

  console.log(JSON.stringify({ event: 'started' }));
}

async function shutdown(sysRec, micRec, segInterval) {
  if (!running) return;
  running = false;
  clearInterval(segInterval);
  try { await sysRec.stop(); } catch {}
  try { await micRec.stop(); } catch {}
  // Flush remaining audio
  flushSegment();
  console.log(JSON.stringify({ event: 'stopped', totalSegments: segIndex }));
  process.exit(0);
}

main().catch((err) => {
  console.error(JSON.stringify({ event: 'fatal', message: err.message }));
  process.exit(1);
});
