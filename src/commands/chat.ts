import * as readline from 'readline';
import chalk from 'chalk';
import { requireConfig } from '../config';
import { loadMeetingContent } from '../services/storage';
import { chatWithMeetings } from '../services/organizer';

const SYSTEM_PROMPT = `Você é um assistente especializado em reuniões corporativas.
Você tem acesso às transcrições e resumos das reuniões recentes da empresa.
Responda em português de forma clara e objetiva, citando datas e reuniões específicas quando relevante.
Se a resposta não estiver nas reuniões fornecidas, diga isso claramente.`;

export async function cmdChat(options: { limit?: string }): Promise<void> {
  const config = requireConfig();
  const limit = parseInt(options.limit || '10');

  console.log(chalk.blue('\n⏳ Carregando reuniões...'));
  const meetings = loadMeetingContent(config, limit);

  if (meetings.length === 0) {
    console.log(chalk.yellow('Nenhuma reunião encontrada. Grave sua primeira reunião com: meeting start'));
    return;
  }

  const context = meetings.join('\n\n---\n\n');
  const systemMessage = `${SYSTEM_PROMPT}\n\n# Reuniões disponíveis:\n\n${context}`;

  const history: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemMessage },
  ];

  console.log(chalk.bold(`\n💬 Meeting Chat — ${meetings.length} reunião(ões) no contexto`));
  console.log(chalk.gray('Digite sua pergunta ou /exit para sair\n'));
  console.log('─'.repeat(50));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const askQuestion = () => {
    rl.question(chalk.bold.green('\nVocê: '), async (input) => {
      const text = input.trim();

      if (!text) {
        askQuestion();
        return;
      }

      if (text === '/exit' || text === '/quit' || text === '/sair') {
        console.log(chalk.gray('\nAté logo! 👋\n'));
        rl.close();
        return;
      }

      if (text === '/clear' || text === '/limpar') {
        // Keep only system message
        history.splice(1);
        console.log(chalk.gray('Histórico limpo.\n'));
        askQuestion();
        return;
      }

      if (text === '/reunioes' || text === '/meetings') {
        console.log(chalk.gray(`\nReuniões no contexto:\n`));
        meetings.forEach((m, i) => {
          const firstLine = m.split('\n')[0];
          console.log(chalk.gray(`  ${i + 1}. ${firstLine}`));
        });
        askQuestion();
        return;
      }

      history.push({ role: 'user', content: text });

      process.stdout.write(chalk.bold.blue('\n🤖 Assistente: '));

      try {
        const response = await chatWithMeetings(history, config);
        history.push({ role: 'assistant', content: response });
        console.log(response);
      } catch (err) {
        console.log(chalk.red(`\n❌ Erro: ${(err as Error).message}`));
      }

      askQuestion();
    });
  };

  console.log(chalk.gray('Comandos: /exit  /clear  /reunioes'));
  askQuestion();
}
