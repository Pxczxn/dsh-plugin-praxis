#!/usr/bin/env sh
set -eu
node "$(dirname "$0")/profile.mjs" uninstall "$@"
