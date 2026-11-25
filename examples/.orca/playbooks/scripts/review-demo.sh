#!/bin/sh
# Replay fixed results for a sample pull request.
set -eu

case "$PLAYBOOK_STEP" in
  tests)
    sleep 3
    printf '%s\n' '12 checkout tests passed in the sample test run.'
    ;;
  scope)
    sleep 4
    printf '%s\n' 'The sample diff changes checkout copy only.'
    ;;
  summary)
    printf '%s\n' 'Sample PR #42: tests and scope checks passed. Ready for a human decision.'
    ;;
esac
