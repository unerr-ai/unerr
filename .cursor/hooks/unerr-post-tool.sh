#!/bin/bash
# unerr postToolUse hook for Cursor
# Installed by: unerr install cursor | Removed by: unerr uninstall cursor
input=$(cat)
tool_name=$(echo "$input" | jq -r '.tool_name // empty')
case "$tool_name" in
  Read)  echo "$input" | unerr hook post-read ;;
  Grep)  echo "$input" | unerr hook post-grep ;;
  Glob)  echo "$input" | unerr hook post-glob ;;
  Write) echo "$input" | unerr hook post-write ;;
  Edit)  echo "$input" | unerr hook post-edit ;;
  *)     echo '{}' ;;
esac
