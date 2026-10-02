run_with_read_session() {
  local cupboard_path="$1"
  local target="$2"
  local view="$3"
  shift 3
  if [[ "${1:-}" == -- ]]; then
    shift
  fi

  if [[ -z "$target" ]]; then
    "$@"
    return
  fi

  if [[ -z "$cupboard_path" ]]; then
    echo '::error::cupboard-path is required for private OIDC reads' >&2
    return 1
  fi

  local -a wrapper=("$cupboard_path" run "$target" --github-oidc)
  local audience
  audience=$(node -e 'process.stdout.write((process.env.READ_SESSION_AUDIENCE || "").trim())') || return
  if [[ -n "$audience" ]]; then
    wrapper+=(--audience "$audience")
  fi
  local cache_lines
  cache_lines=$(node -e 'const urls = JSON.parse(process.env.READ_SESSION_CACHES || "[]"); if (!Array.isArray(urls) || urls.some(url => typeof url !== "string" || /[\r\n]/.test(url))) throw new Error("read-session-caches must be a JSON array of cache URLs"); for (const url of urls) console.log(url)') || return
  local cache_url
  while IFS= read -r cache_url; do
    if [[ -n "$cache_url" ]]; then
      wrapper+=(--read-cache "$cache_url")
    fi
  done <<< "$cache_lines"
  if [[ -n "$view" ]]; then
    wrapper+=(--reuse-view "$view")
  fi

  "${wrapper[@]}" -- "$@"
}
