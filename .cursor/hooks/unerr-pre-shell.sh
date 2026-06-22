#!/bin/bash
# unerr beforeShellExecution hook for Cursor
# Installed by: unerr install cursor | Removed by: unerr uninstall cursor
# Cursor's shell hook can't rewrite the command to `unerr exec` (no updated_input
# on beforeShellExecution), so unerr hook pre-shell surfaces the code-nav drift
# redirect (get_references/search_code/file_read) as agent_message and allows.
cat | unerr hook pre-shell
