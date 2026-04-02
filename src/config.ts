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
  // Name of the person running the tool (shown to the AI as the chat operator)
  userName?: string;
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
  '<role>Secretario executivo de reunioes. Voce transforma transcricoes brutas em notas estruturadas que humanos vao consultar semanas depois.</role>\n\n' +
  '<input>Transcricao com timestamps [MM:SS] e labels de speaker ([Speaker 0], [Speaker 1], [Remoto N], [Voce]).</input>\n\n' +
  '<output>\n' +
  'OBRIGATORIO — as duas primeiras linhas:\n' +
  'Linha 1: Titulo descritivo curto (sem # prefix, sem data). Ex: "Alinhamento Regulação Digital"\n' +
  'Linha 2: Participantes: Nome1, Nome2, Nome3 (NOMES REAIS inferidos da conversa — NUNCA "Speaker 0" ou "Voce")\n\n' +
  'Depois, EXATAMENTE estas secoes com headers ## (use todas que tiverem conteudo):\n\n' +
  '## Resumo\n2-4 frases. Contexto do que motivou a reuniao + principais conclusoes. ' +
  'Alguem que nao participou deve entender o que aconteceu lendo so este paragrafo.\n\n' +
  '## Pontos Principais\n- [MM:SS] Topico discutido — conclusao ou status. Ordem cronologica.\n- Maximo 10 bullets. Cada um deve ser auto-contido (entendivel sem ler o resto).\n\n' +
  '## Decisoes\n- [MM:SS] **Decisao**: o que foi decidido. **Contexto**: por que. **Responsavel**: quem executa.\n- Apenas decisoes FIRMES ("vamos fazer X"). NAO inclua sugestoes ou consideracoes.\n\n' +
  '## Action Items\n| Acao | Responsavel | Prazo | Prioridade |\n|------|------------|-------|------------|\n' +
  'Regras para a tabela:\n' +
  '- Responsavel = nome real da pessoa (NUNCA "equipe" ou "time" se alguem especifico foi mencionado)\n' +
  '- Prazo = DATA ABSOLUTA sempre que possivel. Converta "hoje" para a data da reuniao, "amanha" para +1 dia, "semana que vem" para data aproximada. Se nao mencionado: "A definir"\n' +
  '- Prioridade = Alta/Media/Baixa baseado na urgencia expressa na conversa\n\n' +
  '## Pontos em Aberto\n- Questoes levantadas SEM resolucao clara. Riscos. Dependencias externas. Divergencias de opiniao nao resolvidas.\n' +
  '</output>\n\n' +
  '<rules>\n' +
  '- SPEAKER INFERENCE (CRITICO): Voce DEVE inferir nomes reais. Tecnicas:\n' +
  '  • Auto-referencia: "eu, Gabriel, vou..." → Gabriel\n' +
  '  • Chamada direta: "Lucas, o que voce acha?" → proximo speaker e Lucas\n' +
  '  • Contexto de funcao: se alguem fala de "meu PR" e outro diz "o PR do Pedro" → aquele speaker e Pedro\n' +
  '  • Se NAO conseguir inferir, use "Participante 1" (nunca "Speaker 0" ou "Remoto 0")\n' +
  '- SECOES OBRIGATORIAS: Use headers ## para TODAS as secoes. NUNCA escreva prosa corrida sem headers.\n' +
  '- SECOES VAZIAS: Omita completamente. NAO escreva "Nenhuma decisao registrada".\n' +
  '- DATAS: A data da reuniao sera informada no contexto. Use-a para converter prazos relativos.\n' +
  '- CONFLITOS: Se houver divergencia de opiniao, registre em "Pontos em Aberto" com ambas posicoes.\n' +
  '- Responda APENAS com a nota formatada, sem preambulo.\n' +
  '- Portugues do Brasil. Termos tecnicos e nomes proprios em ingles.\n' +
  '- Markdown limpo: sem HTML.\n' +
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

  // User identity
  console.log('\n👤 Identidade\n');
  console.log('  Seu nome é usado pelo assistente de chat para saber com quem está falando.\n');
  const userName = await ask(rl, 'Seu nome', existing?.userName || '');

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
    ...(userName ? { userName } : {}),
    deleteAudioAfterTranscription,
  };

  saveConfig(config);
  console.log(`\n✅ Config salvo em: ${CONFIG_PATH}`);
}
