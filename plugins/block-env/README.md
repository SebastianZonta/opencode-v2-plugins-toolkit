# block-env

Guardia de privacidad para el agente: niega cualquier lectura, edición o ejecución de shell que toque archivos `.env`, y bloquea los barridos recursivos que no excluyan `.env` explícitamente.

## Por qué existe

Los `.env` guardan claves y tokens. Un `grep -r` distraído o un `find` amplio los arrastra al contexto del modelo y de ahí a un log, un diff o un mensaje. Este plugin corta eso de raíz: el acceso a `.env` no se advierte, se deniega.

## Cómo funciona

Un hook sobre `permission.evaluate` revisa cada acción `read`, `edit` y `shell`:

- **Archivos `.env`**: si algún recurso es (o está bajo) un path `.env`, la acción se deniega con `Blocked by block-env: .env files are off-limits`.
- **Barridos recursivos**: un `grep -r`, `rg`, `ripgrep` o `find` sin exclusión de `.env` se deniega con el mensaje que indica cómo reintentarlo (`--exclude=.env*` o equivalente). El plugin reconoce las formas comunes de exclusión (`--exclude`, `--exclude-dir`, `--glob`/`-g`, `-not`) para no castigar al que ya se cuidó.

## Instalación

Copiá `index.ts` a tu carpeta global de plugins y reiniciá OpenCode:

```sh
mkdir -p ~/.config/opencode/plugins/block-env
cp index.ts ~/.config/opencode/plugins/block-env/
```

Sin opciones, sin comandos, sin estado. Activo desde el arranque.

## Límites conocidos

- Solo cubre `read`, `edit` y `shell`. Otras superficies (red, procesos) no pasan por este hook.
- La detección de "recursivo" es por patrones sobre el comando. Un barrido exótico puede escapar; un comando legítimo raro puede chocar. Si un falso positivo duele, el camino es parseo por path en vez de regex (ver comentario `ponytail` en el código).
