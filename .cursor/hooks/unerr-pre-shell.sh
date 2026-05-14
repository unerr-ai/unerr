#!/bin/bash
# unerr beforeShellExecution hook for Cursor
# Installed by: unerr install cursor | Removed by: unerr uninstall cursor
# For v1, just allow — shell compression routes through PreToolUse/Bash/exec pipeline
cat > /dev/null
echo '{"permission":"allow"}'
