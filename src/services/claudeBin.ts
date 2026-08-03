import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// O binário `claude` vive em ~/.local/bin, que só entra no PATH via profile de
// shell interativo. Sessões headless (spawnadas pelo app → wsl.exe → node) não
// têm profile nenhum — spawn('claude') dá ENOENT. Este resolvedor centraliza a
// descoberta pra TODOS os pontos que invocam o claude (organizer, chat
// fallback, ask do vault). Mesma família do bug do fnm/node no shebang.

let cached: string | null = null;

export function resolveClaudeBin(): string {
  if (cached) return cached;

  const candidates = [
    process.env.MEETING_CLAUDE_BIN,
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) { cached = c; return c; }
    } catch {}
  }
  cached = 'claude';  // PATH pode resolver em shells interativos
  return cached;
}
