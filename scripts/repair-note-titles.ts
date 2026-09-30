// Repara notas do vault cujo título é um comentário do organizador que vazou
// ("Confirmed exact filenames…", "★ Insight ───", "Antes da nota: …").
//
// Uso:
//   npx -y tsx scripts/repair-note-titles.ts            # só mostra o plano
//   npx -y tsx scripts/repair-note-titles.ts --apply    # aplica
//
// Para cada nota com título inválido (ver looksLikeTitle), o título novo vem de:
//   1. o corpo da própria nota: o título real costuma estar logo acima da
//      linha "Participantes:", depois do preâmbulo que virou título;
//   2. o título da nota provisória no organize.log (= título do calendário);
//   3. sem candidato → a nota fica como está e aparece no relatório.
// O --apply guarda os originais em ~/.local/state/meeting-cli/title-repair-<ts>/,
// renomeia o arquivo, reescreve `title:` e o `# heading`, remove o preâmbulo
// do corpo e atualiza os [[wikilinks]] do vault para o nome novo.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfig } from '../src/config';
import { looksLikeTitle, parseOrganizedSummary } from '../src/services/organizer';

const APPLY = process.argv.includes('--apply');
const config = loadConfig();
if (!config) throw new Error('config não encontrada');
const vault = config.vaultPath;
const meetingsDir = path.join(vault, 'Meetings');
const ORGANIZE_LOG = path.join(os.homedir(), '.config', 'meeting-cli', 'organize-jobs', 'organize.log');

/** nota final → título da nota provisória (o log registra os dois nomes). */
function provisionalTitles(): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(ORGANIZE_LOG)) return out;
  let pending: string | null = null;
  for (const line of fs.readFileSync(ORGANIZE_LOG, 'utf-8').split('\n')) {
    const start = line.match(/nota provisória: (.+\.md)\s*$/);
    if (start) { pending = start[1]; continue; }
    const done = line.match(/concluído \([^)]*\): (.+\.md)\s*$/);
    if (done && pending) {
      const title = pending.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2} \d{2}-\d{2}(-\d{2})? - /, '');
      out.set(done[1], title);
      pending = null;
    }
  }
  return out;
}

/** Mesma regra do createMeetingNote em storage.ts. */
function fileNameFor(date: string, time: string, title: string): string {
  return `${date} ${time.replace(':', '-')} - ${title.replace(/[/\\:*?"<>|]/g, '-').slice(0, 60)}.md`;
}

function listVaultNotes(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;  // .obsidian, .trash
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) listVaultNotes(abs, acc);
    else if (e.name.endsWith('.md')) acc.push(abs);
  }
  return acc;
}

type Plan = { file: string; oldTitle: string; newTitle: string; source: string; newFile: string; content: string };

const fromLog = provisionalTitles();
const plans: Plan[] = [];
const unresolved: string[] = [];

for (const file of fs.readdirSync(meetingsDir).filter(f => f.endsWith('.md'))) {
  const raw = fs.readFileSync(path.join(meetingsDir, file), 'utf-8');
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fm) continue;
  const oldTitle = (fm[1].match(/^title:\s*"?(.*?)"?\s*$/m)?.[1] ?? '').trim();
  if (!oldTitle || looksLikeTitle(oldTitle)) continue;  // vazio = nota antiga sem o campo

  const afterFm = raw.slice(fm[0].length);
  const cut = afterFm.search(/\n---\n+## Transcri/);
  const organized = cut >= 0 ? afterFm.slice(0, cut) : afterFm;
  const tail = cut >= 0 ? afterFm.slice(cut) : '';
  // Reinterpreta o corpo sem o "# <título ruim>" que o salvamento acrescentou.
  const parsed = parseOrganizedSummary(organized.replace(/^\s*#[^\n]*\n/, ''));

  let newTitle = parsed.title;
  let source = 'corpo';
  if (!newTitle || !looksLikeTitle(newTitle)) {
    newTitle = fromLog.get(file) ?? '';
    source = 'organize.log';
    // 1:1 detectada pelo daemon usa o nome da pessoa como título provisório.
    if (/^\p{Lu}[\p{L}'-]+(\s+(d[aeo]s?\s+)?\p{Lu}[\p{L}'-]+)+$/u.test(newTitle)) newTitle = `1:1 — ${newTitle}`;
  }
  if (!newTitle || !looksLikeTitle(newTitle) || /organizacao automatica falhou/i.test(newTitle)) {
    unresolved.push(`${file}  (título: ${oldTitle.slice(0, 60)})`);
    continue;
  }

  const date = fm[1].match(/^date:\s*(\S+)/m)?.[1] ?? file.slice(0, 10);
  const time = fm[1].match(/^time:\s*(\S+)/m)?.[1] ?? file.slice(11, 16).replace('-', ':');
  let front = fm[1].replace(/^title:.*$/m, `title: "${newTitle.replace(/"/g, "'")}"`);
  if (parsed.participants.length > 0 && !/^participants:/m.test(front)) {
    front = front.replace(/^(tags:.*)$/m, `$1\nparticipants: [${parsed.participants.join(', ')}]`);
  }
  // Só troca o corpo quando o parse achou o título nele (o preâmbulo sai junto).
  const body = source === 'corpo' ? `# ${newTitle}\n\n${parsed.body.trim()}\n` : organized.replace(/^\s*#[^\n]*\n/, `# ${newTitle}\n`);
  plans.push({
    file, oldTitle, newTitle, source,
    newFile: fileNameFor(date, time, newTitle),
    content: `---\n${front}\n---\n${body}${tail}`,
  });
}

for (const p of plans) {
  console.log(`• ${p.oldTitle.slice(0, 70)}\n    → ${p.newTitle}   [${p.source}]`);
}
if (unresolved.length) {
  console.log(`\nSem título confiável (${unresolved.length}) — ficam como estão:`);
  for (const u of unresolved) console.log(`  - ${u}`);
}
console.log(`\n${plans.length} notas para reparar.`);

if (!APPLY) {
  console.log('Dry-run. Rode com --apply para gravar.');
  process.exit(0);
}

// O vault não está no git: guarda os originais antes de tocar em qualquer coisa.
const backupDir = path.join(os.homedir(), '.local', 'state', 'meeting-cli', `title-repair-${Date.now()}`);
fs.mkdirSync(backupDir, { recursive: true });
for (const p of plans) fs.copyFileSync(path.join(meetingsDir, p.file), path.join(backupDir, p.file));
console.log(`Backup dos originais: ${backupDir}`);

// Colisão de nome (duas notas no mesmo minuto com o mesmo título): mantém a
// nota no nome antigo em vez de sobrescrever outra.
const renames = new Map<string, string>();
for (const p of plans) {
  const target = path.join(meetingsDir, p.newFile);
  const keepName = p.newFile !== p.file && fs.existsSync(target);
  const finalName = keepName ? p.file : p.newFile;
  fs.writeFileSync(path.join(meetingsDir, finalName), p.content);
  if (finalName !== p.file) {
    fs.unlinkSync(path.join(meetingsDir, p.file));
    renames.set(p.file.replace(/\.md$/, ''), finalName.replace(/\.md$/, ''));
  }
}

let linkFiles = 0;
if (renames.size > 0) {
  for (const abs of listVaultNotes(vault)) {
    const before = fs.readFileSync(abs, 'utf-8');
    let after = before;
    for (const [oldName, newName] of renames) {
      after = after.split(`[[${oldName}]]`).join(`[[${newName}]]`)
        .split(`[[${oldName}|`).join(`[[${newName}|`)
        .split(`[[${oldName}#`).join(`[[${newName}#`);
    }
    if (after !== before) { fs.writeFileSync(abs, after); linkFiles++; }
  }
}
console.log(`Aplicado: ${plans.length} notas, ${renames.size} renomeadas, wikilinks atualizados em ${linkFiles} arquivos.`);
