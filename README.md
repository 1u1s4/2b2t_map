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
navegador. La biblioteca existente se conserva: el visor solo abre WebP
locales válidos. Antes de explorar, comprueba la región exacta contra SQLite y
el filesystem; si falta algo, descarga únicamente lo pendiente y reutiliza
tanto los WebP válidos como los `404` ya confirmados.

La versión actual admite únicamente **Overworld**.

## Qué incluye

- visor canvas con coordenadas X/Z, zoom, LOD y bloques por píxel;
- Atlas global con los 1,089 sectores visibles en una sola vista;
- una sola vista de descarga local LOD 0, con sectores listos, en curso y por
  explorar;
- rejilla maestra 33×33 basada en la huella irregular real de 66,464 tiles LOD 3;
- selección por arrastre de uno o varios sectores de 32,768×32,768 bloques;
- descarga completa obligatoria de una región antes de abrir su sesión LOD 0;
- regiones dibujadas, tomadas de la vista o introducidas por coordenadas como
  alternativa avanzada;
- una celda de 512×512 bloques por tile LOD 0;
- navegación cardinal con cruceta y flechas del teclado;
- zoom y desplazamiento visuales sin cambiar el LOD de datos;
- zoom acotado a un presupuesto seguro de tiles visibles y cámara contenida en
  la región;
- varias sesiones pausables con progreso persistente y exportable;
- conteo automático al visitar una celda; la celda actual nueva permanece sin
  relleno y muestra su marca al abandonarla o al volver a ella;
- ausencias `404` persistentes y omitidas automáticamente, separadas de las
  celdas revisadas;
- descarga regional reanudable y adaptativa entre `0.25` y `16 req/s`;
- capas `base`, `overlay` y `newchunks`;
- puntos y áreas con nombre, color y notas privadas;
- lectura exclusiva de la biblioteca local;
- tarjeta de capacidad de LuisA, sin iniciar trabajos por sí sola;
- composición opcional de una región como PNG o WebP desde el CLI.

## Inicio rápido en LuisA

Requisitos:

- macOS con `/Volumes/LuisA` montado;
- el sparsebundle existente en
  `/Volumes/LuisA/2b2t_map/2b2t_tiles.sparsebundle` es opcional; el lanzador
  lo monta en `/Volumes/2b2t Tiles` y, si no existe, usa `./2b2t_tiles`;
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
el visor estén disponibles. Montar la biblioteca es parte del arranque; los
modos `--status` y `--stop` no montan ni desmontan volúmenes.

Para abrir directamente una zona por coordenadas X/Z y conservar un zoom
inicial explícito:

```bash
open 'http://localhost:3001/#@-85181,168232,1.0000,0'
```

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
4. El visor comprueba las tres capas. Si falta algo, elige el ritmo y pulsa
   **Descargar región completa**. La exploración permanece bloqueada.
5. Puedes detener el trabajo sin perder datos y usar **Reanudar descarga**
   después. El progreso exacto incluye WebP guardados, `404`, pendientes,
   faltantes y fallos.
6. Cuando la región alcance 100%, pulsa **Explorar región**. La primera celda
   se cuenta como visitada, pero se abre a 512×512 bloques sin relleno mientras
   siga siendo la celda actual.
7. Recorre la región con la cruceta norte/sur/este/oeste, las flechas del
   teclado o un clic. La celda nueva se cuenta al entrar; al salir, la anterior
   muestra su relleno de revisada. Si vuelves a ella conserva su marca. Un
   `404` se omite automáticamente.
8. Acerca, aleja o arrastra el mapa cuando necesites inspeccionar una
   estructura: los datos continúan en LOD 0 y el zoom manual se conserva
   exactamente al moverte a otra celda.
9. **Pausar sesión** la conserva en LuisA; después puedes abrirla desde
   **Workspace durable**. **Guardar ahora** fuerza una escritura inmediata.

La descarga y la revisión siguen siendo conceptos distintos. La primera ocurre
por región y debe terminar antes de entrar; la segunda se registra
automáticamente al visitar una celda, aunque el relleno de la celda actual se
retrase para no tapar el mapa. Una ausencia `404` no se disfraza de revisión:
se guarda en su propio bitset y se excluye del total revisable.

### Recorrido visual

**1. Atlas global.** Muestra los 1,089 sectores del Overworld, el progreso LOD
0 y los límites X/Z exactos de la selección.

![Atlas global del Overworld](./viewer/public/docs/atlas-global-overworld.png)

**2. Exploración regional.** La cabecera conserva coordenadas, zoom, LOD y
bloques por píxel; la tarjeta lateral muestra la celda actual y su rango.

![Celda regional con coordenadas y zoom](./viewer/public/docs/exploracion-celda-coordenadas-zoom.png)

**3. Highlights.** Permite marcar puntos o áreas, encontrarlos por nombre,
ocultarlos y exportarlos o importarlos junto con el workspace.

![Panel de highlights sobre el mapa](./viewer/public/docs/highlights-panel-mapa.png)

### Qué es un tile

Un **tile** es una pieza cuadrada del mapa, como una baldosa. En el máximo
detalle cada archivo WebP mide 512×512 píxeles y representa 512×512 bloques de
Minecraft. Las coordenadas X/Z indican dónde encaja esa pieza; al alejarte, los
LOD superiores resumen áreas cada vez mayores. El visor une automáticamente
las piezas visibles, por eso puedes desplazarte como si fuera una sola imagen
sin cargar el mapa completo en memoria.

No necesitas pausar manualmente para cambiar de zona: al elegir otra región,
la sesión activa se guarda en el workspace y la selección nueva pasa por la
comprobación o descarga obligatoria antes de abrirse.

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
1,048,576 celdas por sesión y avisa antes de iniciar una selección que supere
ese límite.

Las sesiones creadas por versiones anteriores conservan su LOD, escala, celda
actual y progreso al restaurarlas o importarlas. Antes de reabrir una sesión
LOD 0, el visor vuelve a verificar su región completa. Las sesiones con LOD
heredado son de solo lectura; **Crear versión en LOD 0** conserva la original y
lleva la copia nueva al mismo paso obligatorio de descarga.

## Capacidad de LuisA

El lanzador usa estas ubicaciones:

```text
Biblioteca preferida: /Volumes/2b2t Tiles/2b2t_tiles
Fallback automático: ./2b2t_tiles
Respaldo físico: /Volumes/LuisA
```

La tarjeta **Capacidad local · LuisA** consulta en tiempo real el espacio de
ambos volúmenes y toma el menor valor disponible. Si existe `estimate.json`,
usa el `full_plan.required_with_headroom` del último preflight estricto de
Overworld; así muestra el mismo déficit que el descargador. Sin un preflight
válido usa la referencia predeterminada de `1,458,909,433,254` bytes,
aproximadamente `1.327 TiB`. Una variable local explícita conserva prioridad
sobre ambos valores.

Cuando `progress.json` contiene una descarga global válida, la misma tarjeta
muestra su alcance LOD, porcentaje, WebP completos, ausencias, pendientes,
tiles/s, MB/s, datos transferidos y ETA. El runtime proyecta únicamente esas
métricas; no expone la ruta de salida ni el comando de reanudación al
navegador.

El resultado puede ser:

- capacidad verificada;
- margen insuficiente;
- runtime local no configurado.

Es un diagnóstico de almacenamiento. No crea trabajos ni recorre el mapa. La
biblioteca actual, su SQLite y los WebP existentes permanecen en su lugar.

## CLI global reanudable

`download_all_2b2t.py` descubre el árbol publicado, estima cada LOD y solo
descarga el alcance que cabe con un 20% adicional de espacio. El preflight no
supone un cuadrado de 1,024,000 bloques: usa la huella irregular verificada de
66,464 tiles LOD 3 y un máximo conservador de 5,673,192 solicitudes para
Overworld/base completo. En LuisA, la biblioteca vive en el sparsebundle APFS
existente:

```bash
hdiutil attach -nobrowse -owners on \
  '/Volumes/LuisA/2b2t_map/2b2t_tiles.sparsebundle'
```

Esto monta `/Volumes/2b2t Tiles`; no crea ni formatea una imagen.
El lanzador del visor ejecuta ese montaje automáticamente cuando el
sparsebundle existe. El comando manual solo hace falta para operar el
descargador global sin iniciar la UI.

El alcance operativo actual es Overworld/base y se recorre desde los LOD más
alejados y pequeños hacia LOD 0:

```bash
python download_all_2b2t.py \
  --all \
  --dimensions overworld \
  --layers base \
  --lods all \
  --out '/Volumes/2b2t Tiles/2b2t_tiles' \
  --workers 4 \
  --requests-per-second 2 \
  --resume
```

Para recalcular solicitudes, almacenamiento, tiempo y espacio faltante sin
iniciar descargas adicionales cuando la prueba 3×3 ya está registrada:

```bash
python download_all_2b2t.py \
  --estimate-only \
  --dimensions overworld \
  --layers base \
  --lods all \
  --out '/Volumes/2b2t Tiles/2b2t_tiles' \
  --requests-per-second 2 \
  --resume \
  --skip-smoke-test
```

El preflight genera `discovery.json` y `estimate.json`. Cuando falta espacio,
`estimate.json` conserva dos vistas: `plan`, el tramo seguro que sí se ejecuta,
y `full_plan`, el desglose completo **del alcance solicitado** con su déficit.
La ejecución actualiza `progress.json`, `download.log` y `tiles.sqlite3`; el
resumen final contiene el comando exacto para continuar. Los WebP válidos y
los `404` confirmados no se solicitan otra vez. `--revalidate` vuelve a
comprobar los archivos completos antes de reanudar.

Mientras el escritor global está activo se puede generar, sin competir con él,
el informe detallado de las tres capas y los 11 LOD del Overworld:

```bash
python download_all_2b2t.py \
  --cached-estimate-only \
  --dimensions overworld \
  --layers base,overlay,newchunks \
  --lods all \
  --out '/Volumes/2b2t Tiles/2b2t_tiles' \
  --workers 8 \
  --requests-per-second 8
```

Este modo abre SQLite con `mode=ro` y `query_only=ON`, no usa red ni toma el
lock de descarga, y no modifica `progress.json`, `estimate.json` ni
`download.log`. Valida los WebP de las muestras locales y escribe únicamente
un informe bajo `reports/`, con una fila por combinación solicitada, márgenes,
déficit y comandos exactos de continuación. El alcance completo actual de
Overworld conserva el nombre `reports/overworld-estimate.json` y sus 33 filas.
Los demás subconjuntos usan un nombre determinista que incorpora dimensiones,
capas y LOD.

Por ejemplo, el informe offline de las 99 combinaciones publicadas se genera
sin interferir con la descarga activa:

```bash
python download_all_2b2t.py \
  --cached-estimate-only \
  --dimensions overworld,nether,end \
  --layers base,overlay,newchunks \
  --lods all \
  --out '/Volumes/2b2t Tiles/2b2t_tiles' \
  --workers 8 \
  --requests-per-second 8
```

Su salida es
`reports/cached-estimate-overworld-nether-end__base-overlay-newchunks__lod-all.json`.
Incluye 99 filas, totales por dimensión, capa y pareja dimensión/capa, además
de nueve comandos independientes de continuación sujetos a preflight.

El volumen actual permite continuar Overworld/base hasta LOD 1 con todas las
reservas exigidas, pero no admite aún LOD 0. Cuando haya capacidad adicional,
este comando intenta exclusivamente el detalle pendiente y se niega a empezar
si no conserva el 20%:

```bash
python download_all_2b2t.py \
  --all \
  --dimensions overworld \
  --layers base \
  --lods 0 \
  --out '/Volumes/2b2t Tiles/2b2t_tiles' \
  --workers 8 \
  --requests-per-second 8 \
  --resume \
  --skip-smoke-test \
  --no-fallback
```

Después de completar base, se vuelven a estimar en vivo las otras capas de
Overworld sin iniciar otra transferencia:

```bash
python download_all_2b2t.py \
  --estimate-only \
  --dimensions overworld \
  --layers overlay,newchunks \
  --lods all \
  --out '/Volumes/2b2t Tiles/2b2t_tiles' \
  --requests-per-second 8 \
  --resume \
  --skip-smoke-test
```

Si ese preflight cabe, los comandos exactos de continuación son:

```bash
/Library/Frameworks/Python.framework/Versions/3.14/bin/python3 \
  /Users/luisalvarado/Documents/GitHub/2b2t_map/download_all_2b2t.py \
  --all --dimensions overworld --layers overlay \
  --lods 10,9,8,7,6,5,4,3,2,1,0 \
  --out '/Volumes/2b2t Tiles/2b2t_tiles' \
  --workers 8 --requests-per-second 8 \
  --timeout 30 --retries 5 --discovery-samples 25 \
  --max-tile-bytes 16777216 --space-headroom-percent 20 \
  --resume --skip-smoke-test --no-fallback

/Library/Frameworks/Python.framework/Versions/3.14/bin/python3 \
  /Users/luisalvarado/Documents/GitHub/2b2t_map/download_all_2b2t.py \
  --all --dimensions overworld --layers newchunks \
  --lods 10,9,8,7,6,5,4,3,2,1,0 \
  --out '/Volumes/2b2t Tiles/2b2t_tiles' \
  --workers 8 --requests-per-second 8 \
  --timeout 30 --retries 5 --discovery-samples 25 \
  --max-tile-bytes 16777216 --space-headroom-percent 20 \
  --resume --skip-smoke-test --no-fallback
```

No ejecutes esos comandos mientras exista otra descarga activa sobre la misma
biblioteca; el bloqueo compartido los rechazará para proteger SQLite y los
WebP.

También se puede validar toda la biblioteca independientemente del
descargador:

```bash
python verify_download.py \
  --out '/Volumes/2b2t Tiles/2b2t_tiles' \
  --workers 8
```

Sin `--requeue-corrupt`, el verificador abre SQLite mediante URI `mode=ro`,
activa `PRAGMA query_only=ON` y no ejecuta `UPDATE` ni `COMMIT`; únicamente
lee la biblioteca y escribe el informe JSON. Por eso puede auditar una
descarga activa sin alterar su cola.

La reparación es una operación distinta y explícita:

```bash
python verify_download.py \
  --out '/Volumes/2b2t Tiles/2b2t_tiles' \
  --workers 8 \
  --requeue-corrupt
```

Ese modo abre SQLite con escritura y obtiene el mismo bloqueo exclusivo que
los descargadores. Si existe una descarga activa, termina con código 2 antes
de abrir la base; espera a que la descarga finalice o se detenga normalmente
antes de reencolar.

El contrato conserva soporte para `overworld,nether,end` y para
`base,overlay,newchunks`, pero la ejecución y la UI permanecen limitadas a
Overworld por ahora.

## Descargar una región desde la interfaz

La UI ofrece cuatro perfiles:

```text
Cauteloso 0.5 req/s · Normal 2 req/s · Rápido 8 req/s · Turbo 16 req/s
```

La descarga obligatoria incluye `base`, `overlay` y `newchunks` para todos los
tiles LOD 0 de los límites seleccionados. El runtime permite un trabajo
regional a la vez, calcula lo que realmente falta, valida espacio con margen y
publica resolución total, velocidad real de red, RPS logradas, setpoint,
transferencia y ETA del trabajo pendiente. Los perfiles rápidos arrancan a un
ritmo moderado y recuperan gradualmente hasta su objetivo. Un `429` o `403`
reduce el ritmo; `Retry-After` pausa globalmente a todos los workers.
**Detener descarga** termina el streaming activo, guarda el lote SQLite y
permite reanudar sin volver a pedir WebP válidos ni `404` conocidos.

Turbo usa ocho workers y un techo global de 16 solicitudes por segundo. No usa
Tor, proxies rotatorios ni cambios de IP para esquivar protecciones; la
velocidad se obtiene con conexiones persistentes, paralelismo acotado y control
adaptativo.

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
  --workers 8 \
  --requests-per-second 16 \
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
| `--workers 1..8` | transferencias simultáneas para ocultar latencia |
| `--requests-per-second 0.25..16` | techo global; comienza como máximo en 4 y se recupera gradualmente |
| `--max-tiles` | rechazo preventivo de inventarios inesperados |
| `--compose` | mosaico PNG o WebP |
| `--show-coordinates` | cuadrícula y etiquetas en el mosaico |

El directorio de salida posee un bloqueo regional. Los resultados se confirman
en lotes de hasta 32 tiles o un segundo, manteniendo `synchronous=FULL` y
forzando el commit final. `Ctrl+C` corta el streaming, cierra las conexiones y
conserva lo obtenido; repetir el mismo comando reutiliza los tiles válidos.
En una reanudación, un archivo cuyo tamaño y SHA-256 coinciden con el catálogo
validado evita una segunda decodificación WebP; cualquier diferencia se pone
en cuarentena y vuelve a descargarse.

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
heredado `online=1`. Solo el trabajo regional explícito obtiene archivos de la
fuente, y la sesión no se abre hasta resolver toda el área.

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

Si existe `../2b2t_tiles`, el modo de desarrollo la detecta
automáticamente y usa esa misma raíz para el workspace local. Las variables
siguientes solo son necesarias para elegir otra biblioteca o conservar el
workspace en otro volumen.

| Variable | Uso |
| --- | --- |
| `OBSIDIAN_ATLAS_TILE_ROOT` | raíz canónica `2b2t_tiles` |
| `OBSIDIAN_ATLAS_BACKING_ROOT` | volumen físico usado en la comprobación |
| `OBSIDIAN_ATLAS_PYTHON` | intérprete para `download_region_2b2t.py` |
| `OBSIDIAN_ATLAS_OVERWORLD_REQUIREMENT_BYTES` | override explícito del preflight de capacidad |

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
