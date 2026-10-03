# what-changed

Comando `/what-changed`: resume en inglés qué cambió en la versión instalada de OpenCode v2, corto y agrupado.

## Por qué existe

Las versiones de OpenCode salen seguido y el tag suele ser solo un bump sin notas. Este comando hace el trabajo mecánico: detecta la versión, busca las notas, y si el tag está vacío compara los commits reales entre versiones y los resume.

## Cómo funciona

Registra el comando `what-changed`, que inyecta un prompt con el procedimiento:

1. `opencode --version` para la versión instalada.
2. Notas del tag (`github.com/anomalyco/opencode/releases/tag/v<versión>`) y changelog (`opencode.ai/changelog`).
3. Si el tag está vacío, API de compare `v<prev>...v<curr>` (tags v2 `v2.0.x`) y resumen de sus mensajes.
4. Respuesta en inglés, concisa: fecha del tag, aviso si el bump venía vacío, lista de Feats/Fixes principales con PR cuando hay, links al tag y al compare al final.

El plugin no hace la búsqueda él mismo: delega en el agente con la receta exacta. Sin dependencias salvo red.

## Instalación

Es un plugin de un solo archivo. Copialo a la carpeta global y reiniciá:

```sh
cp what-changed.ts ~/.config/opencode/plugins/
```
