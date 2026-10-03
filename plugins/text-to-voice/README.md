# 🔊 text-to-voice — hear your OpenCode agent speak

An OpenCode v2 plugin that reads every agent response aloud through your speakers. Fully on-device, no cloud, no API key, no subscription. Spanish and English, each in its own native voice, detected sentence by sentence.

You type (or dictate), the agent talks back. That's the whole pitch.

## What it feels like

- You send a prompt. One or two seconds after the turn ends, the answer starts playing.
- Sentences join without gaps: the next one is synthesized while the current one plays.
- A new response cuts off the old one. Hitting enter cuts it off too. Latest wins, never a queue, never overlapping audio.
- Mixed language just works: *"El deploy salió bien, let's ship it"* speaks Spanish in a Spanish voice and English in an English voice, in the same reply.

## How it works

Three ideas do all the heavy lifting:

1. **Hot daemon, not cold starts.** Kokoro (the TTS engine, ~350 MB + torch) stays loaded in a background daemon holding **two pipelines, one per language**. Models load once at startup instead of ~8 s per reply, so each synthesis costs inference only (~2 s). Falls back to one-shot synthesis if the daemon is ever unavailable.
2. **Chunks + prefetch.** Each reply is split into sentence-sized chunks. While chunk *N* plays, chunk *N+1* is already synthesizing, so sentences join seamlessly. Prefetch stays exactly one chunk deep: the daemon's inbox is latest-wins, so overlapping requests would discard each other unheard.
3. **Per-chunk language routing.** Every chunk is language-detected with a tiny stopword heuristic (no dependencies, no models) and routed to its voice. Majority wins inside mixed chunks; ties and unknowns default to Spanish.

A hidden system instruction (never shown in your transcript) steers every response toward speakable formatting: short sentences, no tables, no code dumps unless you ask.

## Requirements

- **Linux** with OpenCode v2
- Python 3 with [Kokoro](https://github.com/hexgrad/kokoro) ≥ 0.9.4 and `soundfile`
- `espeak-ng` (Spanish phonemics), spaCy's `en_core_web_sm` (English phonemics)
- An audio player: `paplay` (preferred) or `aplay`
- ~2.1 GB RAM for the daemon (both pipelines hot)

## Install

**Option A — project-local (recommended).** Copy this folder to your project's plugin directory:

```sh
mkdir -p <your-project>/.opencode/plugins
cp -r text-to-voice <your-project>/.opencode/plugins/
```

It loads automatically the next time you start OpenCode in that project.

**Option B — as a package.** Point your `opencode.json` at it:

```jsonc
{
  "plugins": ["github:SebastianZonta/opencode-v2-text-to-speech-plugin"],
}
```

Then restart OpenCode.

### Dependencies

```sh
# 1. Kokoro runtime + WAV writer
#    (--break-system-packages is needed on PEP 668 systems: Debian 12+, Ubuntu 23.04+)
pip install --break-system-packages "kokoro>=0.9.4" soundfile

# 2. English phonemics (spaCy model for the English pipeline)
pip install --break-system-packages "en_core_web_sm @ https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl"

# 3. Spanish phonemics
sudo apt install espeak-ng

# 4. Audio player (paplay preferred, aplay fallback)
sudo apt install pulseaudio-utils  # or: sudo apt install alsa-utils
```

## Use

| Action | Effect |
|---|---|
| *(nothing)* | Every finished response plays automatically |
| `/toggle-tts` | Flip voice output on/off at runtime (until restart) |
| Enter mid-playback | Stops the audio immediately |
| New response mid-playback | Interrupts; only the latest reply plays |

The status bar shows `🔊 tts` when idle and an animated `playing…` while speaking. Synthesis or player failures surface as a single toast and never break your session.

## Configure

Speaking is **on by default**. Defaults off in `opencode.json(c)`:

```jsonc
{
  "plugins": [
    {
      "package": "./.opencode/plugins/text-to-voice",
      "options": { "speakResponses": false },
    },
  ],
}
```

The config flag gates both speech and the speakability instruction; the runtime toggle gates speech only (formatting stays speakable until restart). The toggle is in-memory: a restart restores your configured default.

### Voices

Fixed pair, no picker UI to maintain:

| Language | Kokoro voice | Gender |
|---|---|---|
| Spanish | `em_alex` | Male |
| English | `am_michael` | Male |

To try another English voice, change the id in the `VOICES` map in `tts.py` (Kokoro `a`-family ids, e.g. `am_adam`, `am_echo`). Keep the pair same-gender so the assistant stays one identity across languages.

## Troubleshooting

- **First reply after install is slow (~10 s).** Normal: both pipelines load once (prewarm runs at startup). Every reply after that is inference-only.
- **English fails but Spanish works.** The English pipeline needs `en_core_web_sm`, and Kokoro's self-download crashes on PEP 668 systems. Install it manually with the step-2 command above, then restart OpenCode.
- **No sound, toast about players.** Install `paplay` or `aplay` (step 4).
- **Overlapping or repeated speech.** You are running a stale build: restart OpenCode. All audio state is singleton per process, so duplicates mean old code is still loaded.
- **Changed code but nothing differs.** TUI plugins load at startup: always restart OpenCode after updating.
- **Silence costs nothing.** `/toggle-tts` off kills the daemon (~2.1 GB back) until the next restart.

## Verify (no audio needed)

```sh
python3 -m unittest test_tts test_ttsd   # 13 stubbed-Kokoro contract tests
python3 tts.py say /tmp/reply.wav "Hola mundo"   # needs kokoro installed
```

## Layout

- `tui.tsx` — TUI entry: speaker indicator, toggle command, response listener, chunked synthesize → play pipeline with prefetch
- `index.ts` — server entry: hidden speakability instruction per request (import-free, required by the OpenCode loader)
- `tts.py` — Kokoro text-to-WAV CLI with per-chunk language detection (also the one-shot fallback when the daemon is unavailable)
- `ttsd.py` — persistent synth daemon: both pipelines hot, stdio JSON protocol with optional per-request `lang`, latest wins
- `test_tts.py`, `test_ttsd.py` — stubbed-runtime contract tests (exit codes, WAV properties, per-voice routing)
- `package.json` — plugin manifest (`.` server entry, `./tui` TUI entry)

Flat layout only: OpenCode silently ignores a `src/` subdirectory, and the server entry must stay import-free.
