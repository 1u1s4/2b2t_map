#!/usr/bin/env bash
set -euo pipefail

project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source_dir="${project_dir}/macos"
app_name="Obsidian Atlas.app"
bundle_identifier="com.luisalvarado.obsidian-atlas"
install_dir="${OBSIDIAN_ATLAS_APP_INSTALL_DIR:-/Applications}"
viewer_port="${OBSIDIAN_ATLAS_VIEWER_PORT:-3001}"
browser_bundle_id="${OBSIDIAN_ATLAS_BROWSER_BUNDLE_ID:-com.google.Chrome}"
browser_name="${OBSIDIAN_ATLAS_BROWSER_NAME:-Google Chrome}"
python_bin="${PYTHON_BIN:-}"
staging_dir=""

usage() {
  cat <<'EOF'
Uso:
  ./install_macos_app.sh
  ./install_macos_app.sh --install-dir /ruta/de/Aplicaciones

Crea o actualiza "Obsidian Atlas.app". Al abrir el icono, la aplicación inicia
el servidor local supervisado si está apagado y después abre Atlas en Chrome.
El icono ejecuta directamente el código fuente actual del repositorio. Vuelve a
ejecutar este instalador solo si mueves el proyecto o cambias Node o Python.
EOF
}

while (( $# > 0 )); do
  case "${1}" in
    --install-dir)
      if (( $# < 2 )) || [[ -z "${2}" ]]; then
        echo "--install-dir requiere una ruta." >&2
        exit 2
      fi
      install_dir="${2}"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "La aplicación solo puede instalarse en macOS." >&2
  exit 1
fi
if [[ ! "${viewer_port}" =~ ^[0-9]+$ ]] ||
  (( viewer_port < 1024 || viewer_port > 65535 )); then
  echo "OBSIDIAN_ATLAS_VIEWER_PORT debe estar entre 1024 y 65535." >&2
  exit 2
fi

for required_tool in \
  /usr/bin/codesign \
  /usr/bin/iconutil \
  /usr/bin/open \
  /usr/bin/osacompile \
  /usr/bin/plutil \
  /usr/bin/sips; do
  if [[ ! -x "${required_tool}" ]]; then
    echo "No se encontró la herramienta de macOS: ${required_tool}" >&2
    exit 1
  fi
done

if [[ ! -x "${project_dir}/start_local_atlas_luisa.sh" ]]; then
  echo "No existe el lanzador canónico del Atlas." >&2
  exit 1
fi
if [[ ! -f "${source_dir}/ObsidianAtlas.applescript" ]] ||
  [[ ! -f "${source_dir}/start-and-open.sh" ]] ||
  [[ ! -f "${project_dir}/viewer/public/favicon.svg" ]]; then
  echo "Faltan recursos para construir la aplicación de macOS." >&2
  exit 1
fi
if [[ ! -d "${project_dir}/viewer/node_modules" ]]; then
  echo "Faltan dependencias del visor. Ejecuta: cd viewer && npm ci" >&2
  exit 1
fi

npm_bin=$(command -v npm || true)
node_bin=$(command -v node || true)
if [[ -z "${npm_bin}" || ! -x "${npm_bin}" ]] ||
  [[ -z "${node_bin}" || ! -x "${node_bin}" ]]; then
  echo "No se encontró una instalación ejecutable de Node.js y npm." >&2
  exit 1
fi
if [[ -z "${python_bin}" ]]; then
  python_bin=$(command -v python3 || true)
fi
if [[ -z "${python_bin}" || ! -x "${python_bin}" ]]; then
  echo "No se encontró un intérprete Python 3 ejecutable." >&2
  exit 1
fi
if ! /usr/bin/open -Ra "${browser_name}" >/dev/null 2>&1; then
  echo "No se encontró ${browser_name}; es necesario para abrir Atlas." >&2
  exit 1
fi

node_bin_dir=$(cd -- "$(dirname -- "${node_bin}")" && pwd)
npm_bin_dir=$(cd -- "$(dirname -- "${npm_bin}")" && pwd)
python_bin=$(cd -- "$(dirname -- "${python_bin}")" && pwd)/$(basename -- "${python_bin}")
python_bin_dir=$(dirname -- "${python_bin}")
executable_path="${node_bin_dir}:${npm_bin_dir}:${python_bin_dir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

if [[ -e "${install_dir}" && ! -d "${install_dir}" ]]; then
  echo "El destino de instalación no es un directorio: ${install_dir}" >&2
  exit 1
fi
if [[ ! -d "${install_dir}" ]]; then
  /usr/bin/install -d -m 755 "${install_dir}"
fi
if [[ ! -w "${install_dir}" ]]; then
  echo "No hay permiso para instalar en: ${install_dir}" >&2
  exit 1
fi
install_dir=$(cd -- "${install_dir}" && pwd)
target_app="${install_dir}/${app_name}"
staging_dir=$(mktemp -d "${install_dir}/.obsidian-atlas-install.XXXXXX")
staged_app="${staging_dir}/${app_name}"
iconset_dir="${staging_dir}/AppIcon.iconset"

cleanup() {
  if [[ -n "${staging_dir}" ]] &&
    [[ "${staging_dir}" == "${install_dir}/.obsidian-atlas-install."* ]] &&
    [[ -d "${staging_dir}" ]]; then
    /bin/rm -rf -- "${staging_dir}"
  fi
}
trap cleanup EXIT

/usr/bin/osacompile \
  -o "${staged_app}" \
  "${source_dir}/ObsidianAtlas.applescript"
/usr/bin/install -m 755 \
  "${source_dir}/start-and-open.sh" \
  "${staged_app}/Contents/Resources/start-and-open"

/usr/bin/install -d -m 755 "${iconset_dir}"
for icon_size in 16 32 128 256 512; do
  double_size=$((icon_size * 2))
  /usr/bin/sips -s format png -z "${icon_size}" "${icon_size}" \
    "${project_dir}/viewer/public/favicon.svg" \
    --out "${iconset_dir}/icon_${icon_size}x${icon_size}.png" \
    >/dev/null
  /usr/bin/sips -s format png -z "${double_size}" "${double_size}" \
    "${project_dir}/viewer/public/favicon.svg" \
    --out "${iconset_dir}/icon_${icon_size}x${icon_size}@2x.png" \
    >/dev/null
done
/usr/bin/iconutil -c icns \
  "${iconset_dir}" \
  -o "${staged_app}/Contents/Resources/AppIcon.icns"

plist="${staged_app}/Contents/Info.plist"
plist_set_string() {
  local key="${1}"
  local value="${2}"
  if /usr/bin/plutil -extract "${key}" raw -o - "${plist}" \
    >/dev/null 2>&1; then
    /usr/bin/plutil -replace "${key}" -string "${value}" "${plist}"
  else
    /usr/bin/plutil -insert "${key}" -string "${value}" "${plist}"
  fi
}

plist_set_string "CFBundleIdentifier" "${bundle_identifier}"
plist_set_string "CFBundleName" "Obsidian Atlas"
plist_set_string "CFBundleDisplayName" "Obsidian Atlas"
plist_set_string "CFBundleShortVersionString" "1.0.0"
plist_set_string "CFBundleVersion" "1"
plist_set_string "CFBundleIconFile" "AppIcon"
plist_set_string \
  "NSDocumentsFolderUsageDescription" \
  "Obsidian Atlas necesita ejecutar el código fuente de este proyecto desde Documentos."
plist_set_string \
  "NSRemovableVolumesUsageDescription" \
  "Obsidian Atlas necesita acceder a LuisA y a la biblioteca local del mapa."
plist_set_string "ObsidianAtlasProjectDirectory" "${project_dir}"
plist_set_string "ObsidianAtlasExecutablePath" "${executable_path}"
plist_set_string "ObsidianAtlasPython" "${python_bin}"
plist_set_string "ObsidianAtlasViewerPort" "${viewer_port}"
plist_set_string \
  "ObsidianAtlasBrowserBundleIdentifier" \
  "${browser_bundle_id}"
/usr/bin/plutil -remove "CFBundleIconName" "${plist}" >/dev/null 2>&1 || true
/usr/bin/plutil -lint "${plist}" >/dev/null
/usr/bin/codesign --force --deep --sign - "${staged_app}"
/usr/bin/codesign --verify --deep --strict "${staged_app}"

if [[ -e "${target_app}" || -L "${target_app}" ]]; then
  if [[ ! -d "${target_app}" ]]; then
    echo "El destino existe y no es una aplicación: ${target_app}" >&2
    exit 1
  fi
  existing_identifier=$(
    /usr/bin/plutil -extract CFBundleIdentifier raw -o - \
      "${target_app}/Contents/Info.plist" 2>/dev/null || true
  )
  if [[ "${existing_identifier}" != "${bundle_identifier}" ]]; then
    echo "No se reemplazó una aplicación ajena: ${target_app}" >&2
    exit 1
  fi
fi

previous_app="${staging_dir}/previous-${app_name}"
if [[ -d "${target_app}" ]]; then
  /bin/mv "${target_app}" "${previous_app}"
fi
if ! /bin/mv "${staged_app}" "${target_app}"; then
  if [[ -d "${previous_app}" && ! -e "${target_app}" ]]; then
    /bin/mv "${previous_app}" "${target_app}"
  fi
  echo "No se pudo instalar ${target_app}." >&2
  exit 1
fi

/usr/bin/touch "${target_app}"
launch_services_register="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [[ -x "${launch_services_register}" ]]; then
  "${launch_services_register}" -f "${target_app}" >/dev/null 2>&1 || true
fi

echo "Obsidian Atlas quedó instalado en: ${target_app}"
echo "Ábrelo desde Aplicaciones para iniciar el servidor y abrir Chrome."
