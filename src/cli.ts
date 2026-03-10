import { Command } from 'commander';
import { cmdStart } from './commands/start';
import { cmdList } from './commands/list';
import { cmdSummary } from './commands/summary';
import { cmdChat } from './commands/chat';
import { cmdTranscribe } from './commands/transcribe';
import { cmdSearch } from './commands/search';
import { runConfigWizard, loadConfig } from './config';
import { cmdSetup, isSidecarInstalled } from './commands/setup';
import { cmdDoctor } from './commands/doctor';
import { cmdStats } from './commands/stats';
import { listTemplates } from './services/templates';

const program = new Command();

program
  .name('meeting')
  .description('CLI para gravação, transcrição e chat com reuniões')
  .version('1.2.0');

program
  .command('start')
  .description('Inicia gravação de reunião com transcrição ao vivo')
  .option('-t, --template <name>', 'Template de reunião (daily, 1on1, retro, planning, technical)')
  .action(cmdStart);

program
  .command('transcribe <file>')
  .description('Transcreve um arquivo de áudio e cria nota no vault')
  .option('-t, --template <name>', 'Template de reunião')
  .option('--no-ai', 'Só transcreve, sem organizar com IA')
  .action(cmdTranscribe);

program
  .command('search <query>')
  .description('Busca em todas as reuniões')
  .option('-n, --limit <n>', 'Número máximo de resultados', '10')
  .action(cmdSearch);

program
  .command('list')
  .description('Lista todas as reuniões gravadas')
  .option('-n, --limit <n>', 'Número de reuniões a exibir', '20')
  .action(cmdList);

program
  .command('summary')
  .description('Mostra resumos das reuniões recentes')
  .option('-n, --limit <n>', 'Número de reuniões', '5')
  .option('--raw', 'Exibe texto sem formatação de cor')
  .action(cmdSummary);

program
  .command('chat')
  .description('Abre chat interativo com contexto das reuniões')
  .option('-n, --limit <n>', 'Número de reuniões no contexto', '10')
  .action(cmdChat);

program
  .command('templates')
  .description('Lista templates de reunião disponíveis')
  .action(() => {
    console.log('\n📋 Templates disponíveis:\n');
    for (const t of listTemplates()) {
      console.log(`  ${t.name.padEnd(12)} ${t.label.padEnd(16)} ${t.description}`);
    }
    console.log('\nUso: meeting start --template daily');
    console.log('     meeting transcribe audio.wav --template retro\n');
  });

program
  .command('doctor')
  .description('Diagnostica problemas de configuracao e conexao')
  .action(cmdDoctor);

program
  .command('stats')
  .description('Mostra estatisticas e gera dashboard no vault')
  .action(cmdStats);

program
  .command('config')
  .description('Configura endpoints, chaves e dispositivos de áudio')
  .action(async () => {
    await runConfigWizard();
  });

program
  .command('setup')
  .description('Instala o sidecar WASAPI (necessário na primeira vez)')
  .action(cmdSetup);

program
  .command('status')
  .description('Mostra configuração atual')
  .action(() => {
    const cfg = loadConfig();
    if (!cfg) {
      console.log('❌ Sem configuração. Run: meeting config');
      return;
    }
    const sidecarOk = isSidecarInstalled();
    console.log('\n📋 Configuração atual:\n');
    console.log(`  Sidecar:     ${sidecarOk ? '✓ instalado' : '✗ não instalado (rode: meeting setup)'}`);
    console.log(`  Vault:       ${cfg.vaultPath}`);
    console.log(`  Áudio:       WASAPI Loopback (captura do output padrão do Windows)`);
    console.log(`  Mic Device:  ${cfg.micDeviceId || '(padrão do sistema)'}`);
    console.log(`  Mic Gain:    ${cfg.micGain ?? 1.0}`);
    console.log(`  Deepgram:    ${cfg.deepgramModel || 'nova-2'} | key: ${cfg.deepgramApiKey ? '***' + cfg.deepgramApiKey.slice(-4) : '(não configurado)'}`);
    console.log(`  Chat:        ${cfg.chatModel || 'gpt-4o-mini'} @ ${(cfg.chatEndpoint || '').slice(0, 40)}`);
    console.log('');
  });

program.parse(process.argv);
