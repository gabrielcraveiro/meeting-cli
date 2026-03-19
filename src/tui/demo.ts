// ── TUI Demo ──
// Run: npx esbuild --bundle --platform=node src/tui/demo.ts | node
// Interactive demo to test the full MVU pipeline visually.

import { createTUI } from './index';

const tui = createTUI({ transcriptLines: 3 });

// Simulate recording labels
tui.dispatch({ type: 'SET_LABELS', template: 'daily', topic: 'Sprint Planning' });

// Start timer simulation
let elapsed = 0;
let segments = 0;
const timer = setInterval(() => {
  elapsed++;
  if (elapsed % 5 === 0) segments++;
  const cost = segments * 0.45 * 0.0077;
  tui.dispatch({ type: 'TICK', elapsed, segments, cost });
}, 1000);

// Simulate transcript arriving every 8 seconds
const transcriptSamples = [
  '[Speaker 0] Bom dia pessoal, vamos comecar a daily',
  '[Speaker 1] Bom dia! Ontem terminei o deploy do servico de pagamentos',
  '[Speaker 0] Legal, algum blocker?',
  '[Speaker 1] Nao, tudo certo. Hoje vou comecar o code review do PR do Lucas',
  '[Speaker 2] Eu estou com um blocker no ambiente de staging',
  '[Speaker 0] O que aconteceu?',
  '[Speaker 2] O banco de dados nao esta respondendo. Abri um ticket pro infra',
  '[Speaker 0] Ok, vamos escalar se nao resolver ate as 15h',
];
let transcriptIdx = 0;
const transcriptTimer = setInterval(() => {
  if (transcriptIdx < transcriptSamples.length) {
    const ts = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
    tui.dispatch({ type: 'TRANSCRIPT_LINE', text: `[${ts}] ${transcriptSamples[transcriptIdx]}` });
    transcriptIdx++;
  }
}, 8000);

// First transcript immediately
setTimeout(() => {
  tui.dispatch({ type: 'TRANSCRIPT_LINE', text: '[00:01] [Speaker 0] Bom dia pessoal, vamos comecar a daily' });
}, 500);

// Simulate an insight at 10 seconds
setTimeout(() => {
  tui.dispatch({ type: 'SCROLL_APPEND', line: { text: '', category: 'separator' } });
  tui.dispatch({ type: 'SCROLL_APPEND', line: { text: 'Insights (00:10)', category: 'insight' } });
  tui.dispatch({ type: 'SCROLL_APPEND', line: { text: '[ponto] Daily do squad de pagamentos iniciada', category: 'insight' } });
  tui.dispatch({ type: 'SCROLL_APPEND', line: { text: '[acao] Lucas: code review do PR pendente', category: 'insight' } });
  tui.dispatch({ type: 'SCROLL_APPEND', line: { text: '[risco] Staging com banco fora — escalar se nao resolver ate 15h', category: 'insight' } });
  tui.dispatch({ type: 'SCROLL_APPEND', line: { text: '', category: 'separator' } });
}, 10000);

// Handle user input
tui.onSubmit((text) => {
  if (!text.trim()) return;

  const cmd = text.replace(/^\/+/, '').toLowerCase();

  if (cmd === 'stop' || cmd === 'quit' || cmd === 'exit') {
    clearInterval(timer);
    clearInterval(transcriptTimer);
    tui.teardown();
    console.log('\nDemo encerrado.');
    process.exit(0);
  }

  if (cmd === 'overlay') {
    tui.dispatch({ type: 'OVERLAY_PUSH', overlay: {
      id: 'demo-overlay',
      title: 'AI Response',
      lines: [
        'O deploy do servico de pagamentos foi concluido com sucesso.',
        'Lucas ficou responsavel pelo code review.',
        '',
        'Baseado na reuniao de 15/03, o staging ja tinha',
        'problemas intermitentes — pode ser o mesmo issue.',
        '',
        'Sugestao: verificar logs do RDS antes de escalar.',
      ],
      position: 'center',
      width: 70,
      height: 50,
    }});
    return;
  }

  // Echo as chat
  tui.dispatch({ type: 'SCROLL_APPEND', line: { text: text, category: 'chat-user' } });
  tui.dispatch({ type: 'INPUT_SET_MODE', mode: 'busy' });

  // Fake AI response after 1.5s
  setTimeout(() => {
    tui.dispatch({ type: 'SCROLL_APPEND', line: { text: 'Baseado na transcricao, o principal ponto e o blocker no staging.', category: 'chat-ai' } });
    tui.dispatch({ type: 'SCROLL_APPEND', line: { text: 'O time de infra ja foi acionado.', category: 'chat-ai' } });
    tui.dispatch({ type: 'INPUT_SET_MODE', mode: 'normal' });
  }, 1500);
});

// Handle stop signal
tui.onSignal((signal) => {
  if (signal === 'stop') {
    clearInterval(timer);
    clearInterval(transcriptTimer);
    tui.teardown();
    console.log('\nDemo encerrado (Ctrl+C).');
    process.exit(0);
  }
});

// Init TUI (this starts the full UI)
tui.init();

// Welcome message in scroll area
tui.dispatch({ type: 'SCROLL_APPEND', line: { text: 'TUI Demo iniciado. Digite algo e pressione Enter.', category: 'system' } });
tui.dispatch({ type: 'SCROLL_APPEND', line: { text: 'Comandos: /stop (sair), /overlay (testar overlay)', category: 'system' } });
tui.dispatch({ type: 'SCROLL_APPEND', line: { text: 'Transcricao simulada a cada 8s. Insights em 10s.', category: 'system' } });
