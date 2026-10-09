### Control database split

This upgrade moves control keys, trust rules, operator sessions, consumed
subject nonces, the administrator record and maintenance reports from
`CUPBOARD_DB` to `CONTROL_DB`. Only the control Worker receives the new binding.
The shared store and tenant registry remain in `CUPBOARD_DB`.

Use `cupboard deploy` or `cupboard init`. The command prepares both schemas,
uploads compatible Workers, freezes legacy control mutations, copies the rows in
bounded pages, checks complete source and target contents, and validates wrapped
signing keys with the control Worker's existing wrapping secret. It then
publishes target readiness and removes the old control tables. Preserve
`CONTROL_KEY_WRAP_SECRET`; replacing that secret prevents key validation.

The migration assumes that the legacy database has not been compromised. Key
validation checks the wrapped private material, matching public keys and unique
key IDs. The database contains no authenticated writer history for trust rules,
administrator records or key metadata. If compromise is suspected, establish
independently reviewed authority data before upgrading. The copy cannot identify
a correctly shaped forged authority row.

The cutover is irreversible. Both Workers add an unbound Durable Object class so
Cloudflare refuses dashboard rollback across the release. Before freezing, the
deploy also records the shared `control-database-split` contract marker so older
cupboard deployment tools refuse the database. See [Cloudflare
rollbacks][cloudflare-rollbacks].

[cloudflare-rollbacks]:
  https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/

While the source is frozen and the target is incomplete, control token issuance
and authority mutations return a temporary failure. Existing tenant cache
traffic continues. Refresh families, spent members, retry envelopes, revoked
sessions, disabled trust rules, retired keys and consumed nonces retain their
stored values.

If the command stops, rerun the same deployment with the same database bindings
and deployment URL. The deploy recognises reciprocal source and target markers
and the irreversible contract marker on an unfinished transition. Cloudflare
deployment credentials permit that forward recovery even if the source cannot
renew an administrator token. Normal administrator authentication is required
once the cutover transition is complete. The command installs a temporary
control-only validation secret for its key check and removes that secret
afterwards.

A mismatched target row or invalid key stops the copy before readiness. Preserve
both databases and correct the reported problem, then resume. Do not clear the
source freeze marker, replace target authority from the stale source after
readiness, or deploy a preceding release. A ready target is authoritative and
can already contain newer revocations and sessions.
