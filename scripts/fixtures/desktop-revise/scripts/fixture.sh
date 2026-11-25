#!/bin/sh
set -eu

cd "${PLAYBOOK_RUN_DIR:?}"
printf '%s\n' "${PLAYBOOK_STEP:?}" >> executions.log

case "$PLAYBOOK_STEP" in
  seed) printf 'DEMO SOURCE\n' ;;
  draft) printf 'DRAFT %s\n' "$(grep -c '^draft$' executions.log)" ;;
  publish) printf 'PUBLISHED: %s / %s\n' "$(cat seed.txt)" "$(cat draft.txt)" ;;
  *) exit 1 ;;
esac
