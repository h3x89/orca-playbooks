#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

case "$(uname -s)" in
  Linux) orca_cli=orca-ide ;;
  *) orca_cli=orca ;;
esac

"$orca_cli" plugin validate .
"$orca_cli" plugin test .
