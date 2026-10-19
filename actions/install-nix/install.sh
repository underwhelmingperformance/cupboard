#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# shellcheck source-path=SCRIPTDIR

set -euo pipefail

nix_system() {
  case "$1-$2" in
    x86_64-Linux) echo x86_64-linux ;;
    aarch64-Linux) echo aarch64-linux ;;
    x86_64-Darwin) echo x86_64-darwin ;;
    arm64-Darwin) echo aarch64-darwin ;;
    *) echo "::error::Unsupported runner system: $1-$2" >&2; return 1 ;;
  esac
}

create_darwin_store() {
  local disk
  disk=$(stat -f '%Sd' /)
  disk=${disk%s[0-9]*}
  printf 'nix\nrun\tprivate/var/run\n' | sudo tee -a /etc/synthetic.conf
  sudo /System/Library/Filesystems/apfs.fs/Contents/Resources/apfs.util -B &>/dev/null \
    || sudo /System/Library/Filesystems/apfs.fs/Contents/Resources/apfs.util -t &>/dev/null \
    || echo '::warning::Could not refresh synthetic mount points' >&2
  sudo diskutil apfs addVolume "$disk" APFS nix -mountpoint /nix
  if ! sudo mdutil -i off /nix; then
    echo '::warning::Could not disable Spotlight indexing for /nix; continuing Nix installation' >&2
  fi
  sudo chown "$USER" /nix
}

prepare_store() {
  if [[ -e /nix ]]; then
    if [[ ! -w /nix ]]; then
      echo '::error::/nix exists but is not writable by the runner' >&2
      return 1
    fi
    rm -rf /nix/var/nix-quick-install-action
    return
  fi

  if [[ "$1" == *-darwin ]]; then
    create_darwin_store
    return
  fi

  sudo install -d -o "$USER" /nix
}

load_nix_database() {
  local attempt
  for attempt in 1 2 3; do
    if "$1/bin/nix-store" --load-db < "$2"; then
      return
    fi
    if [[ "$attempt" == 3 ]]; then
      echo '::error::Nix database registration failed after three attempts' >&2
      return 1
    fi
    echo 'Retrying Nix database registration' >&2
    sleep 2
  done
}

main() {
  local system tar nix configuration
  # shellcheck source=versions.env
  source "${BASH_SOURCE[0]%/*}/versions.env"
  system=$(nix_system "$(uname -m)" "$(uname -s)")
  prepare_store "$system"

  tar=tar
  if [[ "$system" == *-darwin ]]; then
    tar=gtar
  fi
  curl --fail --silent --show-error --location --retry 3 --retry-connrefused \
    "https://github.com/nixbuild/nix-quick-install-action/releases/download/$archive_release/nix-$nix_version-$system.tar.zstd" \
    | "$tar" --skip-old-files --strip-components 1 -x -I unzstd -C /nix

  configuration="${XDG_CONFIG_HOME:-$HOME/.config}/nix/nix.conf"
  mkdir -p "$(dirname "$configuration")"
  touch "$configuration"
  if [[ -n "${GITHUB_ACCESS_TOKEN:-}" ]]; then
    printf '\naccess-tokens = github.com=%s\n' "$GITHUB_ACCESS_TOKEN" >> "$configuration"
    printf 'machine github.com\nlogin github-token\npassword %s\n' "$GITHUB_ACCESS_TOKEN" >> "$HOME/.netrc"
    chmod 600 "$HOME/.netrc"
  fi
  printf '\nextra-experimental-features = nix-command flakes\naccept-flake-config = true\n' >> "$configuration"

  nix=$(readlink /nix/var/nix-quick-install-action/nix)
  load_nix_database "$nix" /nix/var/nix-quick-install-action/registration
  # shellcheck source=/dev/null
  MANPATH='' source "$nix/etc/profile.d/nix.sh"
  "$nix/bin/nix-env" -i "$nix"

  if [[ -z "${NIX_SSL_CERT_FILE:-}" && -e /etc/ssl/cert.pem ]]; then
    NIX_SSL_CERT_FILE=/etc/ssl/cert.pem
  fi
  printf '%s/.nix-profile/bin\n' "$HOME" >> "$GITHUB_PATH"
  {
    printf 'NIX_PROFILES=/nix/var/nix/profiles/default %s/.nix-profile\n' "$HOME"
    printf 'NIX_USER_PROFILE_DIR=/nix/var/nix/profiles/per-user/%s\n' "$USER"
    printf 'NIX_SSL_CERT_FILE=%s\n' "${NIX_SSL_CERT_FILE:-}"
  } >> "$GITHUB_ENV"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main
fi
