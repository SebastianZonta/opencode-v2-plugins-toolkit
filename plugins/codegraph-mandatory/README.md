# codegraph-mandatory

Inyecta en cada request del agente la regla de búsqueda codegraph-first: ante código, primero el grafo, después las herramientas comunes.

## Por qué existe

Explorar código con grep a ciegas quema contexto y pierde relaciones (quién llama a quién, impacto de un cambio). Codegraph ya indexa el proyecto; este plugin se asegura de que el agente lo use primero, siempre, sin depender de que el modelo se acuerde.

## Cómo funciona

Dos hooks de sesión sobre `context` (y `compaction` cuando el host lo expone):

- Agrega el system prompt `CODEGRAPH MODE ACTIVE` a cada request del loop, con dedup (si ya está, no duplica).
- Sobrevive a la compactación: reinyecta la regla en los resúmenes para que el modo no se pierda a mitad de sesión.

La regla ordena: `codegraph_explore` primero para qué/cómo/dónde y antes de editar; herramientas comunes solo cuando codegraph no cubre (proyecto sin índice, configs, docs, índice viejo).

## Instalación

```sh
mkdir -p ~/.config/opencode/plugins/codegraph-mandatory
cp index.ts ~/.config/opencode/plugins/codegraph-mandatory/
```

Requiere el servidor MCP `codegraph` configurado (`codegraph serve --mcp`). Sin opciones ni comandos.

## Desinstalación limpia

El `setup` devuelve dispose que libera los hooks. Sacar la carpeta y reiniciar alcanza.
