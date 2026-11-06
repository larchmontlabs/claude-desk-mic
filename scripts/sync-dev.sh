#!/usr/bin/env bash
# Copy the plugin into a dev-mods folder so a live session hot-reloads it.
# Usage: scripts/sync-dev.sh <dev-mods-folder>/desk-mic
set -euo pipefail
dest="${1:?usage: sync-dev.sh <dev-mods folder>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$dest/.claude-plugin" "$dest/hooks" "$dest/engine"
cp "$root/.claude-plugin/plugin.json" "$dest/.claude-plugin/plugin.json"
cp -r "$root/hooks/." "$dest/hooks/"
cp -r "$root/engine/." "$dest/engine/"
