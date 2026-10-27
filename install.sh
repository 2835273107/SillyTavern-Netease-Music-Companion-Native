#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
    echo "Usage: ./install.sh /path/to/SillyTavern"
    exit 1
fi

source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$1" && pwd)"

for required in config.yaml public/scripts/extensions/third-party plugins; do
    if [[ ! -e "$root/$required" ]]; then
        echo "Invalid or incomplete SillyTavern path. Missing: $root/$required" >&2
        exit 1
    fi
done

frontend_target="$root/public/scripts/extensions/third-party/netease-music-companion-native"
backend_target="$root/plugins/netease-music-companion-native"
mkdir -p "$frontend_target" "$backend_target"

cp "$source_dir/manifest.json" "$source_dir/index.js" "$frontend_target/"
cp "$source_dir/plugin/index.js" "$source_dir/plugin/together-bridge.js" "$source_dir/plugin/package.json" "$source_dir/plugin/config.example.json" "$backend_target/"
mkdir -p "$backend_target/together-native"
cp "$source_dir/plugin/together-native/service.py" "$backend_target/together-native/service.py"
cp "$source_dir/plugin/.gitignore" "$backend_target/.gitignore"
cp "$source_dir/README.md" "$backend_target/README.md"

api_runtime_target="$backend_target/netease-api-runtime"
mkdir -p "$api_runtime_target"
cp "$source_dir/plugin/netease-api-runtime/package.json" "$api_runtime_target/package.json"
if [[ ! -f "$api_runtime_target/node_modules/NeteaseCloudMusicApi/app.js" ]]; then
    (
        cd "$api_runtime_target"
        npm install --omit=dev --ignore-scripts --no-audit --no-fund
    )
else
    echo "Managed NeteaseCloudMusicApi runtime already installed."
fi

if [[ ! -f "$backend_target/config.json" ]]; then
    cp "$source_dir/plugin/config.example.json" "$backend_target/config.json"
    chmod 600 "$backend_target/config.json" || true
    echo "Created config.json from config.example.json."
else
    echo "Existing config.json was preserved."
fi

echo
echo "Netease Music Companion Native installed."
echo "Frontend: $frontend_target"
echo "Backend:  $backend_target"
echo "Ensure enableServerPlugins: true in config.yaml, then restart SillyTavern."
