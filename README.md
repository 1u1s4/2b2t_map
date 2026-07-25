<p align="center">
  <img src="./viewer/public/og.png" alt="Obsidian Atlas — explorador local del Overworld de 2b2t" width="100%">
</p>

# Obsidian Atlas

Obsidian Atlas es una herramienta local para revisar el Overworld publicado por
[2b2t.place](https://2b2t.place) por regiones pequeñas y a un ritmo decidido
por el usuario. El mapa se divide en una rejilla de tiles; cada sesión conserva
un zoom y un LOD fijos, permite avanzar con flechas o en recorrido serpentina y
registra qué celdas ya fueron revisadas.

La aplicación se sirve únicamente en `localhost`. Los datos persistentes se
guardan de forma atómica en LuisA y mantienen una copia de recuperación en el
navegador. La
biblioteca existente se conserva: los WebP válidos se reutilizan y solo se
solicitan los tiles que falten en la celda elegida.

La versión actual admite únicamente **Overworld**.

## Qué incluye

- visor canvas con coordenadas X/Z, zoom, LOD y bloques por píxel;
- Atlas global con los 1,089 sectores visibles en una sola vista;
- lentes separadas para terreno en disco, progreso revisado y fuente publicada;
- filtros de sectores completos, en curso y pendientes para LOD `0..3`;
- rejilla maestra 33×33 basada en la huella irregular real de 66,464 tiles LOD 3;
- selección por arrastre de uno o varios sectores de 32,768×32,768 bloques;
- regiones dibujadas, tomadas de la vista o introducidas por coordenadas;
- una celda por tile del LOD fijado;
- navegación cardinal y recorrido anterior/siguiente en serpentina;
- varias sesiones pausables con progreso persistente y exportable;
- descarga explícita de la celda actual entre `0.25` y `2 req/s`;
- capas `base`, `overlay` y `newchunks`;
- puntos y áreas con nombre, color y notas privadas;
- lectura prioritaria de la biblioteca local;
- tarjeta de capacidad de LuisA, sin iniciar trabajos por sí sola;
- composición opcional de una región como PNG o WebP desde el CLI.

## Inicio rápido en LuisA

Requisitos:

- macOS con `/Volumes/LuisA` montado;
- `/Volumes/2b2t Tiles` es opcional: si falta se usa `./2b2t_tiles`;
- Python 3.10 o posterior;
- Node.js `>=22.13.0`;
- Google Chrome actualizado;
- `screen`, `npm` y `/usr/bin/lockf`.

Instala las dependencias una vez:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt

cd viewer
npm ci
cd ..
```

Inicia el atlas:

```bash
./start_local_atlas_luisa.sh
```

Abre [http://localhost:3001](http://localhost:3001). El lanzador mantiene una
sola sesión local en segundo plano y valida que la biblioteca, LuisA, Python y
el visor estén disponibles.

```bash
./start_local_atlas_luisa.sh --status
./start_local_atlas_luisa.sh --stop
```

El log local está en:

```text
/Users/luisalvarado/Library/Application Support/ObsidianAtlas/local_atlas.log
```

Se puede cambiar el puerto o el intérprete al iniciar:

```bash
OBSIDIAN_ATLAS_VIEWER_PORT=3100 \
PYTHON_BIN='/Users/luisalvarado/Documents/GitHub/2b2t_map/.venv/bin/python' \
  ./start_local_atlas_luisa.sh
```

## Flujo de exploración

1. Abre **Atlas** desde el dock o con `0` / `Home`.
2. Elige **En disco**, **Revisado** o **Fuente** y, cuando corresponda, el LOD.
3. Filtra sectores completos, en curso o pendientes. Haz clic en uno, usa
   anterior/siguiente o arrastra sobre varios sectores.
4. Abre **Explorar** y usa **Encajar región**, **Preparar LOD 0**,
   **Dibujar región**, **Usar vista** o escribe límites X/Z exactos.
5. Ajusta el zoom deseado y crea la sesión; su zoom y LOD quedan fijados.
6. Recorre la rejilla fina con clic, las flechas o la ruta serpentina.
7. Usa **Marcar como revisada** o **Revisada y siguiente**.
8. Si falta información local, elige el ritmo y pulsa
   **Descargar celda actual**.
9. **Pausar sesión** la conserva en LuisA; después puedes abrirla desde
   **Workspace durable**. **Guardar ahora** fuerza una escritura inmediata.

El progreso de revisión y la presencia del tile son conceptos distintos.
Descargar una celda no la marca como revisada, y navegar no inicia solicitudes
en segundo plano.

El Atlas se puede abrir mientras una sesión está activa. La cámara y el zoom
regionales se conservan y se restauran al volver. En móvil, el primer toque
enfoca un sector y el segundo lo elige; el inspector ofrece
anterior/siguiente y límites X/Z exactos.

La lente **En disco** consulta `tiles.sqlite3` en modo lectura y respeta la
huella irregular publicada. **Revisado** une sesiones superpuestas sin contar
dos veces una misma zona. **Fuente** describe disponibilidad, no trabajo
pendiente: sus 961 sectores completos y 128 parciales contienen los 66,464
tiles LOD 3 publicados.

En LOD 0–2, esa huella LOD 3 funciona como envolvente de búsqueda. Los `404`
confirmados se excluyen del objetivo fino, de modo que una descarga exhaustiva
pueda alcanzar 100% sin presentar tiles no publicados como pendientes eternos.

El orden serpentina avanza de izquierda a derecha en una fila y de derecha a
izquierda en la siguiente. Así se cubre la región sin saltos largos.

## Rejilla, LOD y coordenadas

Los límites de una región son rangos semiabiertos:

```text
X [minX, maxX) × Z [minZ, maxZ)
```

La región se expande a los bordes de los tiles que toca. Las coordenadas
negativas se resuelven con piso matemático, por lo que `X=-1` pertenece al tile
`-1`, no al tile `0`.

| LOD | Bloques por píxel | Bloques por lado de celda |
| ---: | ---: | ---: |
| 0 | 1 | 512 |
| 1 | 2 | 1,024 |
| 5 | 32 | 16,384 |
| 10 | 1,024 | 524,288 |

En general:

```text
bloques_por_píxel = 2**LOD
bloques_por_celda = 512 * 2**LOD
```

Antes de crear una sesión, el LOD sigue al zoom. Durante la sesión ambos valores
se mantienen fijos. El modelo admite hasta 4,000,000 de celdas por sesión y usa
un bitset compacto para el progreso.

## Capacidad de LuisA

El lanzador usa estas ubicaciones:

```text
Biblioteca preferida: /Volumes/2b2t Tiles/2b2t_tiles
Fallback automático: ./2b2t_tiles
Respaldo físico: /Volumes/LuisA
```

La tarjeta **Capacidad local · LuisA** consulta en tiempo real el espacio de
ambos volúmenes y toma el menor valor disponible. La referencia predeterminada
para el Overworld es `1,458,909,433,254` bytes, aproximadamente `1.327 TiB`.
La comparación es conservadora: no descuenta de esa referencia lo ya presente
en la biblioteca.

El resultado puede ser:

- capacidad verificada;
- margen insuficiente;
- runtime local no configurado.

Es un diagnóstico de almacenamiento. No crea trabajos ni recorre el mapa. La
biblioteca actual, su SQLite y los WebP existentes permanecen en su lugar.

## Descargar una celda desde la interfaz

La UI ofrece cuatro ritmos:

```text
0.25 req/s · 0.5 req/s · 1 req/s · 2 req/s
```

Solo se descargan la celda actual, el LOD fijado y las capas visibles. El
runtime permite un trabajo regional a la vez, valida espacio antes de iniciarlo
y admite como máximo 64 combinaciones tile/capa por operación. **Detener
celda** termina las solicitudes activas de forma segura.

La vista rápida online es opcional, temporal y no escribe archivos. Al crear o
importar una sesión queda desactivada. Sus solicitudes no usan el control de
ritmo regional, por lo que conviene mantenerla apagada durante un análisis
medible.

## CLI regional

`download_region_2b2t.py` ofrece el mismo trabajo acotado desde la terminal.
Usa coordenadas semiabiertas y reutiliza automáticamente los WebP válidos.

Ejemplo de una celda LOD 0 alrededor de `-85181, 168232`:

```bash
python download_region_2b2t.py \
  --x-min -85504 \
  --z-min 167936 \
  --x-max -84992 \
  --z-max 168448 \
  --dimension overworld \
  --lod 0 \
  --layers base,overlay,newchunks \
  --out '/Volumes/2b2t Tiles/2b2t_tiles' \
  --workers 1 \
  --requests-per-second 1 \
  --max-tiles 3
```

También puede definirse una región desde su centro:

```bash
python download_region_2b2t.py \
  --center-x -85181 \
  --center-z 168232 \
  --width 2048 \
  --height 2048 \
  --dimension overworld \
  --lod 1 \
  --layers base,overlay \
  --out '/Volumes/2b2t Tiles/2b2t_tiles' \
  --workers 2 \
  --requests-per-second 0.5
```

Para generar una imagen con coordenadas:

```bash
mkdir -p exports
python download_region_2b2t.py \
  --x-min -86016 \
  --z-min 167424 \
  --x-max -83968 \
  --z-max 169472 \
  --dimension overworld \
  --lod 0 \
  --layers base,overlay \
  --out '/Volumes/2b2t Tiles/2b2t_tiles' \
  --workers 2 \
  --requests-per-second 1 \
  --compose exports/region.webp \
  --show-coordinates \
  --grid-step 128
```

Opciones importantes:

| Opción | Propósito |
| --- | --- |
| `--x-min`, `--z-min`, `--x-max`, `--z-max` | límites semiabiertos |
| `--center-x`, `--center-z`, `--width`, `--height` | modo alternativo por centro |
| `--lod 0..10` | resolución de los tiles |
| `--layers CSV` | capas solicitadas |
| `--requests-per-second` | ritmo global del trabajo |
| `--max-tiles` | rechazo preventivo de inventarios inesperados |
| `--compose` | mosaico PNG o WebP |
| `--show-coordinates` | cuadrícula y etiquetas en el mosaico |

El directorio de salida posee un bloqueo regional. `Ctrl+C` espera las
solicitudes activas y conserva lo obtenido; repetir el mismo comando reutiliza
los tiles válidos.

Consulta todas las opciones con:

```bash
python download_region_2b2t.py --help
```

## Biblioteca local

Los tiles conservan la estructura pública:

```text
2b2t_tiles/
├── base/{lod}/overworld/{shard_x}/{shard_z}/t.{tile_x}.{tile_z}.webp
├── overlay/{lod}/overworld/{shard_x}/{shard_z}/t.{tile_x}.{tile_z}.webp
├── newchunks/{lod}/overworld/{shard_x}/{shard_z}/t.{tile_x}.{tile_z}.webp
├── tiles.sqlite3
└── download.log
```

Los shards agrupan 32 tiles y truncan hacia cero, igual que el cliente público.
La ubicación del tile en el mundo, en cambio, usa piso matemático. El visor y
el CLI aplican cada regla en su lugar correspondiente.

El servidor local consulta primero esta biblioteca. Chrome también puede abrir
la carpeta `2b2t_tiles` con permiso de solo lectura desde **Explorar → Fuentes
de datos locales**.

## Workspace, sesiones y highlights

El runtime guarda el workspace autoritativo en una ruta fija derivada de
`OBSIDIAN_ATLAS_BACKING_ROOT`:

```text
/Volumes/LuisA/ObsidianAtlas/state/atlas-workspace.v1.json
```

Las escrituras usan revisión CAS, identificador idempotente, temporal en el
mismo directorio, `fsync`, renombrado atómico y backup. El documento conserva
hasta 128 sesiones, 10,000 highlights, la sesión activa y la selección global.
Las sesiones pausadas se pueden eliminar desde su tarjeta para liberar cupo.
Una copia completa permanece en `localStorage`, aislada por pestaña, para
recuperación cuando el volumen no está conectado. **Pausar y guardar** no
desactiva una sesión hasta asegurar disco o navegador; si aparece un conflicto,
la rama local se conserva y la UI exige confirmar antes de descartarla. El badge
distingue comprobando, guardando, guardado, solo lectura, sin disco, conflicto
y error.

La exportación manual de una sesión crea:

```text
obsidian-atlas-exploracion.json
```

El archivo contiene región, zoom, LOD, celda actual y bitset de celdas
revisadas. La importación valida versión, dimensión, límites, contador y
codificación antes de añadirla al workspace.

Los highlights pueden ser puntos o áreas con nombre, nota, color y visibilidad.
Su exportación crea
`obsidian-atlas-highlights.json`.

## Variables locales

Para ejecutar `npm run dev` manualmente desde `viewer/`:

| Variable | Uso |
| --- | --- |
| `OBSIDIAN_ATLAS_TILE_ROOT` | raíz canónica `2b2t_tiles` |
| `OBSIDIAN_ATLAS_BACKING_ROOT` | volumen físico usado en la comprobación |
| `OBSIDIAN_ATLAS_PYTHON` | intérprete para `download_region_2b2t.py` |
| `OBSIDIAN_ATLAS_OVERWORLD_REQUIREMENT_BYTES` | referencia de capacidad |

Ejemplo:

```bash
cd viewer
OBSIDIAN_ATLAS_TILE_ROOT='/Volumes/2b2t Tiles/2b2t_tiles' \
OBSIDIAN_ATLAS_BACKING_ROOT='/Volumes/LuisA' \
OBSIDIAN_ATLAS_PYTHON='/Users/luisalvarado/Documents/GitHub/2b2t_map/.venv/bin/python' \
  npm run dev -- --hostname localhost --port 3001
```

El runtime acepta peticiones únicamente desde loopback, no recibe rutas ni
comandos desde el navegador y protege las mutaciones con un token efímero.

## Comprobaciones

```bash
python -m unittest discover -s tests

cd viewer
npm run lint
npm test
```

La documentación técnica del visor está en
[`viewer/README.md`](viewer/README.md).
