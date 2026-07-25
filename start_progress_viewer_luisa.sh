#!/usr/bin/env bash
set -euo pipefail

project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
viewer_dir="${project_dir}/viewer"
output_dir="/Volumes/2b2t Tiles/2b2t_tiles"
progress_file="${output_dir}/progress.json"
log_file="${output_dir}/progress_viewer.log"
lock_file="${output_dir}/.progress_viewer.lock"
lock_guard="${lock_file}.guard"
session_name="obsidian_atlas_viewer"
viewer_port="${OBSIDIAN_ATLAS_VIEWER_PORT:-3001}"
python_bin="${PYTHON_BIN:-}"
if [[ -z "${python_bin}" ]]; then
  python_bin=$(command -v python3 || true)
fi
viewer_url="http://localhost:${viewer_port}"
mode="${1:-start}"

usage() {
  cat <<'EOF'
Uso:
  ./start_progress_viewer_luisa.sh
  ./start_progress_viewer_luisa.sh --status
  ./start_progress_viewer_luisa.sh --stop

Inicia Obsidian Atlas en una sesión screen supervisada y limitada a localhost.
La barra lee la descarga activa cada cinco segundos. El modo interno
--serve-loop y sus auxiliares no están pensados para ejecutarse directamente.
EOF
}

screen_has_session() {
  local listing=""
  listing=$(screen -ls 2>/dev/null || true)
  grep -E "[[:space:]][0-9]+\\.${session_name}[[:space:]]" \
    <<<"${listing}" >/dev/null
}

supervisor_pid() {
  local owner_pid=""
  local owner_command=""

  [[ -f "${lock_file}" ]] || return 1
  owner_pid=$(<"${lock_file}")
  [[ "${owner_pid}" =~ ^[0-9]+$ ]] || return 1
  kill -0 "${owner_pid}" 2>/dev/null || return 1
  owner_command=$(ps -o command= -p "${owner_pid}" 2>/dev/null || true)
  case "${owner_command}" in
    *start_progress_viewer_luisa.sh*" --serve-loop"*)
      printf '%s\n' "${owner_pid}"
      ;;
    *)
      return 1
      ;;
  esac
}

bridge_is_ready() {
  "${python_bin}" - "${viewer_url}/api/local-progress" <<'PY' >/dev/null 2>&1
import json
import sys
import urllib.request

request = urllib.request.Request(
    sys.argv[1],
    headers={"Accept": "application/json"},
)
with urllib.request.urlopen(request, timeout=3) as response:
    if response.status != 200:
        raise SystemExit(1)
    if response.headers.get("Cache-Control") != "no-store":
        raise SystemExit(1)
    payload = json.load(response)

status = payload.get("status")
if not isinstance(status, str) or not status.strip():
    raise SystemExit(1)
if "output" in payload or "resume_command" in payload:
    raise SystemExit(1)
PY
}

validate_commands() {
  if [[ ! "${viewer_port}" =~ ^[0-9]+$ ]] ||
    (( viewer_port < 1024 || viewer_port > 65535 )); then
    echo "OBSIDIAN_ATLAS_VIEWER_PORT debe estar entre 1024 y 65535." >&2
    exit 2
  fi
  if ! command -v screen >/dev/null 2>&1; then
    echo "No se encontró screen, necesario para mantener el visor activo." >&2
    exit 1
  fi
  if ! command -v npm >/dev/null 2>&1; then
    echo "No se encontró npm en PATH." >&2
    exit 1
  fi
  if [[ ! -x /usr/bin/lockf ]]; then
    echo "No se encontró /usr/bin/lockf." >&2
    exit 1
  fi
  if [[ -z "${python_bin}" || ! -x "${python_bin}" ]]; then
    echo "No se encontró un intérprete Python 3 ejecutable." >&2
    exit 1
  fi
}

validate_environment() {
  validate_commands
  if [[ ! -f "${progress_file}" ]]; then
    echo "No existe el progreso esperado: ${progress_file}" >&2
    exit 1
  fi
  if [[ ! -f "${viewer_dir}/package.json" ]]; then
    echo "No existe el proyecto del visor en ${viewer_dir}." >&2
    exit 1
  fi
  if [[ ! -d "${viewer_dir}/node_modules" ]]; then
    echo "Faltan dependencias del visor. Ejecuta: cd viewer && npm ci" >&2
    exit 1
  fi
}

acquire_lock_for_pid() {
  local requested_pid="${1:-}"
  local candidate_lock="${lock_file}.candidate.${requested_pid}.$$"
  local owner_pid=""
  local requested_command=""
  local stale_lock=""
  local attempt=0

  if [[ ! "${requested_pid}" =~ ^[0-9]+$ ]] ||
    ! kill -0 "${requested_pid}" 2>/dev/null; then
    echo "El PID solicitado para el bloqueo no está activo." >&2
    return 2
  fi
  requested_command=$(
    ps -o command= -p "${requested_pid}" 2>/dev/null || true
  )
  case "${requested_command}" in
    *start_progress_viewer_luisa.sh*" --serve-loop"*) ;;
    *)
      echo "El PID solicitado no es el supervisor canónico del visor." >&2
      return 2
      ;;
  esac

  printf '%s\n' "${requested_pid}" >"${candidate_lock}"
  while (( attempt < 3 )); do
    if ln "${candidate_lock}" "${lock_file}" 2>/dev/null; then
      rm -f "${candidate_lock}"
      return 0
    fi

    owner_pid=$(supervisor_pid || true)
    if [[ -n "${owner_pid}" ]]; then
      rm -f "${candidate_lock}"
      echo "Ya existe un supervisor del visor con PID ${owner_pid}." >&2
      return 1
    fi

    stale_lock="${lock_file}.stale.${requested_pid}.$$"
    if mv "${lock_file}" "${stale_lock}" 2>/dev/null; then
      rm -f "${stale_lock}"
    fi
    attempt=$((attempt + 1))
  done

  rm -f "${candidate_lock}"
  echo "No se pudo adquirir el bloqueo del visor: ${lock_file}" >&2
  return 1
}

acquire_lock() {
  /usr/bin/lockf -t 10 "${lock_guard}" \
    "${project_dir}/start_progress_viewer_luisa.sh" --acquire-lock "$$"
}

rotate_log_if_needed() {
  local log_size=0

  if [[ -f "${log_file}" ]]; then
    log_size=$(wc -c <"${log_file}" | tr -d '[:space:]')
  fi
  if [[ "${log_size}" =~ ^[0-9]+$ ]] && (( log_size > 10 * 1024 * 1024 )); then
    if mv -f "${log_file}" "${log_file}.1"; then
      exec >>"${log_file}" 2>&1
    fi
  fi
}

serve_loop() {
  local child_pid=""
  local exit_code=0
  local failures=0
  local restart_delay=5
  local started_at=0
  local runtime=0
  local stop_requested=0

  exec >>"${log_file}" 2>&1
  acquire_lock

  cleanup() {
    local owner_pid=""
    if [[ -f "${lock_file}" ]]; then
      owner_pid=$(<"${lock_file}")
    fi
    if [[ "${owner_pid}" == "$$" ]]; then
      rm -f "${lock_file}"
    fi
  }

  request_stop() {
    stop_requested=1
    if [[ "${child_pid}" =~ ^[0-9]+$ ]] &&
      kill -0 "${child_pid}" 2>/dev/null; then
      kill -TERM "${child_pid}" 2>/dev/null || true
    fi
  }

  trap request_stop HUP INT TERM
  trap cleanup EXIT

  while (( stop_requested == 0 )); do
    rotate_log_if_needed
    started_at=$(date +%s)
    printf '%s Iniciando Obsidian Atlas en %s\n' \
      "$(date '+%Y-%m-%d %H:%M:%S')" "${viewer_url}"

    (
      cd "${viewer_dir}"
      export OBSIDIAN_ATLAS_PROGRESS_FILE="${progress_file}"
      exec npm run dev -- \
        --hostname localhost \
        --port "${viewer_port}"
    ) &
    child_pid=$!

    set +e
    wait "${child_pid}"
    exit_code=$?
    set -e
    child_pid=""

    if (( stop_requested != 0 )); then
      break
    fi

    runtime=$(( $(date +%s) - started_at ))
    if (( runtime >= 60 )); then
      failures=0
    fi
    failures=$((failures + 1))
    restart_delay=$((failures * 5))
    if (( restart_delay > 30 )); then
      restart_delay=30
    fi

    printf '%s El visor terminó con código %s; reinicio en %ss.\n' \
      "$(date '+%Y-%m-%d %H:%M:%S')" "${exit_code}" "${restart_delay}"
    sleep "${restart_delay}"
  done

  printf '%s Supervisor del visor detenido limpiamente.\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')"
}

start_viewer() {
  local attempt=0
  local session_seen=0
  local owner_pid=""

  validate_environment
  if bridge_is_ready; then
    owner_pid=$(supervisor_pid || true)
    if [[ -n "${owner_pid}" ]] && screen_has_session; then
      echo "Obsidian Atlas ya está disponible en ${viewer_url}"
      return 0
    fi
    echo "El puerto ${viewer_port} responde, pero no pertenece al visor supervisado." >&2
    echo "Detén ese proceso o libera el puerto antes de iniciar Obsidian Atlas." >&2
    return 1
  fi
  if screen_has_session; then
    echo "La sesión ${session_name} existe; esperando que el visor responda…"
  else
    mkdir -p "${output_dir}"
    screen \
      -dmS "${session_name}" \
      "${BASH_SOURCE[0]}" --serve-loop
    echo "Iniciando Obsidian Atlas en segundo plano…"
  fi

  while (( attempt < 45 )); do
    owner_pid=$(supervisor_pid || true)
    if [[ -n "${owner_pid}" ]] && screen_has_session && bridge_is_ready; then
      echo "Obsidian Atlas está disponible en ${viewer_url}"
      echo "Log: ${log_file}"
      return 0
    fi
    if screen_has_session; then
      session_seen=1
    elif (( session_seen != 0 || attempt >= 5 )); then
      echo "El visor terminó antes de quedar disponible." >&2
      tail -n 30 "${log_file}" >&2 2>/dev/null || true
      return 1
    fi
    sleep 1
    attempt=$((attempt + 1))
  done

  echo "El visor no respondió en 45 segundos; revisa ${log_file}." >&2
  return 1
}

show_status() {
  local owner_pid=""

  validate_commands
  owner_pid=$(supervisor_pid || true)
  if [[ -n "${owner_pid}" ]] && screen_has_session && bridge_is_ready; then
    echo "running ${viewer_url}"
    exit 0
  fi
  if bridge_is_ready; then
    echo "unmanaged_or_orphaned ${viewer_url}"
    exit 1
  fi
  if screen_has_session || [[ -n "${owner_pid}" ]]; then
    echo "starting_or_unhealthy ${viewer_url}"
    exit 1
  fi
  echo "stopped ${viewer_url}"
  exit 1
}

stop_viewer() {
  local attempt=0
  local owner_pid=""

  if ! command -v screen >/dev/null 2>&1; then
    echo "No se encontró screen." >&2
    exit 1
  fi
  owner_pid=$(supervisor_pid || true)
  if [[ -z "${owner_pid}" ]] &&
    [[ ! -e "${lock_file}" ]] &&
    ! screen_has_session &&
    ! bridge_is_ready; then
    echo "Obsidian Atlas ya está detenido."
    return 0
  fi

  if [[ -n "${owner_pid}" ]]; then
    kill -TERM "${owner_pid}"
    while (( attempt < 20 )) && kill -0 "${owner_pid}" 2>/dev/null; do
      sleep 1
      attempt=$((attempt + 1))
    done
    if kill -0 "${owner_pid}" 2>/dev/null; then
      echo "El supervisor ${owner_pid} no se detuvo en 20 segundos." >&2
      return 1
    fi
  fi

  if screen_has_session; then
    screen -S "${session_name}" -X quit
  fi

  attempt=0
  while (( attempt < 20 )); do
    if ! screen_has_session &&
      [[ ! -e "${lock_file}" ]] &&
      [[ -z "$(supervisor_pid || true)" ]] &&
      ! bridge_is_ready; then
      echo "Obsidian Atlas detenido."
      return 0
    fi
    sleep 0.25
    attempt=$((attempt + 1))
  done

  if bridge_is_ready; then
    echo "El servidor del visor sigue respondiendo tras detenerlo." >&2
  elif screen_has_session; then
    echo "La sesión ${session_name} no terminó limpiamente." >&2
  else
    echo "El bloqueo del supervisor no se limpió." >&2
  fi
  if [[ -n "$(supervisor_pid || true)" ]]; then
    return 1
  fi
  return 1
}

case "${mode}" in
  start)
    start_viewer
    ;;
  --status)
    show_status
    ;;
  --stop)
    stop_viewer
    ;;
  --serve-loop)
    validate_environment
    serve_loop
    ;;
  --acquire-lock)
    acquire_lock_for_pid "${2:-}"
    ;;
  -h | --help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
