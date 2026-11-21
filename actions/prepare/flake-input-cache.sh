#!/usr/bin/env bash

# Prepares the flake input cache for this job.
#
#   locate    reads FLAKE_INPUT_CACHE and LOCK_HASH. When the cache is on, it
#             removes any copy that a persistent runner kept, writes the cache
#             key to GITHUB_OUTPUT and exports the directory and key through
#             GITHUB_ENV. Otherwise it writes a notice that says why the cache
#             is off. The plan action collects and saves the cache whenever the
#             key is set and the restore found no entry.
#   restored  records through GITHUB_ENV that the restore found an entry.
#   use       reads STORE and Nix's effective `builders` setting, and adds the
#             restored cache to the job's substituters when neither a remote
#             store nor a remote builder would receive that setting.

set -euo pipefail

# actions/cache identifies an entry by the path as written, so actions/prepare
# and actions/plan both give this directory as ~/.cache/cupboard-flake-inputs.
directory="${HOME}/.cache/cupboard-flake-inputs"

locate() {
  case "${FLAKE_INPUT_CACHE}" in
    true) ;;
    false)
      echo '::notice::The flake input cache is off because flake-input-cache is false.'
      return
      ;;
    *)
      echo '::error::flake-input-cache must be true or false'
      exit 1
      ;;
  esac

  if [ -z "${LOCK_HASH}" ]; then
    echo '::notice::The flake input cache is off because the checkout has no flake.lock.'
    return
  fi

  rm -rf "${directory}"
  key="cupboard-flake-inputs-v1-${LOCK_HASH}"
  echo "key=${key}" >> "${GITHUB_OUTPUT}"
  {
    echo "CUPBOARD_FLAKE_INPUT_CACHE_DIRECTORY=${directory}"
    echo "CUPBOARD_FLAKE_INPUT_CACHE_KEY=${key}"
  } >> "${GITHUB_ENV}"
}

restored() {
  echo "CUPBOARD_FLAKE_INPUT_CACHE_RESTORED=true" >> "${GITHUB_ENV}"
}

# Prints a builders entry, machines file line or machines file path as Nix's
# `expandBuilderLines` reads it: without anything from `#` onwards and without
# surrounding whitespace.
builder_line() {
  local line="${1%%#*}"
  line="${line#"${line%%[![:space:]]*}"}"
  printf '%s' "${line%"${line##*[![:space:]]}"}"
}

# Whether Nix's effective `builders` setting lists any machine. Returns 0 when
# it does, 1 when it does not, and 2 when the setting or a machines file that
# exists cannot be read. The setting separates machines with semicolons or
# newlines, and an entry that starts with `@` reads machines from a file, as
# the default `@/etc/nix/machines` does.
builders_status() {
  local builders entry file contents line
  builders="$(nix config show builders)" || return 2

  while IFS= read -r entry; do
    entry="$(builder_line "${entry}")"

    if [[ "${entry}" != @* ]]; then
      [ -n "${entry}" ] && return 0
      continue
    fi

    file="$(builder_line "${entry#@}")"
    [ -e "${file}" ] || continue
    contents="$(cat -- "${file}" 2> /dev/null)" || return 2

    while IFS= read -r line; do
      [ -n "$(builder_line "${line}")" ] && return 0
    done <<< "${contents}"
  done <<< "${builders//;/$'\n'}"

  return 1
}

# Nix sends the job's settings to a remote store's daemon and to each `ssh-ng`
# builder's daemon, which cannot read the runner's directory. A cohort's `nix
# build` evaluates and builds in one process with one set of settings, so the
# substituter cannot be given to evaluation alone.
#
# The cache has no signing key, so Nix accepts a path from it only when the
# narinfo's content address produces the path, and then checks the NAR against
# that address. Do not mark it as trusted: Nix would then accept any narinfo
# from it without a signature.
use() {
  local reason="Nix would send the cache's substituter setting to"

  if [ -n "${STORE}" ]; then
    echo "::notice::The job does not use the flake input cache because store is set. ${reason} the remote store, which cannot read the runner's files."
    return
  fi

  local builders=0
  builders_status || builders=$?

  if [ "${builders}" = 0 ]; then
    echo "::notice::The job does not use the flake input cache because Nix has remote builders. ${reason} each builder, which cannot read the runner's files."
    return
  fi

  # Fail closed: a setting that cannot be read can list builders.
  if [ "${builders}" = 2 ]; then
    echo "::notice::The job does not use the flake input cache because it cannot read Nix's builders setting or a machines file, so Nix can have remote builders. ${reason} each builder, which cannot read the runner's files."
    return
  fi

  printf 'extra-substituters = file://%s?priority=10\n' "${directory}" \
    >> "${RUNNER_TEMP}/cupboard-prepare-nix.conf"
}

case "${1:-}" in
  locate) locate ;;
  restored) restored ;;
  use) use ;;
  *)
    echo "usage: $0 locate|restored|use" >&2
    exit 2
    ;;
esac
