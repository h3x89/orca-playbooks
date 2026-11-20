#!/bin/sh
# Script step of the sequential-vs-parallel example: waits a few seconds, then says which step ran and when.
seconds="${PLAYBOOK_INPUT_SECONDS:-5}"
start=$(date +%H:%M:%S)
sleep "$seconds"
echo "Step $PLAYBOOK_STEP ran from $start to $(date +%H:%M:%S)."
