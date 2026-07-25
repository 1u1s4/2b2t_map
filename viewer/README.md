# Obsidian Atlas

Obsidian Atlas es el visor web del archivo local de 2b2t. Está inspirado en la
experiencia de navegación de 2b2t.place, con una interfaz propia enfocada en
coordenadas legibles, capas controlables y highlights privados.

El visor dibuja los tiles en un canvas y puede combinar dos fuentes:

1. la carpeta local `2b2t_tiles`, que siempre tiene prioridad;
2. un respaldo online opcional para tiles que todavía no existen en el
   archivo local.

La versión actual admite únicamente el **Overworld**.

## Requisitos y ejecución

- Node.js `>=22.13.0`
- Google Chrome actualizado para abrir una carpeta local
- la carpeta `2b2t_tiles` generada por los scripts Python, si se desea uso
  local

Desde la raíz del repositorio:

```bash
cd viewer
npm ci
npm run dev
```

Abre en Chrome la URL local que imprima el comando. La aplicación necesita un
contexto seguro para el selector de carpetas; `localhost` cuenta como seguro.
Para vincular automáticamente la tarjeta de progreso a la descarga activa:

```bash
OBSIDIAN_ATLAS_PROGRESS_FILE='/Volumes/2b2t Tiles/2b2t_tiles/progress.json' \
  npm run dev
```

Este bridge se habilita únicamente durante desarrollo, sirve un solo
`progress.json` con caché desactivada y no expone el resto del archivo. Sin la
variable, y en el sitio publicado, la ruta responde sin contenido y se mantiene
el flujo normal de permiso explícito de Chrome.

Comandos de comprobación:

```bash
npm run lint
npm run build
npm test
```

`npm run dev` y `npm run build` usan vinext. La configuración incluida simula
localmente los bindings opcionales declarados para Sites; el visor del mapa no
necesita D1 para guardar highlights.

## Abrir el archivo local

1. Abre el panel **Archivo** en el dock izquierdo.
2. Pulsa **Elegir carpeta local**.
3. En el selector de Chrome, elige `2b2t_tiles` directamente, no su carpeta
   padre.
4. Chrome mostrará el permiso de lectura correspondiente.

La raíz seleccionada debe conservar este formato:

```text
2b2t_tiles/
├── base/
│   └── {lod}/overworld/{shard_x}/{shard_z}/t.{tile_x}.{tile_z}.webp
├── overlay/
│   └── {lod}/overworld/{shard_x}/{shard_z}/t.{tile_x}.{tile_z}.webp
└── newchunks/
    └── {lod}/overworld/{shard_x}/{shard_z}/t.{tile_x}.{tile_z}.webp
```

Los shards usan truncamiento hacia cero, igual que 2b2t.place. Obsidian Atlas
calcula la ruta exacta de cada tile visible y no escanea el archivo completo.
Si se desconecta el archivo o se recarga la página, Chrome puede pedir que se
vuelva a seleccionar o autorizar la carpeta.

La File System Access API usada para esto está disponible principalmente en
Chrome y otros navegadores Chromium. Firefox y Safari pueden usar los tiles
online, pero no el selector local compatible.

### Progreso de la descarga

Al conectar `2b2t_tiles`, el panel **Archivo** busca `progress.json` en esa
misma carpeta y vuelve a leerlo cada cinco segundos. La tarjeta de progreso
muestra estado, porcentaje, solicitudes resueltas, tiles completos y
pendientes, velocidad, datos descargados, ETA, última actualización y errores
reportados. La lectura es independiente del canvas: un archivo ausente,
incompleto o temporalmente ilegible no bloquea la navegación del mapa.

Las versiones nuevas del descargador publican `planned_requests`,
`processed_requests` y `progress_percent`. Si se abre un archivo creado por una
versión anterior, el visor deriva un porcentaje aproximado a partir de los
contadores disponibles y lo marca como estimado. El archivo se solicita de
nuevo en cada sondeo porque el descargador lo reemplaza atómicamente.

## Fuente local y respaldo online

Con un archivo conectado, el orden es:

1. intentar el WebP local;
2. si falta y **Respaldo online** está activado, solicitarlo mediante
   `/api/tile`;
3. si no existe o falla, mostrar el mejor tile padre disponible mientras sea
   posible.

El panel **Archivo** muestra contadores de tiles locales, online y ausentes.
Los bitmaps se mantienen en una caché acotada y se liberan al salir. Las URLs
temporales de archivos locales también se revocan después de decodificarlas.

Sin una carpeta conectada, el mapa funciona con la fuente online. Para una
sesión estrictamente local:

1. conecta `2b2t_tiles`;
2. desactiva **Respaldo online**;
3. recuerda que las zonas no descargadas aparecerán vacías o con un LOD padre
   más grueso.

El respaldo online no modifica el archivo local: solo permite visualizar el
tile durante la sesión. La descarga persistente y reanudable sigue siendo
responsabilidad de `download_all_2b2t.py` o `download_region_2b2t.py`.

## Navegación, coordenadas, zoom y LOD

La tarjeta superior muestra:

- coordenadas X/Z del centro;
- zoom actual;
- LOD seleccionado;
- bloques por píxel.

El estado inferior muestra las coordenadas del cursor. La retícula permanece
en el centro y la cuadrícula adapta automáticamente su paso al zoom. En el
panel **Capas** se puede activar la cuadrícula y controlar visibilidad y
opacidad de:

- **Mundo** (`base`);
- **Obsidiana** (`overlay`);
- **Chunks nuevos** (`newchunks`).

El LOD se elige automáticamente con:

```text
LOD = clamp(floor(log2(1 / zoom)), 0, 10)
bloques_por_píxel = 2**LOD
```

LOD 0 es la máxima resolución publicada: 1 bloque por píxel. Alejarse aumenta
el LOD y permite cubrir un área mayor con menos tiles. El zoom visual está
limitado entre `1/1500×` y `8×`.

La búsqueda acepta:

```text
-85181, 168232
-85181 168232
-85181, 168232, 2.9423
Nombre exacto de un highlight
```

El botón de copiar coordenadas coloca `X, Z` en el portapapeles. El botón de
enlace copia la URL actual, cuyo fragmento conserva centro, zoom y dimensión:

```text
#@-85181,168232,2.9423,0
```

## Highlights

Hay dos tipos:

- **Punto**: activa `M` y haz clic en el mapa.
- **Área**: activa `R` y arrastra el rectángulo.

Cada highlight puede tener nombre, nota, color y visibilidad. Seleccionarlo en
el mapa o en la lista centra la vista y abre su editor. También puede
eliminarse desde ese panel.

Los highlights se guardan en el `localStorage` del origen actual con la clave
`obsidian-atlas-highlights-v1`; no se guardan en SQLite ni dentro de
`2b2t_tiles`.

**Exportar** descarga:

```text
obsidian-atlas-highlights.json
```

**Importar** valida que el JSON sea una lista de highlights seguros, rechaza el
archivo completo si contiene entradas inválidas y reemplaza la lista local
actual. Por eso conviene exportar una copia antes de importar, limpiar el
navegador o cambiar de perfil.

Los enlaces compartibles solo contienen centro y zoom. Los highlights no se
incluyen en la URL y deben compartirse mediante el JSON exportado.

## Atajos

| Acción | Ratón, gesto o tecla |
| --- | --- |
| Mover el mapa | arrastrar, flechas o gesto táctil |
| Acercar/alejar | rueda, pellizco, doble clic, `+` o `-` |
| Enfocar búsqueda | `G` |
| Abrir highlights | `H` |
| Marcar un punto | `M`, luego clic |
| Dibujar un área | `R`, luego arrastrar |
| Cancelar herramienta/cerrar panel | `Esc` |

Al escribir en un campo, estos atajos quedan suspendidos; `Esc` quita el foco.

## Privacidad

- La carpeta local se abre con permiso de solo lectura.
- Los archivos WebP se leen directamente en Chrome y no se suben.
- El visor no envía a un servidor la base SQLite, las rutas locales, las notas
  ni los highlights.
- Los highlights permanecen en el perfil y origen del navegador hasta que se
  exportan, importan o eliminan.
- Al activar el respaldo online, las solicitudes de los tiles visibles sí
  salen a la red. La ruta `/api/tile` valida los parámetros y consulta
  2b2t.place; por tanto, el servidor y el origen pueden observar qué
  coordenadas de tile se solicitaron.
- Copiar o compartir una URL revela el centro y zoom contenidos en su
  fragmento, aunque no revela los highlights.

Para máxima privacidad, ejecuta el visor localmente, conecta el archivo,
desactiva el respaldo online y no compartas enlaces ni JSON sensibles.

## Límites conocidos

- Solo se acepta `dimension=0`, Overworld. Nether y End no aparecen todavía.
- LOD 0–10 y tiles WebP de 512 × 512 siguen el contrato actual de 2b2t.place.
- El visor no convierte mosaicos PNG/WebP compuestos en una fuente navegable;
  necesita la estructura canónica de tiles.
- Conectar una carpeta no inicia ni controla el descargador Python.
- El respaldo online es visual y temporal; no completa el archivo en disco.
- Un archivo parcial mostrará huecos, tiles online o ancestros de menor
  resolución según la configuración.
- La disponibilidad del respaldo depende de la red y de 2b2t.place.

## Estructura relevante

```text
viewer/
├── app/
│   ├── api/tile/route.ts
│   ├── lib/local-tile-source.ts
│   ├── map-viewer.tsx
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx
├── tests/
├── package.json
└── vite.config.ts
```

- `map-viewer.tsx`: cámara, canvas, capas, interacción y highlights.
- `local-tile-source.ts`: selector de Chrome, rutas canónicas y ciclo de vida
  de archivos/URLs locales.
- `api/tile/route.ts`: proxy validado, Overworld-only, para el respaldo
  online.
- `globals.css`: diseño responsivo, estados y accesibilidad visual.

La documentación del descargador, estimaciones de almacenamiento y comando
actual de reanudación están en [`../README.md`](../README.md).
