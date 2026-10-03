# ponytail-v2

Wrapper nativo del ruleset Ponytail para OpenCode v2: el agente perezoso por defecto. El mejor código es el que nunca se escribe.

## Por qué existe

El paquete publicado solo exporta función de servidor v1 y el server v2 lo rechaza. Este plugin reimplementa el mismo comportamiento sobre la API nativa v2: inyecta las reglas en cada request, registra el comando `/ponytail` y suma los skills empaquetados.

## La escalera (resumen)

1. ¿Necesita existir? Necesidad especulativa = se salta.
2. ¿Ya está en el código? Reutilizar antes que reimplementar.
3. ¿Lo hace la stdlib? Usarla.
4. ¿Lo cubre la plataforma? Input nativo antes que librería.
5. ¿Lo resuelve una dependencia instalada? Usarla, nunca agregar una nueva por poco código.
6. ¿Entra en una línea? Una línea.
7. Recién ahí: el mínimo código que funciona.

Nunca se simplifican: validación en bordes de confianza, errores que evitan pérdida de datos, seguridad, accesibilidad, lo pedido explícito.

## Uso

- `/ponytail` — muestra el nivel actual.
- `/ponytail lite|full|ultra|off` — cambia la intensidad. `off` desactiva, `full` es el default.
- El nivel persiste en storage (y en el flag legacy `~/.config/opencode/.ponytail-active` por migración v1). `PONYTAIL_DEFAULT_MODE` como default por entorno.

## Skills incluidos (`skills/`)

- `ponytail` — el modo principal.
- `ponytail-review`, `ponytail-audit` — revisión y auditoría.
- `ponytail-debt`, `ponytail-gain` — deuda y mejoras.
- `ponytail-help` — ayuda.

## Instalación

```sh
mkdir -p ~/.config/opencode/plugins/ponytail-v2
cp index.ts instructions-*.txt ~/.config/opencode/plugins/ponytail-v2/
cp -r skills ~/.config/opencode/plugins/ponytail-v2/
```

Los textos `instructions-*.txt` (vendored de ponytail 4.10.0) son el ruleset por nivel; si falta uno hay fallback embebido. Todo es best-effort con degradación elegante: sin skills igual inyecta y el comando sigue andando.
