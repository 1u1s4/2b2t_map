#!/usr/bin/env bash
set -euo pipefail

contents_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
info_plist="${contents_dir}/Info.plist"
runtime_dir="${HOME}/Library/Application Support/ObsidianAtlas"
launcher_log="${runtime_dir}/application_launcher.log"
launcher_guard="${runtime_dir}/.application-launcher.guard"

/usr/bin/install -d -m 700 "${runtime_dir}"
umask 077
touch "${launcher_log}"

log_message() {
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" \
    >>"${launcher_log}"
}

fail() {
  log_message "ERROR: $*"
  printf '%s\n\nLog: %s\n' "$*" "${launcher_log}" >&2
  exit 1
}

plist_value() {
  local key="${1}"
  local label="${2}"
  local value=""

  value=$(
    /usr/bin/plutil -extract "${key}" raw -o - "${info_plist}" 2>/dev/null || true
  )
  if [[ -z "${value}" ]]; then
    fail "La aplicación no contiene la configuración de ${label}."
  fi
  printf '%s\n' "${value}"
}

if [[ "${1:-}" != "--under-lock" ]]; then
  exec /usr/bin/lockf -k -t 150 \
    "${launcher_guard}" \
    /bin/bash "${BASH_SOURCE[0]}" --under-lock
fi

project_dir=$(plist_value "ObsidianAtlasProjectDirectory" "proyecto fuente")
executable_path=$(plist_value "ObsidianAtlasExecutablePath" "ejecutables")
python_bin=$(plist_value "ObsidianAtlasPython" "Python")
viewer_port=$(plist_value "ObsidianAtlasViewerPort" "puerto")
browser_bundle_id=$(
  plist_value "ObsidianAtlasBrowserBundleIdentifier" "Google Chrome"
)
viewer_url="http://localhost:${viewer_port}"
canonical_launcher="${project_dir}/start_local_atlas_luisa.sh"

if [[ ! "${viewer_port}" =~ ^[0-9]+$ ]] ||
  (( viewer_port < 1024 || viewer_port > 65535 )); then
  fail "El puerto configurado para Atlas no es válido: ${viewer_port}"
fi
if [[ ! -x "${canonical_launcher}" ]]; then
  fail "No se encontró el código fuente en ${canonical_launcher}. Si moviste el repositorio, vuelve a ejecutar install_macos_app.sh."
fi
if [[ ! -x "${python_bin}" ]]; then
  fail "Python ya no está disponible en ${python_bin}. Vuelve a ejecutar install_macos_app.sh."
fi

export PATH="${executable_path}"
export PYTHON_BIN="${python_bin}"
export OBSIDIAN_ATLAS_VIEWER_PORT="${viewer_port}"
export TERM="xterm-256color"

log_message "Solicitud de apertura de Obsidian Atlas desde ${project_dir}."
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  fail "Node.js o npm ya no están disponibles. Vuelve a ejecutar install_macos_app.sh."
fi

launch_output=""
if ! launch_output=$("${canonical_launcher}" 2>&1); then
  launch_summary=$(
    printf '%s\n' "${launch_output}" | /usr/bin/tail -n 20
  )
  fail "El servidor local no pudo iniciar. ${launch_summary}"
fi
if [[ -n "${launch_output}" ]]; then
  printf '%s\n' "${launch_output}" >>"${launcher_log}"
fi

if ! /usr/bin/open -b "${browser_bundle_id}" "${viewer_url}"; then
  fail "Atlas está activo en ${viewer_url}, pero Google Chrome no pudo abrirse."
fi
log_message "Atlas listo; interfaz abierta en ${viewer_url}."
