#!/usr/bin/env sh
set -eu
node "$(dirname "$0")/link.mjs" install "$@"
