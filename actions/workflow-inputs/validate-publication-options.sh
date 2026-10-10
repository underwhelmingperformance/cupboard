case "${BUILD}" in
  missing|rebuild) ;;
  *) echo '::error::build must be missing or rebuild'; exit 1 ;;
esac
case "${SUBSTITUTER}" in
  leave|copy) ;;
  *) echo '::error::substituter must be leave or copy'; exit 1 ;;
esac
case "${ATTEST}" in
  true|false) ;;
  *) echo '::error::attest must be true or false'; exit 1 ;;
esac
