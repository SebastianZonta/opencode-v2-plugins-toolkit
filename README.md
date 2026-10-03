# opencode-v2-plugins-toolkit

Mis plugins caseros para OpenCode v2, todos juntos. Nada third-party: cada uno nació de una necesidad concreta y vive acá con su README propio.

## Los plugins

| Plugin | De qué trata |
|---|---|
| [block-env](plugins/block-env/) | Niega acceso a `.env` y frena barridos recursivos que no los excluyan. Privacidad por defecto. |
| [codegraph-mandatory](plugins/codegraph-mandatory/) | Obliga al agente a buscar código por el grafo primero, siempre. Menos grep ciego, más relaciones. |
| [jev](plugins/jev/) | Juez externo de decisiones (Choice/Score/Noul) como tool. El modelo genera, Jev juzga. |
| [ponytail-v2](plugins/ponytail-v2/) | El desarrollador perezoso: YAGNI, reutilizar, stdlib primero. Con niveles y skills. |
| [what-changed](plugins/what-changed/) | `/what-changed`: qué trajo la versión instalada, aunque el tag venga vacío. |
| [voice](plugins/voice/) | Dictado push-to-talk en español con Whistle, todo on-device. [(README en inglés)](plugins/voice/README.md) |
| [text-to-voice](plugins/text-to-voice/) | Las respuestas suenan por tus parlantes con Kokoro, español e inglés. [(README en inglés)](plugins/text-to-voice/README.md) |

Cada carpeta tiene su README con instalación, uso y configuración en detalle.

## Instalación (idea general)

- Los cinco primeros son **globales**: copiá cada carpeta (o el `.ts` en el caso de what-changed) a `~/.config/opencode/plugins/` y reiniciá OpenCode.
- `voice` y `text-to-voice` son **por proyecto**: copiá la carpeta a `<tu-proyecto>/.opencode/plugins/` y declará el paquete en tu `opencode.json`. Piden dependencias de audio y modelos (todo on-device, ver sus READMEs).

## Notas

- Todo corre local salvo lo que cada README marque como red (compare API de GitHub en what-changed, transporte Zen/directo en jev, modelo de polish en voice).
- OpenCode v2, Linux. Probado en el día a día, no en laboratorio.
