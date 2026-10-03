# ponytail-v2

The Ponytail lazy-senior-developer philosophy as a native OpenCode v2 plugin.

## What it does

- `/ponytail` command with modes `off`, `lite`, `full`, `ultra`. Full is the default: stdlib and platform first, shortest diff wins, deletion over addition.
- 6 bundled skills carrying the method (ladder, boundaries, output discipline).
- Instructions vendored in-plugin: works offline, no downloads.

## The idea in one paragraph

Stop at the first rung that holds: does this need to exist, is it already in the codebase, does stdlib do it, does the platform do it, does an installed dependency do it, can it be one line — only then write the minimum code that works. Bug fix means root cause, not symptom. Non-trivial logic leaves one runnable check behind.

## Install

```sh
cp -r plugins/ponytail-v2 ~/.config/opencode/plugins/   # global
```

Restart OpenCode, then `/ponytail full` (or `lite`, `ultra`, `off`).

## Notes

- Ponytail governs what gets built, never thoroughness of understanding: read fully first, then be lazy.
- Never skipped: input validation at trust boundaries, error handling that prevents data loss, security, accessibility basics.
