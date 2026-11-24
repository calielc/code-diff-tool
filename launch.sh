#!/usr/bin/env sh
# Gets the newest Code Diff code and starts the app. See scripts/start.ts.
cd "$(dirname "$0")" || exit 1
exec node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/start.ts "$@"
