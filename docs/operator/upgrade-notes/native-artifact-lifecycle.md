# Native artifact lifecycle readiness

This upgrade adds the `native-artifact-publication` deployment transition. CAS
references for listings, logs, traces and generation proofs require compatible
quota, collection and retirement code in both Workers. The storage expansion
alone does not enable reference reservation.

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
