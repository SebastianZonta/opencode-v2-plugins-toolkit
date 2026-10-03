# jev

A decision-gate tool for agents: route judgments through Jev, generate text yourself.

## What it does

Exposes `jev_ask` to the agent — one question per judgment (choice, score, or noul), small explicit state, confidence threshold. Proceed at 0.8 or above, else re-check or ask the human.

## Transports

- **Zen**: `jev-1.13-free`, no key needed.
- **Direct**: paid models with an API key.

`buildRequest` is exported so other plugins and skills can construct calls.

## Why

Free-form "what do you think?" prompts to a model produce confident prose, not calibrated decisions. A fixed gate with a numeric threshold turns vague judgment calls into auditable pass/fail points.

## Install

```sh
cp -r plugins/jev ~/.config/opencode/plugins/   # global
```

Restart OpenCode. No configuration for the free tier.

## Notes

- Numbers and facts are still verified by executed code, never by the gate. Jev judges; evidence decides.
