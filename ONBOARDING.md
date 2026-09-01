# Onboarding — meeting-cli (instalação assistida por Claude)

> **Para o Claude que está lendo isto**: você vai instalar e configurar o meeting-cli
> na máquina desta pessoa, de ponta a ponta. Siga as etapas NA ORDEM, **verificando
> cada pré-requisito antes de instalar** (a máquina pode já ter partes prontas).
> Peça ao usuário apenas o que está marcado como `[PERGUNTAR]` — nunca invente
> chaves ou caminhos. Ao final, rode a validação da Etapa 9 e mostre o resultado.

## O que é isto

Ferramenta pessoal de reuniões (estilo Granola, local-first): detecta calls do
Microsoft Teams no Firefox, grava o áudio, transcreve (legendas do Teams +
Deepgram), organiza notas com IA num vault Obsidian, agrega tarefas e gera
briefing matinal. Três componentes:

| Componente | Onde roda | Artefato |
|---|---|---|
| CLI + daemon (`meeting`) | WSL2 (Node) | este repo → `npm i -g` |
| App desktop | Windows (Tauri) | `Meeting_x64-setup.exe` |
| Extensão do browser | Firefox | `.xpi` assinado |

Motores de IA: **modo básico** = endpoint OpenAI-compatible (LiteLLM corporativo
da ePharma) — funciona sem mais nada; **modo completo** = Claude Code CLI instalado
e logado no WSL (`organizerEngine: "claude"`) — adiciona pesquisa no vault,
wikilinks entre notas e fechamento automático de pendências.

## Etapa 0 — Levantamento (só leitura)

Verifique e reporte ao usuário o que já existe:

```powershell
wsl --status                 # WSL2 instalado?
wsl -e bash -lc "node --version; command -v meeting"   # Node/CLI no WSL?
node --version               # Node NATIVO no Windows (necessário p/ captura de áudio)
```

- Firefox instalado? (a extensão é só Firefox — sem Firefox, a detecção
  automática de calls não funciona; gravação manual pelo app continua possível)
- Obsidian instalado? Qual o caminho do vault que a pessoa quer usar? `[PERGUNTAR]`

## Etapa 1 — WSL2

Se `wsl --status` falhar: `wsl --install` (pode exigir reinicialização — avise o
usuário e retome depois). Distro padrão Ubuntu serve.

## Etapa 2 — Node no WSL + CLI

Dentro do WSL (use `wsl -e bash -lc "..."` ou peça um terminal WSL):

```bash
# Node LTS (qualquer gerenciador; nvm é o mais comum)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.nvm/nvm.sh && nvm install --lts

# CLI a partir do repo
git clone https://github.com/gabrielcraveiro/meeting-cli.git ~/meeting-cli
cd ~/meeting-cli && npm install && npm run build && npm install -g .
meeting --version   # deve responder
```

> Se o repo for privado, o usuário precisa de acesso ao GitHub do Gabriel
> Craveiro — `[PERGUNTAR]` se preferir receber um zip.

## Etapa 3 — Node no Windows + captura de áudio

A captura WASAPI roda via `node.exe` **do Windows** (o CLI no WSL o invoca):

```powershell
winget install OpenJS.NodeJS.LTS   # se `node --version` falhou na Etapa 0
```

Depois, no WSL: `meeting setup` — instala o sidecar de áudio
(`native-audio-node`) no lado Windows. Em seguida `meeting audiotest` para
validar que o microfone captura (peça ao usuário para falar).

## Etapa 4 — Configuração (`meeting config`)

Rode `meeting config` no WSL. Valores:

- **vaultPath**: caminho WSL do vault Obsidian (ex.: `/mnt/c/Users/<user>/Documents/Obsidian/<vault>`) — crie o vault vazio se necessário.
- **Deepgram API key**: `[PERGUNTAR]` — cada pessoa cria a própria em
  https://console.deepgram.com (tem tier gratuito). Modelo: `nova-2`.
- **chatEndpoint**: o LiteLLM corporativo (o wizard já sugere o default da
  ePharma). **chatApiKey**: `[PERGUNTAR]` — chave individual do gateway LiteLLM
  (pedir ao time de Inova/Labs). Modelo: o que o gateway expõe (ex.: `gpt-5.6-luna`).
- **ICS da agenda** (opcional, recomendado): no Outlook Web → Configurações →
  Calendário → Calendários compartilhados → publicar → copiar link ICS.
- **userName**: nome completo da pessoa como aparece no Teams (habilita a seção
  "Com você" nas tarefas e o dossiê de 1:1).

## Etapa 5 — Modo completo (opcional): Claude Code

Se a pessoa tem (ou quer) Claude Code no WSL:

```bash
npm install -g @anthropic-ai/claude-code
claude   # login interativo — o USUÁRIO faz, não você
```

Depois adicione no `~/.config/meeting-cli/config.json`: `"organizerEngine": "claude"`.
Sem isso, o sistema opera em modo básico via LiteLLM (automático — nada a fazer).

## Etapa 6 — App desktop

Preferencial: instalar o `Meeting_x64-setup.exe` fornecido pelo Gabriel.
Alternativa (build local — precisa Rust + toolchain, ~10 min):

```powershell
winget install Rustlang.Rustup; rustup default stable-msvc
cd C:\<caminho-do-clone>\app; npm install; npm run tauri:build
# instalador sai em app\src-tauri\target\release\bundle\nsis\
```

Abra o app: ele deve subir o daemon sozinho (resolve o CLI dentro do WSL
automaticamente). Se a Home carregar agenda/notas, o daemon está de pé.

## Etapa 7 — Extensão do Firefox

Arraste o `.xpi` fornecido (ex.: `dist-ext/b19c862c…-0.2.6.xpi`) para uma janela
do Firefox → "Adicionar". Entre numa call de teste do Teams **no Firefox**:
o app deve mostrar a gravação começar sozinha.

## Etapa 8 — Briefing matinal (opcional)

No WSL, agende o cron (o `node` explícito é obrigatório — o cron não tem o PATH
do gerenciador de Node):

```bash
bash ~/meeting-cli/scripts/install-briefing-schedule.sh
sudo service cron start   # e habilite systemd no /etc/wsl.conf p/ persistir
```

> O script resolve os caminhos do node/meeting; confira com `crontab -l`.

## Etapa 9 — Validação final (obrigatória)

```bash
meeting doctor                      # tudo verde?
meeting daemon restart
curl -s http://127.0.0.1:7899/status   # {"recording":false,...}
```

Teste completo: entre numa call de Teams no Firefox com legendas → fale 1 min →
saia → em ~2 min a nota organizada aparece no vault e na Home do app.
Mostre ao usuário: a nota gerada, a tela de Tarefas e o card do briefing.

## Problemas comuns

- **App diz "daemon offline"**: `wsl -e bash -lc "meeting daemon restart"`; se
  `meeting` não resolve em `bash -lc`, o profile do bash não carrega o Node —
  adicione o gerenciador (nvm/fnm) ao `~/.bashrc`.
- **Áudio silencioso**: `meeting audiotest` e ajuste `micGain` no config (o mic
  de notebook costuma precisar de 10-25).
- **Notas sem wikilinks/pesquisa**: modo básico (sem `claude`) — esperado; veja Etapa 5.
- **Extensão não detecta call**: legendas do Teams precisam estar disponíveis;
  confira que a call roda no Firefox (não no app desktop do Teams).
