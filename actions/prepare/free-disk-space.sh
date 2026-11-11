#!/usr/bin/env bash

# Removes preinstalled software from a macOS runner. The prepare action starts
# this script in the background, and the build-cohort action reads the status
# from the named pipe before it needs the space.
#
# Usage: free-disk-space.sh STATUS_PIPE LOG_FILE

set -u

status_pipe="$1"
log_file="$2"
status=1

# Opening the pipe blocks until a reader exists, so the status cannot be lost
# when the script finishes before the reader starts. The trap writes the status
# on every exit, so a failure reaches the reader as well as a success.
trap 'printf "%s\n" "${status}" > "${status_pipe}"' EXIT

(
  set -euo pipefail

  df -h /

  sudo xcode-select --switch /Library/Developer/CommandLineTools || true
  sudo rm -rf /Applications/Xcode_*.app
  sudo rm -rf /Library/Developer/CoreSimulator/Profiles/Runtimes/* || true
  sudo rm -rf ~/Library/Developer/CoreSimulator/Caches/* || true
  xcrun simctl delete unavailable || true

  df -h /
) >> "${log_file}" 2>&1
status=$?
