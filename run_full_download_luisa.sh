#!/usr/bin/env bash
set -euo pipefail

project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
backing_volume="/Volumes/LuisA"
image_path="${backing_volume}/2b2t_map/2b2t_tiles.sparsebundle"
map_volume="/Volumes/2b2t Tiles"
output_dir="${map_volume}/2b2t_tiles"
python_bin="${PYTHON_BIN:-$(command -v python3)}"
lock_dir="${output_dir}/.download.lock"
space_headroom_percent="${SPACE_HEADROOM_PERCENT:-20}"
temporary_migration="${ALLOW_TEMPORARY_HEADROOM_MIGRATION:-0}"

if ! "${python_bin}" -c \
  'import math, sys; value=float(sys.argv[1]); raise SystemExit(0 if math.isfinite(value) and 0 <= value <= 100 else 1)' \
  "${space_headroom_percent}" 2>/dev/null; then
  echo "SPACE_HEADROOM_PERCENT debe ser un porcentaje entre 0 y 100." >&2
  exit 2
fi
if [[ "${temporary_migration}" != "0" && "${temporary_migration}" != "1" ]]; then
  echo "ALLOW_TEMPORARY_HEADROOM_MIGRATION debe ser 0 o 1." >&2
  exit 2
fi
if [[ "${temporary_migration}" == "1" ]] &&
  ! "${python_bin}" -c \
    'import math, sys; raise SystemExit(0 if math.isclose(float(sys.argv[1]), 18.0, rel_tol=0.0, abs_tol=1e-9) else 1)' \
    "${space_headroom_percent}"; then
  echo "La migración temporal solo admite exactamente 18 %." >&2
  exit 2
fi
if [[ "${temporary_migration}" != "1" ]] &&
  ! "${python_bin}" -c \
    'import sys; raise SystemExit(0 if float(sys.argv[1]) >= 20 else 1)' \
    "${space_headroom_percent}"; then
  echo "La reserva normal debe ser al menos 20 %." >&2
  exit 2
fi

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

acquire_lock() {
  local owner_pid=""
  local stale_lock=""
  local attempt=0

  while (( attempt < 3 )); do
    if mkdir "${lock_dir}" 2>/dev/null; then
      printf '%s\n' "$$" >"${lock_dir}/pid"
      return 0
    fi

    if [[ -f "${lock_dir}/pid" ]]; then
      owner_pid=$(<"${lock_dir}/pid")
    fi
    if [[ "${owner_pid}" =~ ^[0-9]+$ ]] && kill -0 "${owner_pid}" 2>/dev/null; then
      echo "Ya existe una descarga activa con PID ${owner_pid}." >&2
      return 1
    fi

    stale_lock="${lock_dir}.stale.$$"
    if mv "${lock_dir}" "${stale_lock}" 2>/dev/null; then
      rm -f "${stale_lock}/pid"
      rmdir "${stale_lock}" 2>/dev/null || true
    fi
    attempt=$((attempt + 1))
  done

  echo "No se pudo adquirir el bloqueo de descarga: ${lock_dir}" >&2
  return 1
}

acquire_lock

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
  --space-headroom-percent "${space_headroom_percent}" \
  --resume \
  --skip-smoke-test \
  --no-fallback
