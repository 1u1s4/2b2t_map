# Obsidian Atlas — visor local

Este directorio contiene la UI web de escritorio de Obsidian Atlas. El producto
divide una región del Overworld en tiles LOD 0 revisables de 512×512 bloques y
conserva el progreso en un workspace durable de LuisA. El zoom y el
desplazamiento son visuales: durante una sesión no cambian el LOD de los datos.
El backend de desarrollo expone capacidad, persistencia, lectura local de tiles
y descarga regional únicamente en `localhost`. La interfaz requiere al menos
960 px de ancho y no incluye una variante móvil.

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
este directorio. Si existe
`/Volumes/LuisA/2b2t_map/2b2t_tiles.sparsebundle`, lo monta de forma segura en
`/Volumes/2b2t Tiles` y usa su biblioteca. El launcher exige ese respaldo:
no desvía silenciosamente tiles a otro disco. `--status` y `--stop` no montan
ni desmontan el volumen. La primera instalación es:

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

Con la biblioteca del repositorio en `../2b2t_tiles`, basta ejecutar:

```bash
cd viewer
npm run dev -- --hostname localhost --port 3001
```

El modo de desarrollo detecta esa carpeta automáticamente, usa
`../2b2t_tiles_regions` para predescargas y mantiene el workspace dentro de una
raíz ignorada por Git. Para usar las bibliotecas APFS de LuisA explícitamente:

```bash
cd viewer
OBSIDIAN_ATLAS_TILE_ROOT='/Volumes/2b2t Tiles/2b2t_tiles' \
OBSIDIAN_ATLAS_REGIONAL_TILE_ROOT='/Volumes/2b2t Tiles/ObsidianAtlasRegions/2b2t_tiles' \
OBSIDIAN_ATLAS_BACKING_ROOT='/Volumes/LuisA' \
OBSIDIAN_ATLAS_PYTHON='/Users/luisalvarado/Documents/GitHub/2b2t_map/.venv/bin/python' \
  npm run dev -- --hostname localhost --port 3001
```

Variables aceptadas:

| Variable | Valor esperado |
| --- | --- |
| `OBSIDIAN_ATLAS_TILE_ROOT` | carpeta canónica `2b2t_tiles` |
| `OBSIDIAN_ATLAS_REGIONAL_TILE_ROOT` | biblioteca persistente de predescargas |
| `OBSIDIAN_ATLAS_BACKING_ROOT` | volumen físico que respalda la biblioteca |
| `OBSIDIAN_ATLAS_PYTHON` | Python con `requests` y `Pillow` |
| `OBSIDIAN_ATLAS_OVERWORLD_REQUIREMENT_BYTES` | referencia opcional de capacidad |

Si `OBSIDIAN_ATLAS_PYTHON` no se define, el runtime intenta
`../.venv/bin/python` y luego `python3`. La referencia predeterminada es
`1,458,909,433,254` bytes. Cuando `estimate.json` contiene un preflight
estricto de Overworld, la tarjeta usa en su lugar
`full_plan.required_with_headroom`; una variable explícita conserva prioridad.

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
7. La sesión cuenta su primera celda como visitada, pero no le aplica relleno
   mientras siga siendo la celda actual. La marca se vuelve visible al salir o
   al regresar a ella.

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

Rueda, pellizco, doble clic, `+`, `-` y arrastre cambian la vista detallada sin
sustituir los tiles LOD 0. **Encuadrar región activa** cierra el panel lateral y
usa temporalmente el panorama LOD 10 para mostrar juntos la región completa, la
ruta inteligente y sus highlights sin cargar miles de tiles. Volver a la celda
activa restaura el detalle LOD 0. Durante **Explorar**, `L` activa una lupa
circular que siempre vuelve a renderizar el detalle original con gran aumento
y sigue el puntero sin interferir con clics ni arrastre. El lente conserva su
aumento 5× incluso en el zoom máximo y se recoloca junto a los bordes para no
quedar recortado.

## Atlas global

El Atlas encaja los 1,089 sectores del Overworld en una sola vista y permanece
disponible durante una sesión activa. Al cerrarlo restaura exactamente la
cámara, escala y celda regionales.

El Atlas presenta una sola cobertura: la descarga local de la capa `base` en
LOD 0. Los estados **Listas**, **En curso** y **Por explorar** funcionan como
filtros. El inspector muestra tiles guardados, objetivo, porcentaje y límites
X/Z. **Anterior**, **Siguiente**, flechas y `Enter` permiten operar sin apuntar
a celdas pequeñas; un clic selecciona el sector y la cruceta de escritorio
permite ajustar el sector enfocado antes de elegirlo.

La huella publicada permanece como detalle interno del cálculo, no como una
vista seleccionable. Cada `404` confirmado se excluye del denominador para que
los bordes irregulares puedan alcanzar 100% sin crear pendientes imposibles.

La cobertura local se precarga para que **Explorar** no muestre ceros
provisionales. Se vuelve a leer al cambiar el estado de un trabajo regional y,
como respaldo, una vez por minuto; el progreso detallado del trabajo sí se
actualiza cada 2.5 segundos.

## Navegación y progreso

La cruceta visible y las flechas del teclado mueven exactamente una celda:

- oeste/este cambian de columna;
- norte/sur cambian de fila;
- los controles se desactivan en los bordes.

La tarjeta muestra porcentaje, revisadas, total revisable, celdas sin datos,
fila, columna y límites X/Z de la celda actual. La cruceta sigue disponible
aunque el usuario acerque o desplace visualmente el mapa; al cambiar de celda,
la cámara la recentra conservando exactamente el zoom manual y sin modificar
su LOD de datos.

Al cambiar mediante inicio, cruceta, teclado, clic o búsqueda, la celda nueva
se cuenta automáticamente al entrar. Mientras sea una visita nueva y continúe
siendo la actual no recibe relleno; la celda abandonada muestra su marca, y
volver a una ya revisada conserva esa marca sin incrementar el contador.
Si `base` fue confirmado como `404` durante la descarga completa, queda en un
bitset **Sin datos**, se excluye del denominador y nunca se cuenta como
revisada.

**Exportar** genera `obsidian-atlas-exploracion.json`. El archivo incluye dos
bitsets base64url —revisadas y sin datos—, no listas extensas de coordenadas.
**Importar** valida versión, dimensión, límites alineados, escala, LOD, índice y
contadores.
Al iniciar otra región, la sesión única actual permanece en LuisA y la nueva
selección pasa primero por el gate de descarga. Solo una región completamente
resuelta puede reemplazarla. **Pausar sesión** sigue disponible para cerrar el
recorrido sin iniciar otro. También se puede elegir directamente cualquier
celda visible con un clic.

Las sesiones creadas por versiones anteriores conservan su LOD, escala, celda
actual y progreso al importarlas, pero una sesión LOD 0 no puede
saltarse la verificación regional. Un LOD heredado queda en solo lectura;
**Crear versión en LOD 0** lleva la copia al gate y la vuelve canónica solo al
completar la descarga.

El máximo por sesión es 1,048,576 celdas. Durante una sesión, la escala
mínima limita el viewport a 8×6 tiles antes del margen de render y la cámara se
mantiene dentro de la región más una celda de contexto. El Atlas calcula el
tamaño LOD 0 antes de iniciar y pide reducir una selección que supere el máximo.

## Descarga regional obligatoria

La tarjeta previa a la exploración ofrece cinco perfiles y selecciona
**Máximo** por defecto:

```text
Mínimo 0.25 req/s · Suave 0.5 req/s · Normal 2 req/s · Rápido 8 req/s · Máximo 16 req/s
```

**Descargar región completa** envía al runtime:

- límites exactos de toda la región;
- Overworld;
- LOD 0 para toda sesión nueva;
- las tres capas `base`, `overlay` y `newchunks`;
- techo de ritmo elegido, con arranque gradual y reducción automática;
- workers derivados del perfil: 2, 4 u 8;
- cooldown global para `Retry-After`, visible junto con RPS logradas, setpoint,
  tiles de red por segundo, MiB/s y ETA de red.

El runtime ejecuta `../download_region_2b2t.py` sobre la biblioteca regional
separada, permite un trabajo a la vez, limita la región a 1,048,576 celdas
espaciales y realiza un preflight de lo que realmente falta con 20% de margen.
Los WebP válidos y los `404` persistidos se reutilizan; el ejecutor mantiene una
cola acotada aunque la región sea grande. No existe un trabajo global: los
16 req/s completos quedan disponibles para la región elegida.

**Detener descarga** solicita una interrupción segura. **Reanudar descarga**
continúa el mismo inventario. La navegación permanece bloqueada hasta que
`complete + absent = total` y no existan pendientes, faltantes ni fallos.
Mientras el trabajo corre, la UI usa su stream ligero de progreso; la
verificación completa de tamaño y SHA-256 se ejecuta al entrar al gate y al
cambiar el trabajo a un estado terminal, evitando releer toda la región cada
pocos segundos.

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
  --out '/Volumes/2b2t Tiles/ObsidianAtlasRegions/2b2t_tiles' \
  --workers 1 \
  --requests-per-second 1 \
  --max-tiles 2
```

Consulta `python ../download_region_2b2t.py --help` para regiones por centro,
composición de imágenes y cuadrículas de coordenadas.

## Capacidad

`GET /api/local-atlas/status` devuelve una instantánea sin caché de:

- espacio del APFS regional;
- espacio disponible en LuisA;
- bytes regionales registrados;
- margen disponible para nuevas regiones;
- trabajo regional actual.

Por compatibilidad, `globalDownload` permanece en el contrato con valor `null`.
Reportes históricos como `progress.json` no crean metas, no aparecen en la UI y
no reducen el presupuesto regional.

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

1. predescargas de `OBSIDIAN_ATLAS_REGIONAL_TILE_ROOT`;
2. panorama Overworld LOD 10 de `OBSIDIAN_ATLAS_TILE_ROOT`;
3. carpeta elegida manualmente en Chrome;

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

El fallback a un ancestro LOD se reserva para `base`, que es espacialmente
continua. En las capas dispersas `overlay` y `newchunks`, un `404` significa
transparencia; el visor no amplía un píxel del panorama LOD 10 sobre una celda
LOD 0.

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
`obsidian-atlas-highlights.json`. LuisA mantiene una sola sesión canónica y
hasta 10,000 highlights. `localStorage` solo contiene una WAL temporal fija,
sin ramas por pestaña; si queda obsoleta, se descarta y prevalece el documento
de LuisA. Los workspaces multisesión antiguos se consolidan una vez y se
archivan completos en `ObsidianAtlas/backups/` antes de podarlos.

**Ruta inteligente** conecta todos los highlights de la región mediante un TSP
euclidiano abierto. El inicio puede dejarse en automático —el punto más cercano
a `minX/minZ`, la esquina superior izquierda— o fijarse en cualquier highlight.
Hasta 14 puntos se resuelven exactamente con Held–Karp; conjuntos mayores usan
vecino más cercano y mejora 2-opt acotada. El cálculo corre en un worker
cancelable para mantener el mapa interactivo; el buscador del punto inicial
limita las opciones montadas sin impedir elegir cualquiera. El canvas muestra líneas y puntos
`A…Z`, luego `a…z` y, al agotarlos, `A1…z1`, `A2…`; el panel descarga el orden
completo como
`obsidian-atlas-ruta-highlights.json` o la vista visible como
`obsidian-atlas-ruta-vista.png`. **Renombrar y exportar a Xaero** guarda los
puntos como `A · Nombre`, `B · Nombre`… en el orden calculado, prepara el
alcance de la región activa y abre la vista previa segura antes de escribir en
Minecraft. Las áreas no se renombran porque Xaero no las exporta.

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
| Activar o desactivar la lupa en Explorar | `L` |
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
- ritmo adaptativo `0.25..16 req/s`;
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
