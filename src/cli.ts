import { Command } from 'commander';
import chalk from 'chalk';
import gradient from 'gradient-string';
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
  .version('1.4.0');

// ── Custom help ──────────────────────────────────────────────
// Override help only for the root command — subcommands use default Commander help
program.addHelpText('beforeAll', '');
program.helpInformation = function () {
  const title = gradient(['#ff6b6b', '#ffd93d', '#6bcb77'])('  Meeting CLI');
  const ver = chalk.gray('v1.4.0');

  const sections = [
    '',
    `${title}  ${ver}`,
    chalk.gray('  Grave, transcreva e converse com suas reuniões direto do terminal.'),
    '',
    chalk.bold('  Gravação'),
    `    ${chalk.green('meeting start')}                    Inicia gravação com transcrição ao vivo`,
    `    ${chalk.green('meeting start')} ${chalk.cyan('<tópico>')}           Grava com contexto pré-carregado`,
    `    ${chalk.green('meeting start')} ${chalk.yellow('-t daily')}          Usa template de daily standup`,
    `    ${chalk.green('meeting transcribe')} ${chalk.cyan('<arquivo>')}     Transcreve áudio existente`,
    '',
    chalk.bold('  Consulta'),
    `    ${chalk.green('meeting list')}                     Lista reuniões gravadas`,
    `    ${chalk.green('meeting summary')}                  Mostra resumos recentes`,
    `    ${chalk.green('meeting search')} ${chalk.cyan('"deploy"')}          Busca por texto nas reuniões`,
    `    ${chalk.green('meeting search')} ${chalk.yellow('--smart')} ${chalk.cyan('"deploy"')}  Busca semântica com IA`,
    `    ${chalk.green('meeting chat')}                     Chat interativo sobre reuniões`,
    '',
    chalk.bold('  Sistema'),
    `    ${chalk.green('meeting config')}                   Assistente de configuração`,
    `    ${chalk.green('meeting status')}                   Mostra configuração atual`,
    `    ${chalk.green('meeting doctor')}                   Diagnostica problemas`,
    `    ${chalk.green('meeting stats')}                    Estatísticas e dashboard`,
    `    ${chalk.green('meeting setup')}                    Instala sidecar WASAPI`,
    `    ${chalk.green('meeting templates')}                Lista templates disponíveis`,
    '',
    chalk.gray('  Durante gravação:  /stop  /help  /ctx <arquivo>  ou digite para chat ao vivo'),
    '',
  ];

  return sections.join('\n');
};

program
  .command('start')
  .argument('[topic]', 'Tópico ou projeto para pré-carregar contexto de reuniões anteriores')
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
  .option('--smart', 'Busca semântica com IA (encontra significado, não só texto)')
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
      console.log(`  ${chalk.green(t.name.padEnd(12))} ${chalk.bold(t.label.padEnd(16))} ${chalk.gray(t.description)}`);
    }
    console.log(`\n  ${chalk.gray('Uso:')} meeting start --template daily`);
    console.log(`       meeting transcribe audio.wav --template retro\n`);
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
      console.log(chalk.red('❌ Sem configuração. Rode: meeting config'));
      return;
    }
    const sidecarOk = isSidecarInstalled();
    console.log('\n' + gradient(['#ff6b6b', '#ffd93d', '#6bcb77'])('  Meeting CLI') + chalk.gray(' Status\n'));
    console.log(`  ${chalk.bold('Sidecar')}     ${sidecarOk ? chalk.green('✓ instalado') : chalk.red('✗ não instalado (rode: meeting setup)')}`);
    console.log(`  ${chalk.bold('Vault')}       ${cfg.vaultPath}`);
    console.log(`  ${chalk.bold('Áudio')}       WASAPI Loopback (captura do output padrão do Windows)`);
    console.log(`  ${chalk.bold('Mic Device')}  ${cfg.micDeviceId || chalk.gray('(padrão do sistema)')}`);
    console.log(`  ${chalk.bold('Mic Gain')}    ${cfg.micGain ?? 1.0}`);
    console.log(`  ${chalk.bold('Deepgram')}    ${cfg.deepgramModel || 'nova-2'} | key: ${cfg.deepgramApiKey ? '***' + cfg.deepgramApiKey.slice(-4) : chalk.red('(não configurado)')}`);
    console.log(`  ${chalk.bold('Chat')}        ${cfg.chatModel || 'gpt-4o-mini'} @ ${(cfg.chatEndpoint || '').slice(0, 40)}`);
    console.log('');
  });

program.parse(process.argv);
