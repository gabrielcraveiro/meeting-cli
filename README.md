# meeting-cli

CLI tool that captures system audio + microphone, transcribes with AI, and generates structured meeting notes — all from your terminal.

Built for **WSL2 + Windows** environments with Obsidian vault integration.

## Features

- **WASAPI audio capture** — records system audio (calls, browser) + microphone simultaneously
- **Live transcription** — 45-second segments transcribed in real-time via Deepgram
- **AI-powered summaries** — structured notes with participants, decisions, action items
- **Live chat during recording** — ask AI questions about the meeting in progress
- **Auto-insights** — push-based key points every 3 minutes
- **Smart template detection** — AI detects meeting type (daily, 1on1, retro, planning, technical)
- **Silence detection** — auto-stops after 3 minutes of silence
- **Retroactive trim** — strips silent trailing segments before final transcription
- **Dual-pass transcription** — fast preview (nova-2) + quality final (nova-3 with diarization)
- **Meeting briefing** — shows recent meeting summaries on start
- **Cross-meeting search** — full-text search across all meeting notes
- **Obsidian integration** — notes saved as Markdown with YAML frontmatter

## Requirements

- **WSL2** (Ubuntu/Debian) with Node.js 18+
- **Windows** `node.exe` in PATH (for WASAPI audio capture)
- **Deepgram** API key (for transcription)
- **LiteLLM / OpenAI-compatible** endpoint (for AI summaries and chat)
- **Obsidian vault** (optional, for note storage)

## Installation

### From npm

```bash
npm install -g @gabrielcraveiro/meeting-cli
meeting setup
```

### From source

```bash
git clone https://github.com/gabrielcraveiro/meeting-cli.git
cd meeting-cli
bash install.sh
```

The install script handles everything: dependencies, build, global install, and initial configuration.

### Manual setup

```bash
npm install
npm run build
npm install -g .
meeting setup    # installs sidecar + native audio
meeting config   # set API keys and vault path
```

## Usage

### Record a meeting

```bash
meeting start
```

During recording:
- Type anything to **chat with AI** about the meeting
- `/stop` — stop recording and generate notes
- `/ctx <file.md>` — add a vault file as context for the chat
- `/ctx <text>` — add free text as context
- `/contexto` — show loaded contexts
- `/help` — show all commands
- `Ctrl+C` — graceful stop (same as `/stop`)

### Other commands

```bash
meeting list              # list all meeting notes
meeting summary <file>    # show AI summary
meeting search <query>    # full-text search across meetings
meeting transcribe <wav>  # transcribe an existing audio file
meeting config            # edit configuration
meeting setup             # install/update sidecar
```

### Templates

```bash
meeting start --template daily
meeting start --template 1on1
meeting start --template retro
meeting start --template planning
meeting start --template technical
```

If no template is specified, the AI auto-detects the meeting type.

## Configuration

Config is stored at `~/.config/meeting-cli/config.json`:

```jsonc
{
  "vaultPath": "/mnt/c/path/to/your/obsidian/vault",
  "deepgramApiKey": "your-deepgram-api-key",
  "deepgramModel": "nova-2",
  "chatEndpoint": "https://your-litellm-or-openai-endpoint",
  "chatApiKey": "your-api-key",
  "chatModel": "gpt-4o-mini",
  "micDeviceId": "",        // optional: specific mic device
  "micGain": 1.0,           // mic volume multiplier
  "speakerNames": {         // optional: map speaker IDs to names
    "Speaker 0": "Alice",
    "Speaker 1": "Bob"
  }
}
```

## Architecture

```
WSL2 (Linux)                    Windows
┌──────────────┐               ┌──────────────────┐
│  meeting-cli │──stdin/out──▶ │  sidecar/capture  │
│  (Node.js)   │◀─ JSON events │  (node.exe)       │
│              │               │  WASAPI loopback  │
│  Deepgram ◀──┤               │  + microphone     │
│  LiteLLM  ◀──┤               └──────────────────┘
│  Obsidian ◀──┤
└──────────────┘
```

- **CLI** runs in WSL, handles transcription, AI, and note generation
- **Sidecar** runs as Windows `node.exe`, captures audio via WASAPI loopback
- Communication via JSON events over stdin/stdout
- Segments written as WAV files to a temp directory

## Cost

Typical meeting costs (30 min):
- Deepgram transcription: ~$0.18 (nova-2 live) + ~$0.27 (nova-3 final)
- AI organization: ~$0.01-0.03 (gpt-4o-mini)
- **Total: ~$0.50/meeting**

## License

MIT
