# text-to-voice — voice output for OpenCode (on-device, Spanish + English)

Agent responses read aloud. The finished text of each response is synthesized
with Kokoro and played through your speakers — the other half of the
voice-to-voice loop alongside the voice-input plugin.

Everything runs on your machine: synthesis via Kokoro (~350MB model plus
torch, downloaded once on first use), no cloud, no API key.

Each sentence (Chunk) is auto-detected as Spanish or English and spoken in
its Voice: `em_alex` (male) for Spanish, `am_michael` (male) for English.
To try another English voice, change the voice id in the `VOICES` map in
`tts.py` (Kokoro `a`-family ids, e.g. `am_adam`, `am_echo`, `am_michael`).

For speed, both Kokoro pipelines stay loaded in a background daemon
(`ttsd.py`, ~2.1GB RSS for the pair): models load once at startup (prewarm)
instead of ~8s per reply, so each synthesis costs inference only (~2s) in
either language. Replies are split into Chunks and the next Chunk is
synthesized while the current one plays (Prefetch), so sentences join without
pauses and audio starts ~1-2s after the turn ends. If the daemon is
unavailable the plugin falls back to one-shot synthesis (slower).

## Status

Linux only. Project-local plugin: this folder lives at
`<your-project>/.opencode/plugins/text-to-voice/` — it loads when OpenCode
starts from that project directory.

## Dependencies

```sh
# 1. Kokoro runtime + WAV writer (needs --break-system-packages on
#    PEP 668 systems, e.g. Debian 12+/Ubuntu 23.04+)
pip install --break-system-packages "kokoro>=0.9.4" soundfile

# 2. English phonemics (spaCy model for the English pipeline)
pip install --break-system-packages "en_core_web_sm @ https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl"

# 3. Speech data for Spanish phonemics
sudo apt install espeak-ng

# 4. Audio player (paplay preferred, aplay fallback)
sudo apt install pulseaudio-utils  # or: sudo apt install alsa-utils
```

## Use

- `/toggle-tts` — flip voice output on/off at runtime (until restart)
- Speaker indicator (bottom prompt status): `🔊 tts` idle, `…playing`
  while speaking
- A new response interrupts the one playing — latest wins, never a queue
- Hitting enter while audio plays stops it immediately
- Synthesis/player failure → toast, session untouched

## Configure

Speaking is on by default. Turn it off in `opencode.json(c)`:

```jsonc
{
  "plugins": [{ "package": "./.opencode/plugins/text-to-voice", "options": { "speakResponses": false } }],
}
```

The config gates both speech and the speakability instruction; the runtime
toggle gates speech only (the instruction still steers formatting until
restart).

How it works: a hidden system instruction (no tables, no code blocks unless
asked, short sentences) steers every response speakable; the finished text
is split into Chunks, each detected and synthesized in its language, then
played back to back with the next Chunk prefetched. Each response is one
pipeline run per Chunk, one playback.

## Layout (all plugin code lives in `.opencode/plugins/text-to-voice/`)

- `tui.tsx` — TUI entry: speaker indicator, toggle command, response
  listener, synthesize → play pipeline with Prefetch
- `index.ts` — server entry: hidden speakability instruction per request
  (import-free, required by the loader)
- `tts.py` — Kokoro text-to-WAV CLI with per-Chunk language detect
  (`VOICES` map, stopword-majority heuristic; also the one-shot fallback
  when the daemon is unavailable)
- `ttsd.py` — persistent synth daemon (holds both Kokoro pipelines in
  memory, stdio JSON protocol with optional per-request `lang`, latest wins)
- `test_tts.py` — stubbed-Kokoro contract tests for `tts.py` (routing by
  PCM marker, `--lang` hint, detect unit cases)
- `test_ttsd.py` — daemon protocol tests (ready/ok/empty/bad-line/latest-wins,
  auto-route, lang hint)
- `package.json` — plugin manifest (`.` server entry, `./tui` TUI entry)

## Verify (no audio needed)

```sh
cd .opencode/plugins/text-to-voice && python3 -m unittest test_tts test_ttsd
python3 .opencode/plugins/text-to-voice/tts.py say /tmp/reply.wav "Hola mundo"  # needs kokoro installed
```
