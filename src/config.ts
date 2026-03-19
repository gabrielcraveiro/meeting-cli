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
  // Calendar integration
  icsUrl?: string;
  // Privacy & compliance
  deleteAudioAfterTranscription?: boolean;  // default true — deletes WAV after note is created
  // Legacy
  ffmpegPath?: string;
  audioBackend?: string;
  ffmpegMicDevice?: string;
  ffmpegSysDevice?: string;
}

const CONFIG_DIR = path.join(os.homedir(), '.config', 'meeting-cli');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_PROMPT =
  '<role>Secretario executivo de reunioes. Voce transforma transcricoes brutas em notas estruturadas de alta qualidade.</role>\n\n' +
  '<input>Transcricao com timestamps [MM:SS] e labels de speaker ([Speaker 0], [Speaker 1]).</input>\n\n' +
  '<output>\n' +
  'Primeira linha: titulo descritivo curto (sem # prefix, sem data). Ex: "Alinhamento Regulação Digital"\n' +
  'Segunda linha: Participantes: Nome1, Nome2 (inferidos da conversa, NAO use Speaker labels)\n\n' +
  '## Resumo\n2-4 frases. Contexto + principais conclusoes. Deve bastar para entender a reuniao sem ler mais nada.\n\n' +
  '## Pontos Principais\n- Topicos discutidos em ordem cronologica. Inclua [MM:SS] no inicio de cada ponto.\n\n' +
  '## Decisoes Tomadas\n- Decisao explicita com [MM:SS]. Apenas decisoes FIRMES, nao sugestoes.\n\n' +
  '## Action Items\n| Acao | Responsavel | Prazo | Prioridade |\n|------|------------|-------|------------|\n' +
  'Apenas acoes com responsavel identificavel. Prazo = data/sprint mencionada ou "A definir".\n\n' +
  '## Pontos em Aberto\n- Questoes levantadas sem resolucao. Riscos mencionados. Dependencias externas.\n' +
  '</output>\n\n' +
  '<rules>\n' +
  '- SPEAKER INFERENCE: Infira nomes reais do dialogo. "Speaker 0 disse: eu, Gabriel, vou fazer" → Gabriel. Nunca use Speaker N no output se o nome for identificavel.\n' +
  '- Omita secoes vazias — NAO escreva "Nenhuma decisao registrada".\n' +
  '- Responda APENAS com a nota formatada, sem preambulo.\n' +
  '- Portugues do Brasil. Mantenha termos tecnicos e nomes proprios em ingles.\n' +
  '- Markdown limpo: sem HTML, sem tags de formatacao extras.\n' +
  '</rules>';

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
  // Fill in defaults for optional fields
  if (!cfg.organizationPrompt) cfg.organizationPrompt = DEFAULT_PROMPT;
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

  // Calendar — Outlook ICS
  console.log('\n📅 Calendário — Outlook ICS (opcional)\n');
  console.log('  Permite ver suas reuniões do Teams/Outlook ao iniciar uma gravação.');
  console.log('  Para obter a URL: Outlook Web → Configurações → Publicar calendário → copiar URL .ics');
  console.log('  Deixe em branco para pular.\n');
  const icsUrl = await ask(rl, 'URL do calendário .ics', existing?.icsUrl || '');

  // Privacy
  console.log('\n🔒 Privacidade & Compliance\n');
  const currentDelete = existing?.deleteAudioAfterTranscription !== false ? 'sim' : 'nao';
  const deleteAnswer = await ask(rl, 'Deletar áudio após transcrição? (sim/nao)', currentDelete);
  const deleteAudioAfterTranscription = deleteAnswer.toLowerCase() !== 'nao';

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
    ...(icsUrl ? { icsUrl } : {}),
    deleteAudioAfterTranscription,
  };

  saveConfig(config);
  console.log(`\n✅ Config salvo em: ${CONFIG_PATH}`);
}
