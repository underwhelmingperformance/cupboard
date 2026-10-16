# Native artifact lifecycle readiness

This upgrade adds the `native-artifact-publication` deployment transition. CAS
references for listings, logs, traces and generation proofs require compatible
quota, collection and retirement code in both Workers. The storage expansion
alone does not enable reference reservation.

The additive `shared-listing-generation` transition installs the D1 table for
cross-tenant computation claims. Expansion does not start generation or enable
native artifact producers.

The additive `shared-listing-staging` transition records provisional global
listing resources separately from tenant staging. Expansion does not start
global generation.

The additive `forward-listing-staging` transition creates an empty D1 table for
provisional captures owned by native verification attempts. Sealed records can
transfer to shared staging under a current retained-source computation claim.
Expansion leaves producers disabled and does not enqueue forward work. The
migration adds the table and its indexes without rewriting existing staging.

The additive `listing-adoption-parents` transition creates an empty index of
current cache-publication candidates. Its contract installs point cleanup for
source deletion, replacement and revocation, plus a tenant-finalisation guard.
Projection refresh waits for the completed contract and capture readiness.
Offboarding drains orphaned projection rows before finalisation. Expansion does
not scan the existing reference catalogue or publish artifacts into a cache.

The additive `listing-adoption-parent-seed` transition creates an empty table
for historical checkpoints, with independent windows for default and named
caches. The first seed turn initialises a window only after the parent cleanup
contract and capture are ready. Expansion does not start historical discovery or
adoption delivery.

The additive `listing-adoption-seed-dispatch` transition creates an empty table
for the three seed scopes. It adds recoverable delivery deadlines and execution
leases. Expansion does not enqueue seed work. After the compatible Worker is
uploaded, cron starts bounded historical seeding when each source contract and
capture are ready. Queue consumers acquire fresh claims for independent fact,
default-parent and named-parent pages. Failed sends and abandoned claims recover
through their persisted deadlines. This metadata work does not grant cache read
authority or activate artifact publication.

The additive `listing-adoption-work` transition creates empty capture-consumer
and expansion-work tables. Each input page can be copied and acknowledged in one
bounded transaction. Work payloads remain available after event pruning.
Expansion does not scan historical data or activate this consumer. Source
fan-out and authoritative adoption delivery remain pending.

Deployment also reconciles bucket lifecycle rules for `artifact-staging/` and
`shared-artifact-staging/`. The rules delete transient objects and abort
incomplete multipart uploads after a day. CAS bytes and completed tenant
publications use their existing retention rules. R2 applies lifecycle cleanup
asynchronously.

Use `cupboard deploy` or `cupboard init`. The command expands the transition,
uploads both Workers and confirms that both Workers serve the uploaded build.
Every active or suspended tenant must then record local step 8 before the
transition completes. Step 8 confirms that the tenant has initialised its local
schema, completed historical attestation-list initialisation and activated path
read authority. Offboarding tenants do not prevent activation.

While activation is pending, artifact reference reservation returns a retryable
error. Existing artifact retirement can still remove references and release the
final tenant charge. Reservation batches recheck activation together with cache
generation and physical incarnation, so a readiness change cannot leave partial
reference or quota writes. Native artifact producers remain disabled.

Both Workers export an unbound Durable Object class that prevents Cloudflare
[version rollback] across this upgrade. The class lifecycle changes when the
Workers are uploaded, even if tenant readiness has not completed. Preserve the
database and deployment bindings and rerun the same deployment if the command
stops. Recovery proceeds forwards; do not restore earlier cleanup code.

[version rollback]:
  https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/
