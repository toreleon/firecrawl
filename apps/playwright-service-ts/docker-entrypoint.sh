#!/bin/sh
set -eu

if [ "${BROWSER_HEADLESS:-true}" = "false" ]; then
  exec xvfb-run -a -e /dev/stderr -s '-screen 0 1365x900x24' node dist/api.js
fi
exec node dist/api.js
