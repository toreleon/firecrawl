#!/bin/sh
set -eu

if [ "${BROWSER_ENGINE:-rebrowser}" = "webkit" ]; then
  exec sh scripts/webkit-entrypoint.sh node dist/api.js
fi

if [ "${BROWSER_HEADLESS:-true}" = "false" ]; then
  exec xvfb-run -a -e /dev/stderr -s '-screen 0 1365x900x24' node dist/api.js
fi
exec node dist/api.js
