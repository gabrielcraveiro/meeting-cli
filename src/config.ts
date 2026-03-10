import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { execFileSync } from 'child_process';

export interface Config {
  vaultPath: string;
  // Audio — WASAPI sidecar
  micDeviceId: string;
  micGain: number;
  // Transcription — Deepgram
  deepgramApiKey: string;
  deepgramModel: string;
  // Chat — LiteLLM (OpenAI-compatible)
  chatEndpoint: string;
  chatApiKey: string;
  chatModel: string;
  organizationPrompt: string;
  // Speaker name mapping: { "0": "Gabriel", "1": "Ana" }
  speakerNames?: Record<string, string>;
  // Legacy
  ffmpegPath?: string;
  audioBackend?: string;
  ffmpegMicDevice?: string;
  ffmpegSysDevice?: string;
}

const CONFIG_DIR = path.join(os.homedir(), '.config', 'meeting-cli');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_PROMPT =
  'You are an expert meeting secretary. You receive a transcript with timestamps and speaker labels ([Speaker 0], [Speaker 1]).\n\n' +
  'Produce a structured meeting note in Portuguese (Brazil) with these sections:\n\n' +
  '## Participantes\n' +
  'List each speaker with a short description if identifiable from context (e.g., "[Speaker 0] — provavelmente o tech lead, mencionou deploy").\n\n' +
  '## Resumo\n' +
  'A concise 2-4 sentence overview of what the meeting was about.\n\n' +
  '## Pontos Principais\n' +
  'Bulleted list of the key topics discussed.\n\n' +
  '## Decisões Tomadas\n' +
  'Bulleted list of decisions made during the meeting. If none, write "Nenhuma decisão registrada."\n\n' +
  '## Action Items\n' +
  'Bulleted checklist (- [ ]) of tasks assigned, with the responsible person if mentioned.\n\n' +
  '## Transcrição Limpa\n' +
  'The full transcript cleaned up for readability — fix obvious transcription errors, remove filler words (uh, hm, tipo), ' +
  'but keep the speaker labels and the original meaning intact. Do NOT summarize here, keep the full dialog.\n\n' +
  'Rules:\n' +
  '- Respond ONLY with the formatted note, no preamble.\n' +
  '- If the transcript is too short or unclear, still produce the structure with what you have.\n' +
  '- Detect the spoken language automatically — write the note in Portuguese but keep technical terms and proper nouns as-is.';

export function loadConfig(): Config | null {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

export function saveConfig(config: Config): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function requireConfig(): Config {
  const cfg = loadConfig();
  if (!cfg) {
    console.error('❌ Config not found. Run: meeting config');
    process.exit(1);
  }
  return cfg as Config;
}

async function ask(rl: readline.Interface, question: string, defaultVal = ''): Promise<string> {
  return new Promise((resolve) => {
    const prompt = defaultVal ? `${question} [${defaultVal}]: ` : `${question}: `;
    rl.question(prompt, (answer: string) => {
      resolve(answer.trim() || defaultVal);
    });
  });
}

function listDevicesFromSidecar(): any[] | null {
  try {
    // Find sidecar directory
    const candidates = [
      path.resolve(__dirname, '..', 'sidecar'),
      path.resolve(__dirname, '..', '..', 'sidecar'),
    ];
    let sidecarDir = '';
    for (const c of candidates) {
      if (fs.existsSync(path.join(c, 'node_modules', 'native-audio-node'))) {
        sidecarDir = c;
        break;
      }
    }
    if (!sidecarDir) return null;

    const script = 'const m=require("native-audio-node");console.log(JSON.stringify(m.listAudioDevices()))';
    const output = execFileSync('node.exe', ['-e', script], {
      encoding: 'utf-8',
      timeout: 10000,
      cwd: sidecarDir,
    }).trim();
    return JSON.parse(output);
  } catch {
    return null;
  }
}

export async function runConfigWizard(): Promise<void> {
  const existing = loadConfig();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n🔧 Meeting CLI — Setup\n');
  console.log('Pressione Enter para manter o valor atual.\n');

  // Vault
  const vaultPath = await ask(rl, 'Caminho do vault Obsidian', existing?.vaultPath || '/mnt/c/Documentos/Obsidian/epharma-labs');

  // Audio — WASAPI
  console.log('\n🎧 Áudio — WASAPI Loopback\n');
  console.log('  O sistema captura automaticamente o áudio do dispositivo de saída padrão do Windows.');
  console.log('  O microfone padrão é usado automaticamente. Para usar outro, informe o Device ID.\n');

  // List devices if possible
  const devices = listDevicesFromSidecar();
  if (devices) {
    const inputs = devices.filter((d: any) => d.isInput);
    const outputs = devices.filter((d: any) => d.isOutput);
    const defaultOut = outputs.find((d: any) => d.isDefault);
    const defaultIn = inputs.find((d: any) => d.isDefault);

    console.log('  📢 Saída (loopback captura daqui):');
    for (const d of outputs) {
      const tag = d.isDefault ? ' ← DEFAULT' : '';
      console.log(`     ${d.name}${tag}`);
    }
    console.log('');
    console.log('  🎤 Entrada (microfones):');
    for (const d of inputs) {
      const tag = d.isDefault ? ' ← DEFAULT' : '';
      console.log(`     ${d.name} [${d.id}]${tag}`);
    }
    console.log('');

    if (defaultOut) console.log(`  Loopback vai capturar de: ${defaultOut.name}`);
    if (defaultIn) console.log(`  Microfone padrão: ${defaultIn.name}`);
    console.log('');
  } else {
    console.log('  (Não foi possível listar dispositivos — node.exe ou native-audio-node não encontrado)\n');
  }

  const micDeviceId = await ask(rl, 'Mic Device ID (vazio = padrão)', existing?.micDeviceId || '');
  const micGainStr = await ask(rl, 'Ganho do microfone (1.0 = normal)', String(existing?.micGain ?? 1.0));
  const micGain = parseFloat(micGainStr) || 1.0;

  // Deepgram
  console.log('\n🎤 Transcrição — Deepgram\n');
  console.log('  Modelos: nova-3 ($0.0077/min, melhor) | nova-2 ($0.0058/min, mais barato)\n');
  const deepgramApiKey = await ask(rl, 'Deepgram API Key', existing?.deepgramApiKey || '');
  const deepgramModel = await ask(rl, 'Modelo', existing?.deepgramModel || 'nova-2');

  // LiteLLM / Chat
  console.log('\n🤖 Chat AI — LiteLLM\n');
  const chatEndpoint = await ask(rl, 'Endpoint (LiteLLM URL)', existing?.chatEndpoint || 'https://dev-litellm.inova.epharma.com.br');
  const chatApiKey = await ask(rl, 'API Key (Bearer token)', existing?.chatApiKey || '');
  const chatModel = await ask(rl, 'Modelo', existing?.chatModel || 'gpt-4o-mini');

  rl.close();

  const config: Config = {
    vaultPath,
    micDeviceId,
    micGain,
    deepgramApiKey,
    deepgramModel,
    chatEndpoint,
    chatApiKey,
    chatModel,
    organizationPrompt: existing?.organizationPrompt || DEFAULT_PROMPT,
  };

  saveConfig(config);
  console.log(`\n✅ Config salvo em: ${CONFIG_PATH}`);
}
