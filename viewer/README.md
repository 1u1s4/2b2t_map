# Obsidian Atlas — visor local

Este directorio contiene la UI local de Obsidian Atlas. El producto divide una
región del Overworld en tiles revisables, fija el zoom de la sesión y conserva
el progreso en el navegador. El backend de desarrollo expone capacidad,
lectura de tiles y descarga regional únicamente en `localhost`.

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

El lanzador requiere `/Volumes/LuisA`,
`/Volumes/2b2t Tiles/2b2t_tiles`, `screen`, Python y las dependencias de este
directorio. La primera instalación es:

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

1. Navega hasta el área de interés.
2. Ajusta el zoom deseado.
3. Abre **Explorar** con el dock o la tecla `E`.
4. Dibuja una región, toma la vista actual o introduce cuatro coordenadas.
5. Pulsa **Crear sesión de exploración**.

La región usa límites semiabiertos:

```text
X [minX, maxX) × Z [minZ, maxZ)
```

El modelo expande esos límites a tiles enteros. Una celda mide:

```text
512 * 2**LOD bloques por lado
```

El zoom y el LOD quedan fijados durante la sesión. Los controles de rueda,
doble clic, `+` y `-` no alteran la escala hasta cerrar la sesión.

## Navegación y progreso

La cruceta visible y las flechas del teclado mueven exactamente una celda:

- izquierda/derecha cambian de columna;
- arriba/abajo cambian de fila;
- los controles se desactivan en los bordes.

**Anterior** y **Revisada y siguiente** usan una ruta serpentina. La tarjeta
muestra porcentaje, revisadas, total, posición de la ruta, fila, columna, LOD
y límites X/Z de la celda actual.

**Marcar como revisada** es reversible. La presencia de un WebP no cambia el
progreso humano.

El estado se guarda con la clave:

```text
obsidian-atlas-exploration-v1
```

**Exportar** genera `obsidian-atlas-exploracion.json`. El archivo incluye un
bitset base64url, no una lista extensa de coordenadas. **Importar** valida
versión, dimensión, límites alineados, escala, LOD, índice y contador. Cerrar
una sesión elimina su estado del navegador, por lo que debe exportarse si se
quiere archivar.

El máximo por sesión es 4,000,000 de celdas. El canvas solo recorre las celdas
visibles para evitar que una región grande bloquee la interfaz.

## Datos bajo demanda

La tarjeta de la celda ofrece:

```text
0.25 req/s · 0.5 req/s · 1 req/s · 2 req/s
```

**Descargar celda actual** envía al runtime:

- límites exactos de esa celda;
- Overworld;
- LOD fijado;
- capas visibles;
- ritmo elegido.

El runtime ejecuta `../download_region_2b2t.py`, permite un trabajo a la vez,
limita cada operación a 64 combinaciones tile/capa y realiza un preflight
conservador de espacio. Los WebP válidos existentes se reutilizan.

**Detener celda** solicita una interrupción segura. La navegación nunca inicia
un trabajo automáticamente.

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

El espacio efectivo es el menor entre la biblioteca montada y su volumen de
respaldo. La comparación no acredita los datos existentes contra la referencia,
por lo que mantiene un margen conservador. Esta lectura es informativa y no
crea operaciones.

## Fuentes de tiles

El orden de lectura es:

1. biblioteca configurada por `OBSIDIAN_ATLAS_TILE_ROOT`;
2. carpeta elegida manualmente en Chrome;
3. vista rápida online, solo si el usuario la activa.

La estructura esperada es:

```text
2b2t_tiles/
├── base/{lod}/overworld/{shard_x}/{shard_z}/t.{tile_x}.{tile_z}.webp
├── overlay/{lod}/overworld/{shard_x}/{shard_z}/t.{tile_x}.{tile_z}.webp
└── newchunks/{lod}/overworld/{shard_x}/{shard_z}/t.{tile_x}.{tile_z}.webp
```

El endpoint `/api/tile` sirve primero un WebP local válido. Solo permite
consultar 2b2t.place si la solicitud lleva la opción online explícita. Esa vista
es temporal, no escribe en la biblioteca y no usa el selector regional de
ritmo. Crear o importar una sesión la desactiva.

Chrome puede abrir `2b2t_tiles` mediante File System Access con permiso de solo
lectura. El navegador calcula la ruta visible; no escanea ni sube la carpeta.

## Capas, coordenadas y highlights

El panel **Capas** controla visibilidad y opacidad de:

- Mundo (`base`);
- Obsidiana (`overlay`);
- Chunks nuevos (`newchunks`);
- cuadrícula adaptativa de coordenadas.

La cabecera muestra centro X/Z, zoom, LOD y bloques por píxel. El pie muestra
las coordenadas del cursor. La búsqueda acepta `X, Z`, `X Z`, `X, Z, zoom` o el
nombre exacto de un highlight.

Los highlights disponibles son:

- punto: `M` y clic;
- área: `R` y arrastre.

Nombre, nota, color y visibilidad permanecen en
`obsidian-atlas-highlights-v1`. Su JSON de respaldo es
`obsidian-atlas-highlights.json`. Las sesiones de rejilla y los highlights se
persisten por separado.

## Atajos

| Acción | Entrada |
| --- | --- |
| Mover libremente antes de una sesión | arrastrar o flechas |
| Cambiar zoom antes de una sesión | rueda, pellizco, doble clic, `+`, `-` |
| Saltar entre celdas | flechas |
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
| `POST` | `/api/local-atlas/download` | iniciar una celda validada |
| `POST` | `/api/local-atlas/stop` | detener el trabajo activo |
| `GET`/`HEAD` | `/api/tile` | servir un tile local o la vista opcional |

Protecciones:

- solo loopback y origen local coincidente;
- token efímero para mutaciones;
- cuerpo JSON de tamaño acotado;
- coordenadas enteras dentro del borde del mundo;
- Overworld y LOD `0..10`;
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
serpentina, bitset, serialización, validación del bridge local, proxy de tiles
y HTML renderizado.

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

- `exploration-grid.ts`: región, celdas, navegación, bitset y JSON seguro.
- `local-atlas-runtime.ts`: cliente tipado del bridge.
- `local-tile-source.ts`: acceso de solo lectura elegido en Chrome.
- `local-atlas-vite-plugin.ts`: capacidad, tiles y trabajos regionales.
- `map-viewer.tsx`: canvas, sesión, capas y highlights.

Límites actuales:

- solo Overworld;
- tiles WebP de 512 × 512 y LOD 0–10;
- la vista online depende de la red y de 2b2t.place;
- la carpeta manual necesita Chrome o Chromium;
- las preferencias del navegador deben exportarse antes de limpiar el perfil.
