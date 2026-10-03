# opencode-v2-plugins-toolkit

A personal toolkit of homegrown [OpenCode](https://opencode.ai) v2 plugins: agent guardrails, local tooling, and on-device voice I/O. Everything here is built for daily use, not third-party code.

## Plugins

| Plugin | What it does |
| ------ | ------------ |
| [block-env](./plugins/block-env/) | Permission hook that denies `.env*` access and recursive scans without an exclude rule |
| [codegraph-mandatory](./plugins/codegraph-mandatory/) | Injects the codegraph-first code search rule via context and compaction hooks |
| [jev](./plugins/jev/) | `jev_ask` decision-gate tool (Zen and direct transports) for model judgments |
| [ponytail-v2](./plugins/ponytail-v2/) | Native v2 wrapper for the Ponytail lazy-developer philosophy (`/ponytail`, modes off/lite/full/ultra) |
| [what-changed](./plugins/what-changed/) | Single-file `/what-changed` command: what changed since a fixed point |
| [voice](./plugins/voice/) | On-device Spanish dictation via Whistle (press to talk, text lands in the composer) |
| [text-to-voice](./plugins/text-to-voice/) | On-device bilingual TTS via Kokoro (Spanish + English), speaks every reply |

Each plugin folder has its own README with install and usage details.

## Install

Two scopes, same mechanism. Copy the plugin folder you want:

**A. Global** — available in every project:

```sh
cp -r plugins/<name> ~/.config/opencode/plugins/
```

**B. Project-local** — this checkout only, loaded from the project directory:

```sh
cp -r plugins/<name> <your-project>/.opencode/plugins/
```

Then restart OpenCode so the new plugin loads. No build step, no registry.

## Notes

- Voice plugins (`voice`, `text-to-voice`) need system dependencies (audio tools, model runtimes). See their READMEs.
- Everything runs locally. No API keys, no cloud calls.
