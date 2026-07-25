# Obsidian Atlas — visor local

Este directorio contiene la UI local de Obsidian Atlas. El producto divide una
región del Overworld en tiles LOD 0 revisables de 512×512 bloques y conserva el
progreso en un workspace durable de LuisA. El zoom y el desplazamiento son
visuales: durante una sesión no cambian el LOD de los datos. El backend de
desarrollo expone capacidad, persistencia, lectura local de tiles y descarga
regional únicamente en `localhost`.

## Ejecutar

La forma recomendada, desde la raíz del repositorio, es:

```bash
./start_local_atlas_luisa.sh
```

Después abre [http://localhost:3001](http://localhost:3001).

```bash
./start_local_atlas_luisa.sh --status
./start_local_atlas_luisa.sh --stop
```

El lanzador requiere `/Volumes/LuisA`, `screen`, Python y las dependencias de
este directorio. Prefiere `/Volumes/2b2t Tiles/2b2t_tiles`, pero si ese volumen
no está montado usa automáticamente `../2b2t_tiles`. La primera instalación es:

```bash
cd viewer
npm ci
```

Para otro puerto:

```bash
OBSIDIAN_ATLAS_VIEWER_PORT=3100 ./start_local_atlas_luisa.sh
```

## Ejecución manual

Node.js debe ser `>=22.13.0`.

```bash
cd viewer
OBSIDIAN_ATLAS_TILE_ROOT='/Volumes/2b2t Tiles/2b2t_tiles' \
OBSIDIAN_ATLAS_BACKING_ROOT='/Volumes/LuisA' \
OBSIDIAN_ATLAS_PYTHON='/Users/luisalvarado/Documents/GitHub/2b2t_map/.venv/bin/python' \
  npm run dev -- --hostname localhost --port 3001
```

Variables aceptadas:

| Variable | Valor esperado |
| --- | --- |
| `OBSIDIAN_ATLAS_TILE_ROOT` | carpeta canónica `2b2t_tiles` |
| `OBSIDIAN_ATLAS_BACKING_ROOT` | volumen físico que respalda la biblioteca |
| `OBSIDIAN_ATLAS_PYTHON` | Python con `requests` y `Pillow` |
| `OBSIDIAN_ATLAS_OVERWORLD_REQUIREMENT_BYTES` | referencia opcional de capacidad |

Si `OBSIDIAN_ATLAS_PYTHON` no se define, el runtime intenta
`../.venv/bin/python` y luego `python3`. La referencia predeterminada es
`1,458,909,433,254` bytes.

No uses un hostname público. El launcher canónico y los ejemplos limitan el
servidor a `localhost`.

## Crear una sesión

1. Abre **Atlas** con el dock o `0` / `Home`.
2. Consulta el progreso único de descarga local LOD 0 y, si lo necesitas,
   filtra sectores **Listos**, **En curso** o **Por explorar**.
3. Haz clic en un sector o arrastra uno o más sectores de la rejilla 33×33.
4. Revisa los límites X/Z y el número de filas y columnas LOD 0.
5. El visor comprueba `base`, `overlay` y `newchunks` para toda la selección.
   Si falta algo, elige el ritmo y pulsa **Descargar región completa**.
6. Espera a que el estado exacto llegue a 100%, o detén y reanuda el trabajo
   más tarde. Solo entonces se habilita **Explorar región**.
7. La sesión abre su primera celda y la marca como revisada automáticamente.

Desde **Explorar** también puedes usar **Elegir región en el Atlas**. Dibujar
una región, usar la vista o introducir coordenadas permanece disponible como
alternativa avanzada; **Iniciar en LOD 0** aplica la misma regla.

La región usa límites semiabiertos:

```text
X [minX, maxX) × Z [minZ, maxZ)
```

El modelo expande esos límites a tiles enteros. Toda región nueva usa:

```text
LOD de datos = 0
celda = 512 × 512 bloques
```

Rueda, pellizco, doble clic, `+`, `-` y arrastre cambian la vista sin sustituir
los tiles LOD 0 por otra resolución.

## Atlas global

El Atlas encaja los 1,089 sectores del Overworld en una sola vista y permanece
disponible durante una sesión activa. Al cerrarlo restaura exactamente la
cámara, escala y celda regionales.

El Atlas presenta una sola cobertura: la descarga local de la capa `base` en
LOD 0. Los estados **Listas**, **En curso** y **Por explorar** funcionan como
filtros. El inspector muestra tiles guardados, objetivo, porcentaje y límites
X/Z. **Anterior**, **Siguiente**, flechas y `Enter` permiten operar sin apuntar
a celdas pequeñas; un toque o clic selecciona el sector. En móvil, una cruceta
de 44 px permite ajustar el sector enfocado antes de elegirlo.

La huella publicada permanece como detalle interno del cálculo, no como una
vista seleccionable. Cada `404` confirmado se excluye del denominador para que
los bordes irregulares puedan alcanzar 100% sin crear pendientes imposibles.

La cobertura local se precarga para que **Explorar** no muestre ceros
provisionales. Mientras existe un trabajo regional activo, el endpoint se
actualiza cada 2.5 segundos.

## Navegación y progreso

La cruceta visible y las flechas del teclado mueven exactamente una celda:

- oeste/este cambian de columna;
- norte/sur cambian de fila;
- los controles se desactivan en los bordes.

La tarjeta muestra porcentaje, revisadas, total revisable, celdas sin datos,
fila, columna y límites X/Z de la celda actual. La cruceta sigue disponible
aunque el usuario acerque o desplace visualmente el mapa; al cambiar de celda,
la cámara vuelve a encajarla sin modificar su LOD de datos.

Entrar a una celda mediante inicio, cruceta, teclado, clic o búsqueda la marca
automáticamente como revisada. Volver a visitarla no incrementa el contador.
Si `base` fue confirmado como `404` durante la descarga completa, queda en un
bitset **Sin datos**, se excluye del denominador y nunca se cuenta como
revisada.

**Exportar** genera `obsidian-atlas-exploracion.json`. El archivo incluye dos
bitsets base64url —revisadas y sin datos—, no listas extensas de coordenadas.
**Importar** valida versión, dimensión, límites alineados, escala, LOD, índice y
contadores.
Al iniciar otra región, la sesión activa se guarda automáticamente y la nueva
selección pasa primero por el gate de descarga. **Pausar sesión** sigue
disponible para cerrar el recorrido sin iniciar otro. También se puede elegir
directamente cualquier celda visible con un clic.

Las sesiones creadas por versiones anteriores conservan su LOD, escala, celda
actual y progreso al restaurarlas o importarlas, pero una sesión LOD 0 no puede
saltarse la verificación regional. Un LOD heredado queda en solo lectura;
**Crear versión en LOD 0** archiva la original intacta y lleva la copia al gate
de descarga.

El máximo por sesión es 1,048,576 celdas. Durante una sesión, la escala
mínima limita el viewport a 8×6 tiles antes del margen de render y la cámara se
mantiene dentro de la región más una celda de contexto. El Atlas calcula el
tamaño LOD 0 antes de iniciar y pide reducir una selección que supere el máximo.

## Descarga regional obligatoria

La tarjeta previa a la exploración ofrece:

```text
0.25 req/s · 0.5 req/s · 1 req/s · 2 req/s
```

**Descargar región completa** envía al runtime:

- límites exactos de toda la región;
- Overworld;
- LOD 0 para toda sesión nueva;
- las tres capas `base`, `overlay` y `newchunks`;
- ritmo elegido.

El runtime ejecuta `../download_region_2b2t.py`, permite un trabajo a la vez,
limita la región a 1,048,576 celdas espaciales y realiza un preflight de lo que
realmente falta con 20% de margen. Los WebP válidos y los `404` persistidos se
reutilizan; el ejecutor mantiene una cola acotada aunque la región sea grande.

**Detener descarga** solicita una interrupción segura. **Reanudar descarga**
continúa el mismo inventario. La navegación permanece bloqueada hasta que
`complete + absent = total` y no existan pendientes, faltantes ni fallos.

Desde terminal puede reproducirse el mismo flujo:

```bash
python ../download_region_2b2t.py \
  --x-min -85504 \
  --z-min 167936 \
  --x-max -84992 \
  --z-max 168448 \
  --dimension overworld \
  --lod 0 \
  --layers base,overlay \
  --out '/Volumes/2b2t Tiles/2b2t_tiles' \
  --workers 1 \
  --requests-per-second 1 \
  --max-tiles 2
```

Consulta `python ../download_region_2b2t.py --help` para regiones por centro,
composición de imágenes y cuadrículas de coordenadas.

## Capacidad

`GET /api/local-atlas/status` devuelve una instantánea sin caché de:

- espacio del APFS de tiles;
- espacio disponible en LuisA;
- bytes registrados en la biblioteca;
- referencia del Overworld;
- margen y resultado de la comparación;
- trabajo regional actual.

`GET /api/local-atlas/coverage?layer=base&lod=0..3` consulta SQLite en modo
solo lectura. La consulta se limita a las bandas publicadas: tiles ajenos a la
huella no pueden completar un sector irregular. Los estados pendientes se
separan de fallos, corrupción o protección.

`GET /api/local-atlas/region-status?...` comprueba los límites LOD 0 y las
capas solicitadas contra SQLite y los WebP. Devuelve conteos completos,
ausentes, pendientes, fallidos y faltantes, porcentaje, readiness y las celdas
`base` confirmadas como `404`. Este estado durable sobrevive reinicios.

`GET /api/local-atlas/workspace` y `PUT /api/local-atlas/workspace` leen y
guardan el workspace fijo de LuisA. `PUT` exige token local, `If-Match` y un
write-id idempotente. El store valida el documento completo, limita tamaño y
cantidad, escribe de forma atómica y mantiene un backup recuperable:

```text
/Volumes/LuisA/ObsidianAtlas/state/atlas-workspace.v1.json
```

El espacio efectivo es el menor entre la biblioteca montada y su volumen de
respaldo. La comparación no acredita los datos existentes contra la referencia,
por lo que mantiene un margen conservador. Esta lectura es informativa y no
crea operaciones.

## Biblioteca de tiles

El orden de lectura es:

1. biblioteca configurada por `OBSIDIAN_ATLAS_TILE_ROOT`;
2. carpeta elegida manualmente en Chrome;

La estructura esperada es:

```text
2b2t_tiles/
├── base/{lod}/overworld/{shard_x}/{shard_z}/t.{tile_x}.{tile_z}.webp
├── overlay/{lod}/overworld/{shard_x}/{shard_z}/t.{tile_x}.{tile_z}.webp
└── newchunks/{lod}/overworld/{shard_x}/{shard_z}/t.{tile_x}.{tile_z}.webp
```

El endpoint `/api/tile` sirve únicamente un WebP local válido. No tiene modo
remoto: incluso el parámetro heredado `online=1` se ignora y una ausencia local
responde `404` sin contactar la red. Solo la descarga regional explícita
contacta la fuente y escribe el resultado antes de habilitar la sesión.

Chrome puede abrir `2b2t_tiles` mediante File System Access con permiso de solo
lectura. El navegador calcula la ruta visible; no escanea ni sube la carpeta.

## Capas, coordenadas y highlights

El panel **Capas** controla visibilidad y opacidad de:

- Mundo (`base`);
- Obsidiana (`overlay`);
- Chunks nuevos (`newchunks`);
- cuadrícula adaptativa de coordenadas.

La cabecera muestra centro X/Z, zoom, LOD y resolución fuente en bloques por
píxel. El pie muestra
las coordenadas del cursor. La búsqueda acepta `X, Z`, `X Z`, `X, Z, zoom` o el
nombre exacto de un highlight.

Los highlights disponibles son:

- punto: `M` y clic;
- área: `R` y arrastre.

Nombre, nota, color y visibilidad permanecen en
el workspace de LuisA. Su JSON de respaldo manual es
`obsidian-atlas-highlights.json`. `localStorage` conserva una copia de
recuperación completa por pestaña y migra automáticamente cuando su revisión
base coincide. Un conflicto nunca sobrescribe LuisA: conserva la rama local
hasta que el usuario elige explícitamente qué versión usar. El workspace admite
128 sesiones y 10,000 highlights; las sesiones pausadas se pueden eliminar
desde su tarjeta.

## Atajos

| Acción | Entrada |
| --- | --- |
| Mover visualmente el mapa | arrastrar |
| Cambiar zoom visual | rueda, pellizco, doble clic, `+`, `-` |
| Abrir o volver a encajar el Atlas | `0` o `Home` |
| Mover una celda al norte/sur/este/oeste | flechas |
| Abrir exploración | `E` |
| Ir a coordenadas/highlight | `G` |
| Abrir highlights | `H` |
| Marcar un punto | `M` |
| Dibujar un área | `R` |
| Cancelar herramienta o cerrar panel | `Esc` |

Los atajos quedan suspendidos mientras se escribe en un campo.

## Runtime local

Rutas:

| Método | Ruta | Función |
| --- | --- | --- |
| `GET` | `/api/local-atlas/status` | capacidad y trabajo actual |
| `GET` | `/api/local-atlas/coverage?layer=base&lod=0..3` | cobertura exacta del terreno local |
| `GET` | `/api/local-atlas/region-status?...` | verificar una región y su readiness durable |
| `POST` | `/api/local-atlas/download` | iniciar o reanudar una región validada |
| `POST` | `/api/local-atlas/stop` | detener el trabajo activo |
| `GET`/`HEAD` | `/api/tile` | servir exclusivamente un tile local |

Protecciones:

- solo loopback y origen local coincidente;
- token efímero para mutaciones;
- cuerpo JSON de tamaño acotado;
- coordenadas enteras dentro del borde del mundo;
- descarga regional únicamente en Overworld LOD 0;
- capas permitidas por lista cerrada;
- límites alineados a tiles;
- ritmo `0.25..2 req/s`;
- rutas e intérprete definidos por el proceso, nunca por el navegador;
- un solo trabajo regional activo.

## Pruebas

```bash
cd viewer
npm run lint
npm test
```

Las pruebas cubren matemática de rejilla, negativos, rangos semiabiertos,
navegación cardinal, bitsets de revisión/sin datos, serialización, presupuesto
de viewport, validación del bridge local, endpoint local de tiles y HTML
renderizado.

## Archivos principales

```text
viewer/
├── app/
│   ├── lib/exploration-grid.ts
│   ├── lib/local-atlas-runtime.ts
│   ├── lib/local-tile-source.ts
│   ├── map-viewer.tsx
│   └── globals.css
├── build/local-atlas-vite-plugin.ts
├── tests/
├── package.json
└── vite.config.ts
```

- `exploration-grid.ts`: región, celdas, navegación, bitsets y JSON seguro.
- `local-atlas-runtime.ts`: cliente tipado del bridge.
- `local-tile-source.ts`: acceso de solo lectura elegido en Chrome.
- `local-atlas-vite-plugin.ts`: capacidad, tiles y trabajos regionales.
- `map-viewer.tsx`: canvas, sesión, capas y highlights.

Límites actuales:

- solo Overworld;
- tiles WebP de 512 × 512 y LOD 0–10;
- las sesiones nuevas de la UI usan únicamente LOD 0;
- la carpeta manual necesita Chrome o Chromium;
- las preferencias del navegador deben exportarse antes de limpiar el perfil.
