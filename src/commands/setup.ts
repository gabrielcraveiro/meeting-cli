import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import chalk from 'chalk';

// Sidecar MUST live on the Windows filesystem (accessible by both WSL and node.exe)
// We use the Windows user's home: C:\Users\<user>\.config\meeting-cli\sidecar
function getWindowsHome(): string {
  try {
    const winHome = execFileSync('node.exe', ['-e', 'process.stdout.write(require("os").homedir())'], {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();
    // Convert Windows path to WSL path: C:\Users\gabri -> /mnt/c/Users/gabri
    return winHome
      .replace(/^([A-Za-z]):\\/, (_, d: string) => `/mnt/${d.toLowerCase()}/`)
      .replace(/\\/g, '/');
  } catch {
    // Fallback: try common location
    return '/mnt/c/Users/' + (process.env.USER || 'user');
  }
}

const SIDECAR_DIR = path.join(getWindowsHome(), '.config', 'meeting-cli', 'sidecar');

export function getSidecarDir(): string {
  return SIDECAR_DIR;
}

export function getSidecarCapturePath(): string {
  return path.join(SIDECAR_DIR, 'capture.js');
}

export function isSidecarInstalled(): boolean {
  return (
    fs.existsSync(getSidecarCapturePath()) &&
    fs.existsSync(path.join(SIDECAR_DIR, 'node_modules', 'native-audio-node'))
  );
}

function getCaptureJsSource(): string {
  // Read from the sidecar directory in the project
  const candidates = [
    path.resolve(__dirname, '..', 'sidecar', 'capture.js'),
    path.resolve(__dirname, '..', '..', 'sidecar', 'capture.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return fs.readFileSync(c, 'utf-8');
  }
  // If running from global install, read from the installed sidecar
  if (fs.existsSync(getSidecarCapturePath())) {
    return fs.readFileSync(getSidecarCapturePath(), 'utf-8');
  }
  throw new Error('capture.js não encontrado no projeto. Certifique-se de que a pasta sidecar/ existe.');
}

function toWinPath(p: string): string {
  return p.replace(/^\/mnt\/([a-z])\//, (_, d: string) => `${d.toUpperCase()}:\\`).replace(/\//g, '\\');
}

export async function cmdSetup(): Promise<void> {
  console.log(chalk.bold('\n🔧 Meeting CLI — Setup\n'));

  // Step 1: Check node.exe
  console.log(chalk.blue('1. Verificando node.exe (Windows)...'));
  try {
    const ver = execFileSync('node.exe', ['--version'], { encoding: 'utf-8', timeout: 10000 }).trim();
    console.log(chalk.green(`   ✓ node.exe encontrado: ${ver}`));
  } catch {
    console.error(chalk.red('   ✗ node.exe não encontrado no PATH.'));
    console.error(chalk.gray('     Instale Node.js no Windows: https://nodejs.org'));
    console.error(chalk.gray('     Após instalar, feche e reabra o terminal WSL.'));
    process.exit(1);
  }

  // Step 2: Create sidecar directory and write files
  console.log(chalk.blue(`2. Criando sidecar em ${SIDECAR_DIR}...`));
  fs.mkdirSync(SIDECAR_DIR, { recursive: true });

  // Write capture.js
  let captureSource: string;
  try {
    captureSource = getCaptureJsSource();
  } catch (err) {
    console.error(chalk.red(`   ✗ ${(err as Error).message}`));
    process.exit(1);
  }
  fs.writeFileSync(getSidecarCapturePath(), captureSource);
  console.log(chalk.green('   ✓ capture.js escrito'));

  // Write package.json
  const pkgJson = JSON.stringify({ name: 'meeting-sidecar', version: '1.0.0', private: true }, null, 2);
  fs.writeFileSync(path.join(SIDECAR_DIR, 'package.json'), pkgJson);

  // Step 3: Install native-audio-node via Windows node.exe + npm
  console.log(chalk.blue('3. Instalando native-audio-node (pode levar ~30s)...'));
  const sidecarWinPath = toWinPath(SIDECAR_DIR);

  try {
    // Run npm install via node.exe (npm.cmd is a batch file that WSL can't execute directly)
    // Use "npm" from PATH (cmd.exe resolves it) instead of full path to avoid spaces in "Program Files"
    const installScript = [
      'const cp = require("child_process");',
      `const r = cp.execFileSync("npm", ["install", "native-audio-node"], { encoding: "utf-8", cwd: ${JSON.stringify(sidecarWinPath)}, timeout: 120000, shell: true });`,
      'process.stdout.write(r);',
    ].join('');
    const output = execFileSync('node.exe', ['-e', installScript], {
      encoding: 'utf-8',
      timeout: 120000,
    });
    if (output.includes('added') || output.includes('up to date')) {
      console.log(chalk.green('   ✓ native-audio-node instalado'));
    } else {
      console.log(chalk.gray(`   ${output.trim()}`));
    }
  } catch (err) {
    console.error(chalk.red('   ✗ Falha ao instalar native-audio-node'));
    console.error(chalk.gray(`     ${(err as Error).message}`));
    console.error(chalk.gray('     Tente manualmente num terminal Windows:'));
    console.error(chalk.gray(`     cd ${sidecarWinPath}`));
    console.error(chalk.gray('     npm install native-audio-node'));
    process.exit(1);
  }

  // Step 4: Validate WASAPI capture
  console.log(chalk.blue('4. Validando captura WASAPI...'));
  try {
    const testScript = [
      'const m = require("native-audio-node");',
      'const devices = m.listAudioDevices();',
      'const defOut = devices.find(d => d.isOutput && d.isDefault);',
      'const defIn = devices.find(d => d.isInput && d.isDefault);',
      'console.log(JSON.stringify({ defOut: defOut?.name, defIn: defIn?.name, totalDevices: devices.length }));',
    ].join('');
    const result = execFileSync('node.exe', ['-e', testScript], {
      encoding: 'utf-8',
      timeout: 10000,
      cwd: SIDECAR_DIR,
    }).trim();
    const info = JSON.parse(result);
    console.log(chalk.green(`   ✓ WASAPI OK — ${info.totalDevices} dispositivos`));
    console.log(chalk.gray(`     Saída (loopback): ${info.defOut || '?'}`));
    console.log(chalk.gray(`     Entrada (mic):    ${info.defIn || '?'}`));
  } catch (err) {
    console.error(chalk.yellow('   ⚠ Validação falhou — pode funcionar mesmo assim'));
    console.error(chalk.gray(`     ${(err as Error).message}`));
  }

  console.log(chalk.green('\n✅ Setup completo!\n'));
  console.log('Próximos passos:');
  console.log(chalk.gray('  meeting config    — configurar Deepgram, LiteLLM e vault'));
  console.log(chalk.gray('  meeting start     — iniciar gravação'));
  console.log('');
}
