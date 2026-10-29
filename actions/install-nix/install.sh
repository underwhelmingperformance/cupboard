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

enable_kvm() {
  if [[ "$1" != *-linux ]]; then
    return
  fi
  if printf '%s\n' 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' \
      | sudo tee /etc/udev/rules.d/99-install-nix-action-kvm.rules >/dev/null \
    && sudo udevadm control --reload-rules \
    && sudo udevadm trigger --name-match=kvm; then
    return
  fi
  echo '::warning::Could not enable KVM; continuing Nix installation' >&2
}

darwin_root_device() {
  /usr/bin/stat -f '%Sd' /
}

create_darwin_store() {
  local disk
  disk=$(darwin_root_device)
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

sha256_of() {
  local digest
  if command -v sha256sum >/dev/null; then
    read -r digest _ < <(sha256sum "$1")
  else
    read -r digest _ < <(shasum -a 256 "$1")
  fi
  printf '%s\n' "$digest"
}

install_archive() (
  local system=$1 tar=$2 name pin expected actual
  name="nix-$nix_version-$system.tar.zstd"
  pin="sha256_${system//-/_}"
  expected=${!pin:-}
  if [[ ! "$expected" =~ ^[0-9a-f]{64}$ ]]; then
    echo "::error::versions.env does not set $pin to a lowercase hexadecimal SHA-256 digest for $name." >&2
    return 1
  fi

  # The subshell confines archive. Bash 3.2 unsets a local variable before the
  # EXIT trap runs, so declaring it local would leave the file behind.
  archive=$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/nix-archive.XXXXXX")
  trap 'rm -f "$archive"' EXIT
  curl --fail --silent --show-error --location --retry 3 --retry-connrefused \
    --output "$archive" \
    "https://github.com/nixbuild/nix-quick-install-action/releases/download/$archive_release/$name"
  actual=$(sha256_of "$archive")
  if [[ "$actual" != "$expected" ]]; then
    echo "::error::$name has SHA-256 digest $actual, but versions.env expects $expected. If nix_version and archive_release have not changed, the upstream release asset has changed: investigate it and do not update the pin. actions/install-nix/README.md describes how to record the digests for a new version." >&2
    return 1
  fi

  prepare_store "$system"
  "$tar" --skip-old-files --strip-components 1 -x -I unzstd -C /nix -f "$archive"
)

replace_file() {
  local temporary
  temporary=$(mktemp "$1.XXXXXX")
  cat > "$temporary"
  mv -f "$temporary" "$1"
}

write_netrc() {
  local netrc=$HOME/.netrc
  {
    if [[ -e "$netrc" ]]; then
      awk '
        tolower($1) == "machine" || tolower($1) == "default" {
          skip = tolower($1) == "machine" && tolower($2) == "github.com"
        }
        /^[[:space:]]*#/ || !skip
      ' "$netrc"
    fi
    printf 'machine github.com\nlogin github-token\npassword %s\n' "$GITHUB_ACCESS_TOKEN"
  } | replace_file "$netrc"
}

configure_nix() {
  local directory configuration
  directory="${XDG_CONFIG_HOME:-$HOME/.config}/nix"
  configuration="$directory/nix.conf"
  mkdir -p "$directory"
  touch "$configuration"
  if [[ -n "${GITHUB_ACCESS_TOKEN:-}" ]]; then
    printf 'access-tokens = github.com=%s\n' "$GITHUB_ACCESS_TOKEN" \
      | replace_file "$directory/github-access-token.conf"
    write_netrc
  fi

  {
    awk '!/^access-tokens = github\.com=[^[:space:]]*$/' "$configuration"
    if [[ -n "${GITHUB_ACCESS_TOKEN:-}" ]] \
      && ! grep -qxF '!include github-access-token.conf' "$configuration"; then
      printf '\n!include github-access-token.conf\n'
    fi
    printf '\nextra-experimental-features = nix-command flakes\naccept-flake-config = true\n'
  } | replace_file "$configuration"
}

main() {
  local system tar nix
  # shellcheck source=versions.env
  source "${BASH_SOURCE[0]%/*}/versions.env"
  system=$(nix_system "$(uname -m)" "$(uname -s)")
  enable_kvm "$system"

  tar=tar
  if [[ "$system" == *-darwin ]]; then
    tar=gtar
  fi
  install_archive "$system" "$tar"
  configure_nix

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
