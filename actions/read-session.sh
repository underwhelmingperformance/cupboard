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
  if [[ -n "$view" ]]; then
    wrapper+=(--reuse-view "$view")
  fi

  "${wrapper[@]}" -- "$@"
}
