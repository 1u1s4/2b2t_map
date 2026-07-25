<p align="center">
  <img src="./viewer/public/og.png" alt="Obsidian Atlas — explorador local del Overworld de 2b2t" width="100%">
</p>

# Obsidian Atlas

Obsidian Atlas es una herramienta local para revisar el Overworld publicado por
[2b2t.place](https://2b2t.place) por regiones pequeñas y a un ritmo decidido
por el usuario. El mapa se divide en una rejilla de tiles; toda región nueva se
explora con los datos originales LOD 0, permite avanzar en las cuatro
direcciones y registra qué celdas ya fueron revisadas. El zoom y el
desplazamiento cambian únicamente la presentación: no reducen el nivel de
detalle de la sesión.

La aplicación se sirve únicamente en `localhost`. Los datos persistentes se
guardan de forma atómica en LuisA y mantienen una copia de recuperación en el
navegador. La biblioteca existente se conserva: el visor solo abre WebP locales
válidos y la descarga regional solicita a la fuente únicamente los tiles que
falten en la celda elegida.

La versión actual admite únicamente **Overworld**.

## Qué incluye

- visor canvas con coordenadas X/Z, zoom, LOD y bloques por píxel;
- Atlas global con los 1,089 sectores visibles en una sola vista;
- una sola vista de descarga local LOD 0, con sectores listos, en curso y por
  explorar;
- rejilla maestra 33×33 basada en la huella irregular real de 66,464 tiles LOD 3;
- selección por arrastre de uno o varios sectores de 32,768×32,768 bloques;
- inicio directo de una sesión LOD 0 desde el sector o la región seleccionada;
- regiones dibujadas, tomadas de la vista o introducidas por coordenadas como
  alternativa avanzada;
- una celda de 512×512 bloques por tile LOD 0;
- navegación cardinal con cruceta y flechas del teclado;
- zoom y desplazamiento visuales sin cambiar el LOD de datos;
- zoom acotado a un presupuesto seguro de tiles visibles y cámara contenida en
  la región;
- varias sesiones pausables con progreso persistente y exportable;
- ausencias `404` persistentes en un estado **Sin datos** separado de
  **Revisadas**;
- descarga explícita de la celda actual entre `0.25` y `2 req/s`;
- capas `base`, `overlay` y `newchunks`;
- puntos y áreas con nombre, color y notas privadas;
- lectura exclusiva de la biblioteca local;
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
2. Consulta la descarga local LOD 0 y filtra sectores **Listos**, **En curso**
   o **Por explorar**.
3. Haz clic en un sector o arrastra sobre varios. El panel muestra sus límites
   X/Z y la cantidad de filas y columnas LOD 0.
4. Pulsa **Explorar en máximo detalle** o **Iniciar exploración LOD 0**. La
   primera celda se abre directamente a 512×512 bloques.
5. Recorre la región con la cruceta norte/sur/este/oeste, las flechas del
   teclado o un clic en otra celda.
6. Acerca, aleja o arrastra el mapa cuando necesites inspeccionar una
   estructura: los datos continúan en LOD 0.
7. Si falta el tile local, elige el ritmo y pulsa
   **Descargar celda actual**.
8. Cuando el detalle LOD 0 esté guardado, usa **Marcar como revisada**.
   Si la fuente confirma un `404`, usa **Omitir celda sin datos**.
9. **Pausar sesión** la conserva en LuisA; después puedes abrirla desde
   **Workspace durable**. **Guardar ahora** fuerza una escritura inmediata.

El progreso de revisión y la presencia del tile son conceptos distintos.
Descargar una celda no la marca como revisada, y navegar no inicia solicitudes
en segundo plano. Una ausencia `404` tampoco se disfraza de revisión: se guarda
en su propio bitset y se excluye del total revisable.

El Atlas se puede abrir mientras una sesión está activa. La cámara y el zoom
regionales se conservan y se restauran al volver. Un toque o clic selecciona el
sector; en móvil una cruceta permite corregir el foco con objetivos táctiles de
44 px. El inspector ofrece anterior/siguiente y límites X/Z exactos. La vista
global consulta `tiles.sqlite3` en modo lectura y usa internamente la huella
irregular publicada para calcular el objetivo LOD 0. Los `404` confirmados se
excluyen, de modo que una descarga exhaustiva pueda alcanzar 100% sin presentar
tiles inexistentes como pendientes eternos.

## Rejilla LOD 0 y coordenadas

Los límites de una región son rangos semiabiertos:

```text
X [minX, maxX) × Z [minZ, maxZ)
```

La región se expande a los bordes de los tiles que toca. Las coordenadas
negativas se resuelven con piso matemático, por lo que `X=-1` pertenece al tile
`-1`, no al tile `0`.

```text
LOD de datos de toda región nueva = 0
celda = 512 × 512 bloques
```

El zoom del canvas no selecciona otra resolución durante una sesión: rueda,
pellizco, doble clic, `+`, `-` y arrastre solo cambian la vista. La escala mínima
mantiene como máximo 8×6 tiles dentro del viewport antes del margen de render y
la cámara no puede perder la región seleccionada. El modelo admite hasta
4,000,000 de celdas por sesión y avisa antes de iniciar una selección que supere
ese límite.

Las sesiones creadas por versiones anteriores conservan su LOD, escala, celda
actual y progreso al restaurarlas o importarlas. Las sesiones con LOD heredado
son de solo lectura; **Crear versión en LOD 0** conserva la original y abre una
copia nueva en máximo detalle.

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

Siempre se descarga la capa `base` de la celda actual LOD 0; `overlay` y
`newchunks` se añaden cuando están visibles. El
runtime permite un trabajo regional a la vez, valida espacio antes de iniciarlo
y admite como máximo 64 combinaciones tile/capa por operación. **Detener
celda** termina las solicitudes activas de forma segura.

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

El visor consulta exclusivamente esta biblioteca. Chrome también puede abrir la
carpeta `2b2t_tiles` con permiso de solo lectura desde **Explorar → Biblioteca
local**. `/api/tile` nunca obtiene imágenes remotas: también ignora el parámetro
heredado `online=1`. Un tile ausente se obtiene mediante **Descargar celda
actual** y solo se muestra después de quedar guardado localmente.

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

El archivo contiene región, zoom, LOD, celda actual y bitsets independientes de
celdas revisadas y celdas sin datos. La importación valida versión, dimensión,
límites, contadores y codificación antes de añadirla al workspace.

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
