# jev

Expone a Jev (TypeSafe System One) como tool `jev_ask` para cualquier modelo de OpenCode: decisiones calibradas con tipos, sin generar texto.

## Por qué existe

Los LLMs generan texto; juzgar no es su fuerte. Jev es lo opuesto: solo decide (Choice/Score/Noul con probabilidades), no escribe ni llama tools. Este plugin le da al modelo un juez externo para routing, scoring y guardrails, y le enseña cuándo usarlo mediante una línea en el system prompt.

## Cómo funciona

- **Tool `jev_ask`**: recibe `state` (texto u objeto) + `questions` (mapa `{id: {type: 'choice'|'score'|'noul', ...}}`), opcionalmente `model`. Devuelve las respuestas tipadas con probabilidades. Estados chicos: estados grandes degradan precisión y revientan límites de contexto.
- **Regla de uso** (inyectada vía `session.hook("context")`): rutear juicios por `jev_ask`, generar el texto uno mismo, verificar números uno mismo. Una pregunta por juicio. Avanzar con confianza ≥ 0.8, si no re-chequear o preguntar al usuario.

## Transportes y configuración

En `opencode.json`:

```jsonc
{ "package": "/home/<vos>/.config/opencode/plugins/jev",
  "options": {
    "baseURL": "https://api.typesafe.ai",  // default: https://opencode.ai/zen/v1
    "apiKey": "<clave>",                   // solo modelos pagos; el free no pide
    "model": "jev-1.13-free"               // default
  } }
```

- **zen** (default): `OPENCODE_ZEN_API_KEY` contra `https://opencode.ai/zen`.
- **directo**: clave TypeSafe contra `https://api.typesafe.ai`.

El tier gratuito (`jev-1.13-free`) no necesita clave; los pagos dan 401 sin ella.

## Instalación

```sh
mkdir -p ~/.config/opencode/plugins/jev
cp index.ts ~/.config/opencode/plugins/jev/
```

La función `buildRequest` está exportada para testear el armado del request sin red.
