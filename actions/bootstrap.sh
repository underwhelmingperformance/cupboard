set -euo pipefail

case "$1" in
  toolchain)
    manifest="$GITHUB_ACTION_PATH/../../package.json"
    node_version_file="$GITHUB_ACTION_PATH/../../.node-version"
    version="$(sed -n 's/.*"packageManager": *"pnpm@\([^+"]*\).*/\1/p' "$manifest")"
    if [ -z "$version" ]; then
      echo "::error::package.json declares no pnpm packageManager pin"
      exit 1
    fi
    if [ ! -r "$node_version_file" ]; then
      echo "::error::.node-version is not readable"
      exit 1
    fi
    node_version="$(tr -d '\r\n' < "$node_version_file")"
    if [ -z "$node_version" ]; then
      echo "::error::.node-version declares no Node version"
      exit 1
    fi
    echo "pnpm-version=$version" >> "$GITHUB_OUTPUT"
    echo "node-version=$node_version" >> "$GITHUB_OUTPUT"
    ;;
  install)
    echo "::group::Install action dependencies"
    cd "$GITHUB_ACTION_PATH/../.."
    pnpm install --filter @cupboard/action... --prod --frozen-lockfile
    echo "::endgroup::"
    ;;
  *)
    echo "::error::Unknown bootstrap operation: $1" >&2
    exit 2
    ;;
esac
