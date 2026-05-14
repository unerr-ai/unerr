#!/bin/bash
# unerr preToolUse hook for Cursor
# Installed by: unerr install cursor | Removed by: unerr uninstall cursor
input=$(cat)
tool_name=$(echo "$input" | jq -r '.tool_name // empty')
case "$tool_name" in
  Read)  echo "$input" | unerr hook pre-read ;;
  Grep)  echo "$input" | unerr hook pre-grep ;;
  Glob)  echo "$input" | unerr hook pre-glob ;;
  Write) echo "$input" | unerr hook pre-write ;;
  Edit)  echo "$input" | unerr hook pre-edit ;;
  *)     echo '{"permission":"allow"}' ;;
esac
