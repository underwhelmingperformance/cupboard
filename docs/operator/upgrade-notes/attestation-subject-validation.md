# Internal attestation signing destination context

Callers of the internal `attest-sign` action command must now supply `--url`
with the destination tenant URL, and `--cache` when signing for a named cache.
Pass private read credentials with `--read-user` and the `READ_PASSWORD`
environment variable, or run the command inside the renewable OIDC read-session
wrapper. The public `actions/attest` composite action supplies this context;
callers of that action need no new inputs.

Destination validation now runs after statement subject selection and before any
signing or upload. Default provenance checks only runner-local built subjects;
generated reproduction statements also check candidates with matching NAR bytes.
Supplied custom predicates check every selected subject. The resolver still
writes all named receipt candidates, but no longer validates unused candidates
against destination narinfos. Do not treat its candidate checksums as proof of
destination availability.

Version 2 receipts retain their named build subjects; path-only entries stay
excluded. A legacy custom checksum file without a receipt lacks the store
directory, so signing checks the selected narinfo's basename and NAR hash rather
than guessing the directory. Checksum names must be store-path basenames.

The publication workflows no longer audit stored evidence across the whole
receipt. Their reports describe current-run signing and attachment. Run
`cupboard attest status` explicitly when a stored-evidence inventory is needed.
