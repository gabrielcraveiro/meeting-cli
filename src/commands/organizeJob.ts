import fs from 'fs';
import path from 'path';
import { requireConfig } from '../config';
import { organize, parseOrganizedSummary, OrganizeOptions } from '../services/organizer';
import { createMeetingNote } from '../services/storage';
import { notifyWindows } from '../services/notify';
import { applyTaskClosures } from '../services/taskCloser';
import { appendPersonDigest, detectOneOnOne, extractActionBullets, extractSummary } from '../services/personNotes';

// `meeting organize-job <job.json>` — worker DESTACADO de organização de nota.
// A sessão do daemon salva o transcript imediatamente (nota provisória) e sai;
// este processo roda a IA em segundo plano e SUBSTITUI a nota provisória pela
// definitiva. Assim o daemon fica livre pra iniciar a próxima call em segundos
// em vez de bloquear minutos no organize.

interface OrganizeJob {
  placeholderPath: string;
  transcript: string;      // transcript + contexto pós-reunião (input da IA)
  noteTranscript: string;  // transcript puro (corpo da nota)
  prompt: string;
  options: OrganizeOptions;
  note: {
    audioPath?: string;
    durationSec: number;
    whisperCost: number;
    date: string;
    time: string;
    topic: string;
    meetingType?: string;
    sourceNotes?: boolean;
  };
}

export async function cmdOrganizeJob(jobFile: string): Promise<void> {
  const stamp = () => new Date().toISOString();
  const job = JSON.parse(fs.readFileSync(jobFile, 'utf-8')) as OrganizeJob;
  const config = requireConfig();
  const configWithPrompt = { ...config, organizationPrompt: job.prompt || config.organizationPrompt };
  console.log(`[organize-job] ${stamp()} iniciando — nota provisória: ${path.basename(job.placeholderPath)}`);

  try {
    const result = await organize(job.transcript, configWithPrompt, job.options || {});
    const parsed = parseOrganizedSummary(result.text);
    // Corpo vazio = a IA falhou de forma disfarçada (ex.: reasoning comeu o
    // teto de tokens). Nota oca no vault é pior que placeholder com retry.
    if (!parsed.body.trim()) {
      throw new Error(`organizador retornou corpo vazio (engine ${result.engine})`);
    }
    // Propostas de fechamento de pendência: validadas e aplicadas AQUI (o
    // agente não tem Edit — transcrição é entrada não confiável).
    const closure = applyTaskClosures(config, parsed.body, job.note.date);
    parsed.body = closure.summary;
    for (const c of closure.closed) console.log(`[organize-job] pendência fechada: ${c.file} :: ${c.line.slice(0, 80)}`);
    for (const r of closure.rejected) console.log(`[organize-job] proposta de fechamento REJEITADA: ${r.slice(0, 120)}`);
    let title = parsed.title;
    if (!title || /organizacao automatica falhou/i.test(title)) {
      title = job.note.topic || 'Reuniao';
    }

    const aiModelLabel = result.engine === 'claude'
      ? (config.claudeModel || 'claude-sonnet-5')
      : (config.chatModel || 'gpt-4o-mini');

    const notePath = await createMeetingNote(config, {
      transcript: job.noteTranscript,
      summary: parsed.body,
      audioPath: job.note.audioPath,
      durationSec: job.note.durationSec,
      whisperCost: job.note.whisperCost,
      chatCost: result.costUsd,
      chatDeployment: aiModelLabel,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      totalTokens: result.totalTokens,
      date: job.note.date,
      time: job.note.time,
      tags: parsed.tags,
      title,
      participants: parsed.participants,
      meetingType: job.note.meetingType,
      sourceNotes: job.note.sourceNotes,
    });

    // A definitiva substitui a provisória (a menos que tenham caído no mesmo path)
    if (path.resolve(notePath) !== path.resolve(job.placeholderPath)) {
      try { fs.unlinkSync(job.placeholderPath); } catch {}
    }
    try { fs.unlinkSync(jobFile); } catch {}

    // Reunião 1:1 → digest acumula na página da pessoa (Pessoas/<Nome>.md),
    // a "nota macro" da relação. A nota da reunião permanece como fonte.
    try {
      const person = detectOneOnOne(parsed.participants, config);
      if (person) {
        const written = appendPersonDigest(config, {
          person,
          date: job.note.date,
          time: job.note.time,
          noteFileBase: path.basename(notePath).replace(/\.md$/, ''),
          summary: extractSummary(parsed.body),
          bullets: extractActionBullets(parsed.body),
        });
        if (written) console.log(`[organize-job] 1:1 → dossiê atualizado: ${path.basename(written)}`);
      }
    } catch (err) {
      console.error(`[organize-job] dossiê da pessoa falhou (não-fatal): ${(err as Error).message}`);
    }

    // Clique na notificação abre o PRÓPRIO app já na nota (deep link
    // meeting:// registrado pelo instalador; leitor do app renderiza o md).
    const noteRelFile = path.relative(config.vaultPath, notePath).replace(/\\/g, '/');
    const appUri = `meeting://note?file=${encodeURIComponent(noteRelFile)}`;
    notifyWindows(
      `✅ Nota pronta: ${title}`,
      `${parsed.participants.slice(0, 4).join(', ') || path.basename(notePath)} — clique para abrir`,
      appUri,
    );
    console.log(`[organize-job] ${stamp()} concluído (${result.engine}, $${result.costUsd.toFixed(4)}): ${path.basename(notePath)}`);
  } catch (err) {
    // Job preservado em disco pra retry manual; a provisória ganha o aviso.
    console.error(`[organize-job] ${stamp()} FALHOU: ${(err as Error).message}`);
    try {
      const raw = fs.readFileSync(job.placeholderPath, 'utf-8');
      fs.writeFileSync(job.placeholderPath, raw.replace(
        /> ⏳ Organizando com IA em segundo plano[^\n]*/,
        `> ⚠ Organização falhou (${(err as Error).message}). Reprocesse com: meeting organize-job "${jobFile}"`,
      ), 'utf-8');
    } catch {}
    notifyWindows('⚠ Organização da nota falhou', `${job.note.topic || 'Reunião'} — transcript preservado no vault`);
    process.exitCode = 1;
  }
}
