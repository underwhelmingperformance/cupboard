set -euo pipefail
case "$PUBLISH" in
  none|outputs|built|closure) ;;
  *) echo '::error::publish must be none, outputs, built, or closure' >&2; exit 2 ;;
esac
if [[ "$EVENT_NAME" == pull_request && "$HEAD_REPOSITORY_ID" != "$REPOSITORY_ID" ]]; then
  echo 'Cache operation: skip, because the pull request comes from a fork'
  echo 'operation=skip' >> "$GITHUB_OUTPUT"
  exit 0
fi
operation=publish
reason=''
if [[ "$EVENT_NAME" == pull_request ]]; then
  if [[ "$MANAGE_PR_CACHE" == true && "$PUBLISH" != none && -z "$CACHE" ]]; then
    echo '::error::manage-pr-cache requires a named cache input' >&2
    exit 2
  fi
  if [[ "$EVENT_ACTION" == closed ]]; then
    operation=skip
    reason=', because the pull request is closed'
    if [[ "$MANAGE_PR_CACHE" == true && "$PUBLISH" != none ]]; then
      operation=close
      reason=''
    fi
  fi
fi
echo "Cache operation: ${operation}${reason}"
echo "operation=$operation" >> "$GITHUB_OUTPUT"
