#!/usr/bin/env bash
set -euo pipefail

project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
backing_volume="/Volumes/LuisA"
image_path="${backing_volume}/2b2t_map/2b2t_tiles.sparsebundle"
map_volume="/Volumes/2b2t Tiles"
output_dir="${map_volume}/2b2t_tiles"
python_bin="${PYTHON_BIN:-$(command -v python3)}"

if [[ ! -d "${backing_volume}" ]]; then
  echo "La unidad LuisA no está montada en ${backing_volume}." >&2
  exit 1
fi

if [[ ! -d "${image_path}" ]]; then
  echo "No existe el contenedor APFS esperado: ${image_path}" >&2
  exit 1
fi

if ! mount | grep -Fq " on ${map_volume} ("; then
  echo "Montando el contenedor APFS de tiles…"
  hdiutil attach -nobrowse "${image_path}" >/dev/null
fi

if ! mount | grep -Fq " on ${map_volume} ("; then
  echo "El contenedor se adjuntó, pero no quedó montado en ${map_volume}." >&2
  exit 1
fi

mkdir -p "${output_dir}"

echo "Descarga completa en ${output_dir}"
echo "La barra se actualiza cada cinco segundos. Ctrl+C detiene de forma segura."

exec caffeinate -im "${python_bin}" "${project_dir}/download_all_2b2t.py" \
  --all \
  --dimensions overworld,nether,end \
  --layers base,overlay,newchunks \
  --lods all \
  --out "${output_dir}" \
  --workers 4 \
  --requests-per-second 2 \
  --timeout 30 \
  --retries 5 \
  --discovery-samples 25 \
  --space-headroom-percent 18 \
  --resume \
  --skip-smoke-test \
  --no-fallback
