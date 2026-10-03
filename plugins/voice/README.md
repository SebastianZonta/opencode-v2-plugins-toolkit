# opencode-voice — push-to-talk input for OpenCode (on-device, Spanish)

Talk to OpenCode instead of typing. Press `ctrl+q` (or `/voice-record`), speak
Spanish (max 30s), press again — by default the transcription is polished by
an agent and auto-sent into the live session. If Polish is off (or the agent
fails) the raw transcription is used; if direct send fails it falls back to
draft insert + submit, then clipboard paste.

Capture and transcription run on-device: PortAudio mic capture, Whistle
(`cactus-needle`, ~17MB CPU model downloaded once on first use), language
forced to Spanish, no key. Agent Polish (on by default) shells out to
`opencode run` with your default model, which may be a cloud model.

## Status

Linux (audio via PortAudio — PulseAudio/PipeWire/ALSA; clipboard via
`wl-copy` or `xclip`). Project-local plugin: copy this folder to
`<your-project>/.opencode/plugins/voice/` and register it in `opencode.json`
(see Configure) — it loads when OpenCode starts from that project directory.

## Dependencies

```sh
# 1. PortAudio — microphone capture (Debian/Ubuntu; Fedora: portaudio)
sudo apt install libportaudio2 portaudio19-dev

# 2. Whistle runtime + mic extras (needs --break-system-packages on
#    PEP 668 systems, e.g. Debian 12+/Ubuntu 23.04+)
pip install --break-system-packages 'cactus-needle[mic]' sounddevice numpy

# 3. Clipboard fallback — only used when direct session send fails
#    (OpenCode v2 exposes no draft-write API to plugins, so the fallback
#    copies + pastes; press ctrl+v if the draft stays empty)
sudo apt install wl-clipboard   # Wayland  |  or: sudo apt install xclip  # X11
```

## Use

- `ctrl+q` or `/voice-record` — toggle start/stop (auto-stops at 30s)
- `/voice-cancel` — discard the live recording, never touches the draft
- `/toggle-voice-polish` — flip agent Polish on/off at runtime (until restart)
- Mic indicator (bottom prompt status): `🎤 voice (ctrl+q)` idle, blinking
  `●/○ REC SS/30s` (zero-padded seconds) while recording,
  `…transcribing (first run downloads model)` while decoding,
  `polishing with agent.` + 1–3 cycling dots while the Polish agent rewrites
- During transcribing/polishing, toggle and cancel no-op with a
  "Transcribing — wait a moment" toast; cancel when idle toasts
  "Nothing recording"
- Empty/silence, missing mic, or missing deps → toast, draft untouched

## Configure

Agent Polish (light rewrite of the transcription before sending) is on by
default. Turn it off in `opencode.json(c)`:

```jsonc
{
  "plugins": [{ "package": "./.opencode/plugins/voice", "options": { "polishSpeechWithAgent": false } }],
}
```

The config wins on every restart; `/toggle-voice-polish` overrides it only
until the next restart.

How Polish works: the raw transcription is piped to a headless
`opencode run` agent (a fast flash model; latency varies), which returns a light
rewrite — punctuation, filler words, run-ons — and that text is sent as
your message. If the agent fails, the raw transcription is sent instead.
Each polish runs in a throwaway session that stays in your session list.

## Layout (plugin code and tests live in `.opencode/plugins/voice/`)

- `tui.tsx` — TUI entry: mic indicator, keymap commands, record → transcribe
  → polish → send pipeline
- `index.ts` — loader entry (empty server plugin, required by the loader)
- `voice.py` — mic capture (PortAudio) + Whistle transcription CLI
- `package.json` — plugin manifest (`.` server entry, `./tui` TUI entry)

Contract tests (same directory):

- `test_voice.py` — core stubbed-Whistle contract tests for `voice.py`
- `test_voice_transcribe.py` — transcribe path: exit 0/1/2/3, Spanish forcing
- `test_voice_record.py` — record path: WAV format, signal flush, caps (~65s)

## Verify (no mic needed, run from repo root)

```sh
npm test   # all 33 contract tests (~70s, record path is wall-clock)
python3 .opencode/plugins/voice/voice.py transcribe missing.wav  # exit 1 (missing file, deps installed); 2 = empty; 3 = missing deps; error on stderr
```

With a mic: `arecord -d 3 -f S16_LE -r16000 -c1 /tmp/clip.wav`, then
`python3 .opencode/plugins/voice/voice.py transcribe /tmp/clip.wav`.

## Release checklist

- [ ] `npm test` green
- [ ] Every README claim re-checked against `tui.tsx`/`voice.py`
      (indicator strings, keymap binds, exit codes, Polish behavior)
- [ ] Root `README.md` re-mirrored from the plugin README

## Sources

- [cactus-needle on PyPI](https://pypi.org/project/cactus-needle/)
- [Whistle: Speech to Text in 16.9 MB (Cactus)](https://cactuscompute.com/blog/whistle)
