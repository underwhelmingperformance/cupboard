#!/usr/bin/env bash

set -euo pipefail

error() {
  echo "::error::$1"
  exit 1
}

# Render one shell word using only POSIX single-quote syntax. Nix applies shell
# splitting to NIX_SSHOPTS, and Git parses GIT_SSH_COMMAND as a shell command.
shell_word() {
  local escaped_quote="'\\''"
  local rest="$1"

  printf "'"
  while [[ "${rest}" == *"'"* ]]; do
    printf '%s%s' "${rest%%\'*}" "${escaped_quote}"
    rest="${rest#*\'}"
  done
  printf "%s'" "${rest}"
}

# OpenSSH config has its own token grammar. Quote paths as one argument and
# escape the two characters that retain special meaning inside double quotes.
openssh_word() {
  local value="$1"

  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "${value}"
}

validate_runner_paths() {
  if [[ "${RUNNER_TEMP}" == *$'\n'* || "${RUNNER_TEMP}" == *$'\r'* ]]; then
    error 'RUNNER_TEMP must not contain line breaks'
  fi
}

configure_input() {
  local config key known_hosts

  validate_input
  validate_runner_paths

  known_hosts="${RUNNER_TEMP}/cupboard_input_known_hosts"
  install -m 600 /dev/null "${known_hosts}"
  printf '%s\n' "${INPUT_KNOWN_HOSTS}" > "${known_hosts}"

  config="${RUNNER_TEMP}/cupboard_input_ssh_config"
  install -m 600 /dev/null "${config}"
  {
    printf 'Host *\n'
    printf '  BatchMode yes\n'
    printf '  StrictHostKeyChecking yes\n'
    printf '  UserKnownHostsFile %s\n' "$(openssh_word "${known_hosts}")"
    printf '  GlobalKnownHostsFile /dev/null\n'
    printf '  KnownHostsCommand none\n'
    if [ -n "${INPUT_SSH_KEY}" ]; then
      key="${RUNNER_TEMP}/cupboard_input_key"
      install -m 600 /dev/null "${key}"
      printf '%s\n' "${INPUT_SSH_KEY}" > "${key}"
      printf '  IdentityFile %s\n' "$(openssh_word "${key}")"
    else
      printf '  IdentityFile none\n'
    fi
    printf '  IdentityAgent none\n'
    printf '  IdentitiesOnly yes\n'
  } >> "${config}"

  printf 'GIT_SSH_COMMAND=ssh -F %s\n' \
    "$(shell_word "${config}")" \
    >> "${GITHUB_ENV}"
}

validate_input() {
  if [ -z "${INPUT_SSH_KEY}" ]; then
    return
  fi

  if [[ ! "${INPUT_KNOWN_HOSTS}" =~ [^[:space:]] ]]; then
    error 'input-known-hosts is required when the private flake input SSH key is supplied'
  fi
}

store_uri_has_host_key() {
  local query parameter
  local -a parameters

  if [[ "${STORE}" != *'?'* ]]; then
    return 1
  fi

  query="${STORE#*\?}"
  query="${query%%#*}"
  IFS='&' read -r -a parameters <<< "${query}"

  for parameter in "${parameters[@]}"; do
    case "${parameter}" in
      base64-ssh-public-host-key=?*)
        return 0
        ;;
      base64-ssh-public-host-key=)
        return 1
        ;;
    esac
  done

  return 1
}

percent_decode() {
  local byte decoded='' encoded="$1" hex

  while [ -n "${encoded}" ]; do
    if [[ "${encoded}" == %??* ]]; then
      hex="${encoded:1:2}"
      if [[ "${hex}" =~ ^[[:xdigit:]]{2}$ ]]; then
        printf -v byte '%b' "\\x${hex}"
        decoded+="${byte}"
        encoded="${encoded:3}"
        continue
      fi
    fi

    decoded+="${encoded:0:1}"
    encoded="${encoded:1}"
  done

  printf '%s' "${decoded}"
}

store_uri_has_ssh_key() {
  local name parameter query value
  local -a parameters

  if [[ "$1" != *'?'* ]]; then
    return 1
  fi

  query="${1#*\?}"
  query="${query%%#*}"
  IFS='&' read -r -a parameters <<< "${query}"

  for parameter in "${parameters[@]}"; do
    if [[ "${parameter}" != *=* ]]; then
      continue
    fi

    name="$(percent_decode "${parameter%%=*}")"
    if [ "${name}" != ssh-key ]; then
      continue
    fi

    value="$(percent_decode "${parameter#*=}")"
    [ -n "${value}" ]
    return
  done

  return 1
}

validate_builder_identities() {
  local entry line ssh_key store_uri
  local -a entries fields

  while IFS= read -r line || [ -n "${line}" ]; do
    line="${line%%#*}"
    IFS=';' read -r -a entries <<< "${line}"

    for entry in "${entries[@]}"; do
      entry="${entry#"${entry%%[![:space:]]*}"}"
      entry="${entry%"${entry##*[![:space:]]}"}"

      if [ -z "${entry}" ]; then
        continue
      fi

      if [[ "${entry}" == @* ]]; then
        error 'builders must be supplied inline rather than through @file so the action can enforce builder-ssh-key identity isolation'
      fi

      read -r -a fields <<< "${entry}"
      store_uri="${fields[0]-}"
      ssh_key="${fields[2]-}"

      if store_uri_has_ssh_key "${store_uri}"; then
        error 'a builder store URI must not set ssh-key; pass the private key through builder-ssh-key'
      fi

      if [ -n "${ssh_key}" ] && [ "${ssh_key}" != - ]; then
        error 'the builders machine SSH-key column must be -; pass the private key through builder-ssh-key'
      fi
    done
  done <<< "${BUILDERS}"
}

validate_caller_ssh_config() {
  local arguments input_name key_input keyword keyword_lower line normalised_arguments
  input_name="$1"
  key_input="$2"

  while IFS= read -r line || [ -n "${line}" ]; do
    line="${line%%#*}"
    line="${line#"${line%%[![:space:]]*}"}"

    if [ -z "${line}" ]; then
      continue
    fi

    keyword="${line%%[[:space:]=]*}"
    arguments="${line#"${keyword}"}"
    arguments="${arguments#"${arguments%%[![:space:]=]*}"}"
    keyword="${keyword//\"/}"
    keyword="${keyword//\'/}"
    keyword_lower="$(printf '%s' "${keyword}" | tr '[:upper:]' '[:lower:]')"

    case "${keyword_lower}" in
      identityfile)
        error "${input_name} must not use IdentityFile; pass the private key through ${key_input}"
        ;;
      identityagent)
        error "${input_name} must not use IdentityAgent; pass the private key through ${key_input}"
        ;;
      certificatefile)
        error "${input_name} must not use CertificateFile; pass the private key through ${key_input}"
        ;;
      pkcs11provider)
        error "${input_name} must not use PKCS11Provider; pass the private key through ${key_input}"
        ;;
      securitykeyprovider)
        error "${input_name} must not use SecurityKeyProvider; pass the private key through ${key_input}"
        ;;
      addkeystoagent)
        error "${input_name} must not use AddKeysToAgent; pass the private key through ${key_input}"
        ;;
      controlmaster)
        error "${input_name} must not use ControlMaster; remove SSH multiplexing directives so Cupboard can close every authenticated connection when the action finishes"
        ;;
      controlpath)
        error "${input_name} must not use ControlPath; remove SSH multiplexing directives so Cupboard can close every authenticated connection when the action finishes"
        ;;
      controlpersist)
        error "${input_name} must not use ControlPersist; remove SSH multiplexing directives so Cupboard can close every authenticated connection when the action finishes"
        ;;
      include)
        error "${input_name} must not use Include because included files can add authentication identities; put non-identity settings directly in ${input_name}"
        ;;
      match)
        # OpenSSH removes quote characters anywhere within a Match criterion,
        # so spellings such as "exec", 'exec' and e"x"e"c" all select the
        # executable criterion. Apply the same normalisation before checking.
        normalised_arguments="${arguments//\"/}"
        normalised_arguments="${normalised_arguments//\'/}"
        if [[ "${normalised_arguments}" =~ (^|[[:space:]])!?[Ee][Xx][Ee][Cc]([[:space:]=]|$) ]]; then
          error "${input_name} must not use Match exec because it can select authentication identities dynamically; use Host or non-exec Match criteria"
        fi
        ;;
    esac
  done <<< "$3"
}

store_uri_uses_default_ssh_port() {
  local authority destination port

  if [[ "${STORE}" != ssh-ng://* ]]; then
    return 1
  fi

  authority="${STORE#ssh-ng://}"
  authority="${authority%%[/?#]*}"
  destination="${authority##*@}"
  port=''

  if [[ "${destination}" == \[*\] ]]; then
    port=''
  elif [[ "${destination}" == \[*\]:* ]]; then
    port="${destination##*]:}"
  elif [[ "${destination}" == *:* ]]; then
    port="${destination##*:}"
  fi

  [ -z "${port}" ] || [ "${port}" = 22 ]
}

validate() {
  if [ "${REMOTE}" != true ] && [ "${REMOTE}" != false ]; then
    error 'remote must be true or false'
  fi

  if [ "${STORE_AMBIENT_IDENTITY}" != true ] && [ "${STORE_AMBIENT_IDENTITY}" != false ]; then
    error 'store-ambient-identity must be true or false'
  fi

  if [[ "${BUILDERS}" == *$'\n'* || "${BUILDERS}" == *$'\r'* ]]; then
    error 'builders must not contain line breaks; separate inline builders with semicolons'
  fi

  if [ "${REMOTE}" = true ] && [ -n "${STORE}" ]; then
    error 'remote and store select different SSH modes and are mutually exclusive'
  fi

  if [ "${REMOTE}" = true ] && [ -z "${BUILDERS}" ]; then
    error 'remote is true but no builders were supplied; set the builders input (and its secrets) or build this group locally'
  fi

  if [ "${REMOTE}" = true ] && [[ ! "${BUILDER_KNOWN_HOSTS}" =~ [^[:space:]] ]]; then
    error 'builder-known-hosts is required when remote builders are enabled'
  fi

  if [ "${REMOTE}" != true ] && [ -n "${BUILDERS}${BUILDER_SSH_KEY}${BUILDER_SSH_CONFIG}${BUILDER_KNOWN_HOSTS}" ]; then
    error 'builder SSH inputs require remote to be true'
  fi

  if [ -z "${STORE}" ] && [ -n "${STORE_SSH_KEY}${STORE_SSH_CONFIG}${STORE_KNOWN_HOSTS}" ]; then
    error 'store SSH inputs require the store input'
  fi

  if [ -z "${STORE}" ] && [ "${STORE_AMBIENT_IDENTITY}" = true ]; then
    error 'store-ambient-identity requires the store input'
  fi

  if [ "${STORE_AMBIENT_IDENTITY}" = true ] && [ -n "${STORE_SSH_KEY}" ]; then
    error 'store-ambient-identity and store-ssh-key select different identity modes and are mutually exclusive'
  fi

  if [ -n "${STORE}" ] && store_uri_has_ssh_key "${STORE}"; then
    error 'the store URI must not set ssh-key; pass the private key through store-ssh-key'
  fi

  if [ "${REMOTE}" = true ]; then
    validate_builder_identities
    validate_caller_ssh_config \
      'builder-ssh-config' \
      'builder-ssh-key' \
      "${BUILDER_SSH_CONFIG}"
  elif [ -n "${STORE}" ]; then
    validate_caller_ssh_config \
      'store-ssh-config' \
      'store-ssh-key' \
      "${STORE_SSH_CONFIG}"
  fi

  if [ -z "${STORE}" ] || [[ "${STORE_KNOWN_HOSTS}" =~ [^[:space:]] ]]; then
    return
  fi

  if ! store_uri_has_host_key; then
    error 'store-known-hosts is required unless the store URI supplies base64-ssh-public-host-key'
  fi

  if ! store_uri_uses_default_ssh_port; then
    error 'store-known-hosts is required for a nonstandard SSH port; URI-only host-key pinning supports only the default SSH port'
  fi
}

configure() {
  local config key known_hosts known_hosts_contents
  local managed_credentials=true

  validate
  validate_runner_paths

  if [ -z "${STORE}" ] && [ "${REMOTE}" != true ]; then
    return
  fi

  config="${RUNNER_TEMP}/cupboard_ssh_config"
  install -m 600 /dev/null "${config}"

  known_hosts="${RUNNER_TEMP}/cupboard_known_hosts"
  if [ -n "${STORE}" ]; then
    known_hosts_contents="${STORE_KNOWN_HOSTS}"
    if [ "${STORE_AMBIENT_IDENTITY}" = true ]; then
      managed_credentials=false
    fi
  else
    known_hosts_contents="${BUILDER_KNOWN_HOSTS}"
  fi

  install -m 600 /dev/null "${known_hosts}"
  if [ -n "${known_hosts_contents}" ]; then
    printf '%s\n' "${known_hosts_contents}" >> "${known_hosts}"
  fi

  {
    printf 'Host *\n'
    printf '  BatchMode yes\n'
    printf '  ServerAliveInterval 60\n'
    printf '  IPQoS throughput\n'
    printf '  StrictHostKeyChecking yes\n'
    printf '  UserKnownHostsFile %s\n' "$(openssh_word "${known_hosts}")"
    printf '  GlobalKnownHostsFile /dev/null\n'
    printf '  KnownHostsCommand none\n'
    if [ -n "${STORE}" ] && [[ ! "${STORE_KNOWN_HOSTS}" =~ [^[:space:]] ]]; then
      # A URI-only host key is keyed as a default-port host by native Nix. Keep
      # later caller config from silently moving that connection to another port.
      printf '  Port 22\n'
    fi
  } >> "${config}"

  if [ "${managed_credentials}" = true ]; then
    if [ -n "${STORE}" ] && [ -n "${STORE_SSH_KEY}" ]; then
      key="${RUNNER_TEMP}/cupboard_store_key"
      install -m 600 /dev/null "${key}"
      printf '%s\n' "${STORE_SSH_KEY}" > "${key}"
      printf '  IdentityFile %s\n' "$(openssh_word "${key}")" >> "${config}"
    elif [ -z "${STORE}" ] && [ -n "${BUILDER_SSH_KEY}" ]; then
      key="${RUNNER_TEMP}/cupboard_builder_key"
      install -m 600 /dev/null "${key}"
      printf '%s\n' "${BUILDER_SSH_KEY}" > "${key}"
      printf '  IdentityFile %s\n' "$(openssh_word "${key}")" >> "${config}"
    else
      printf '  IdentityFile none\n' >> "${config}"
    fi
    printf '  IdentityAgent none\n' >> "${config}"
    printf '  IdentitiesOnly yes\n' >> "${config}"
  fi

  if [ -n "${STORE}" ]; then
    printf '%s\n' "${STORE_SSH_CONFIG}" >> "${config}"
  else
    printf '%s\n' "${BUILDER_SSH_CONFIG}" >> "${config}"
    {
      printf 'builders = %s\n' "${BUILDERS}"
      printf 'builders-use-substitutes = true\n'
    } >> "${RUNNER_TEMP}/cupboard-prepare-nix.conf"
  fi

  {
    printf 'NIX_SSHOPTS='
    if [[ "${known_hosts_contents}" =~ [^[:space:]] ]]; then
      printf '%s ' "$(shell_word "-oUserKnownHostsFile=$(openssh_word "${known_hosts}")")"
    fi
    printf -- '-F %s\n' "$(shell_word "${config}")"
    echo "NIX_USER_CONF_FILES=${RUNNER_TEMP}/cupboard-prepare-nix.conf:${HOME}/.config/nix/nix.conf"
  } >> "${GITHUB_ENV}"
}

case "${1:-}" in
  configure-input)
    configure_input
    ;;
  validate)
    validate
    ;;
  configure)
    configure
    ;;
  *)
    error 'ssh-transport.sh expects configure-input, validate or configure'
    ;;
esac
