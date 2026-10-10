set -euo pipefail
case "${BUILD}" in
  missing|rebuild) ;;
  *) echo '::error::build must be missing or rebuild'; exit 1 ;;
esac
case "${SUBSTITUTER}" in
  leave|copy) ;;
  *) echo '::error::substituter must be leave or copy'; exit 1 ;;
esac
case "${PUBLISH}" in
  none|outputs|built|closure) ;;
  *) echo '::error::publish must be none, outputs, built, or closure'; exit 1 ;;
esac
case "${ATTEST}" in
  true|false) ;;
  *) echo '::error::attest must be true or false'; exit 1 ;;
esac
case "${PUSH}" in
  true) ;;
  false) PUBLISH=none ;;
  *) echo '::error::push must be true or false'; exit 1 ;;
esac
for pair in READ FALLBACK_READ DESTINATION_READ; do
  user="${pair}_USER"
  password="${pair}_PASSWORD"
  if [ -n "${!user}" ] && [ -n "${!password}" ]; then
    continue
  fi
  if [ -n "${!user}${!password}" ]; then
    label="$(printf '%s' "${pair}" | tr '[:upper:]' '[:lower:]')"
    echo "::error::${label}_user and ${label}_password must be supplied together"
    exit 1
  fi
done
if [ -n "${READ_USER}" ] && [ -n "${FALLBACK_READ_USER}" ] &&
   { [ "${READ_USER}" != "${FALLBACK_READ_USER}" ] ||
     [ "${READ_PASSWORD}" != "${FALLBACK_READ_PASSWORD}" ]; }; then
  echo '::error::read_user/read_password and fallback_read_user/fallback_read_password must match when both are supplied'
  exit 1
fi
if [ -n "${FALLBACK_READ_USER}" ]; then
  echo '::warning::fallback_read_user is deprecated. Use read_user.'
fi
if [ -n "${FALLBACK_READ_PASSWORD}" ]; then
  echo '::warning::fallback_read_password is deprecated. Use read_password.'
fi
for name in URL PRESET CACHE ROOT_PREFIX TTL REUSE_VIEW BRANCH CACHE_ACCESS_MODE; do
  if [[ "${!name}" == *$'\n'* || "${!name}" == *$'\r'* ]]; then
    echo "::error::${name} must not contain line breaks"
    exit 1
  fi
done
if [[ "${BUILDERS}" == *$'\n'* || "${BUILDERS}" == *$'\r'* ]]; then
  echo '::error::builders must not contain line breaks; separate inline builders with semicolons'
  exit 1
fi
if [ -n "${STORE}" ] && [ -n "${BUILDERS}" ]; then
  echo '::error::store and builders select different build modes and are mutually exclusive'
  exit 1
fi
case "${CACHE_ACCESS_MODE}" in
  ''|public|private) ;;
  *)
    echo '::error::cache-access-mode must be public or private'
    exit 1
    ;;
esac
if [ "${STORE_AMBIENT_IDENTITY}" = true ] && [ -z "${STORE}" ]; then
  echo '::error::store-ambient-identity requires the store input'
  exit 1
fi
if [ -n "${BUILDERS}" ] && [[ ! "${BUILDER_KNOWN_HOSTS}" =~ [^[:space:]] ]]; then
  echo '::error::builder-known-hosts is required when builders are enabled'
  exit 1
fi

store_uri_has_host_key=false
if [[ "${STORE}" == *'?'* ]]; then
  store_query="${STORE#*\?}"
  store_query="${store_query%%#*}"
  IFS='&' read -r -a store_parameters <<< "${store_query}"
  for parameter in "${store_parameters[@]}"; do
    case "${parameter}" in
      base64-ssh-public-host-key=?*)
        store_uri_has_host_key=true
        break
        ;;
      base64-ssh-public-host-key=)
        break
        ;;
    esac
  done
fi

store_uri_uses_default_ssh_port=false
if [[ "${STORE}" == ssh-ng://* ]]; then
  store_authority="${STORE#ssh-ng://}"
  store_authority="${store_authority%%[/?#]*}"
  store_destination="${store_authority##*@}"
  store_port=''
  if [[ "${store_destination}" == \[*\] ]]; then
    store_port=''
  elif [[ "${store_destination}" == \[*\]:* ]]; then
    store_port="${store_destination##*]:}"
  elif [[ "${store_destination}" == *:* ]]; then
    store_port="${store_destination##*:}"
  fi
  if [ -z "${store_port}" ] || [ "${store_port}" = 22 ]; then
    store_uri_uses_default_ssh_port=true
  fi
fi

if [ -n "${STORE}" ] && [[ ! "${STORE_KNOWN_HOSTS}" =~ [^[:space:]] ]]; then
  if [ "${store_uri_has_host_key}" != true ]; then
    echo '::error::store-known-hosts is required unless the store URI supplies base64-ssh-public-host-key'
    exit 1
  fi
  if [ "${store_uri_uses_default_ssh_port}" != true ]; then
    echo '::error::store-known-hosts is required for a nonstandard SSH port; URI-only host-key pinning supports only the default SSH port'
    exit 1
  fi
fi
REFERENCE_SOURCE=''
if [ -n "${MERGED_PULL_REQUEST}" ] && [[ ! "${MERGED_PULL_REQUEST}" =~ ^[1-9][0-9]*$ ]]; then
  echo '::error::merged-pull-request must be a positive pull request number'
  exit 1
fi
case "${PRESET}" in
  '')
    if [ -z "${ROOT_PREFIX}" ]; then
      echo '::error::root-prefix is required when no preset derives it'
      exit 1
    fi
    ;;
  pull-request-and-branch)
    if [ -n "${CACHE}${ROOT_PREFIX}${TTL}" ] || [ "${PERMANENT}" = true ]; then
      echo '::error::preset is mutually exclusive with cache, root-prefix, ttl and permanent'
      exit 1
    fi
    if [ "${EVENT_NAME}" = pull_request ]; then
      if [ -z "${HEAD_REPOSITORY_ID}" ] || [ "${HEAD_REPOSITORY_ID}" != "${REPOSITORY_ID}" ]; then
        echo "::error::pull-request publication accepts only pull requests from this repository; guard the job with github.event.pull_request.head.repo.id == github.repository_id"
        exit 1
      fi
      pr_cache="gh-${REPOSITORY_ID}-pr-${PR_NUMBER}"
      TTL=14d
      PERMANENT=false
      if [ "${PUBLISH}" != none ]; then
        CACHE="${pr_cache}"
        PROVISION_CACHE="${CACHE}"
        if [ "${EVENT_ACTION}" = closed ]; then
          CLOSE_CACHE="${CACHE}"
        fi
      fi
      REFERENCE_SOURCE="${URL%/}"
      REUSE_VIEW=''
      # Match pullRequestRootTemplate in packages/cli.
      ROOT_PREFIX="github:${REPOSITORY}/pr-${PR_NUMBER}"
    elif [ "${REF}" = "refs/heads/${BRANCH}" ]; then
      ROOT_PREFIX="github:${REPOSITORY}/${BRANCH}"
      PERMANENT=true
      REUSE_VIEW=''
      if [ -n "${MERGED_PULL_REQUEST}" ]; then
        REFERENCE_SOURCE="${URL%/}/cache/gh-${REPOSITORY_ID}-pr-${MERGED_PULL_REQUEST}"
      fi
    else
      echo "::error::preset 'pull-request-and-branch' accepts pull_request runs or refs/heads/${BRANCH}; got event '${EVENT_NAME}' on '${REF}'"
      exit 1
    fi
    ;;
  *)
    echo "::error::unknown preset '${PRESET}'"
    exit 1
    ;;
esac
DESTINATION_ACCESS_MODE="${CACHE_ACCESS_MODE}"
if [ -n "${PRESET}" ] &&
   { [ "${EVENT_NAME}" != pull_request ] || [ "${PUBLISH}" = none ]; }; then
  DESTINATION_ACCESS_MODE=''
fi
{
  echo "publish=${PUBLISH}"
  echo "cache=${CACHE}"
  echo "cache-access-mode=${DESTINATION_ACCESS_MODE}"
  echo "root-prefix=${ROOT_PREFIX}"
  echo "ttl=${TTL}"
  echo "permanent=${PERMANENT}"
  echo "reuse-view=${REUSE_VIEW}"
  echo "reference-source=${REFERENCE_SOURCE}"
  echo "provision-cache=${PROVISION_CACHE:-}"
  echo "provision-cache-ttl=${TTL}"
  echo "close-cache=${CLOSE_CACHE:-}"
} >> "${GITHUB_OUTPUT}"
