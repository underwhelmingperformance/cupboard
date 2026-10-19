### Read-only planning and idempotent publication

Upgrade the deployment before adopting the new client protocol. The tenant
schema adds `publication_operation` and a recovery deadline on pending uploads.
Existing pending uploads and attestation operations continue with their existing
protocol. New clients select `publication-v1` only when both the credential
response and the commit handshake advertise support.

Run deployment with the new CLI so the bucket has both managed lifecycle rules
before the new Workers advertise the capability:

- Preserve `cupboard-staging-reclaim` for `staging/`: completed objects and
  incomplete multipart uploads expire after one day.
- Install `cupboard-publication-staging-reclaim` for `staging-v2/`: completed
  objects expire after seven days, and incomplete multipart uploads are aborted
  after 48 hours.

Deployment preserves unrelated rules and refuses incompatible overlapping rules.
If deployment reports a conflicting rule, change that rule before retrying.
[Object lifecycle rules][lifecycles] apply independently of application state;
the recovery bound does not assume that deletion happens after the eligibility
time.

[lifecycles]: https://developers.cloudflare.com/r2/buckets/object-lifecycles/

Each new publication can recover for 24 hours after its first accepted commit.
Retries and suspension do not extend this deadline. A commit near the end of a
24-hour push lease therefore completes or expires within about 48 hours of the
first staging write. The seven-day lifecycle expiry leaves five days of margin.
Completed canonical objects remain subject to ordinary retention.

An unfinished operation that reaches its recovery deadline returns temporary
failure status 75 with instructions to start a fresh push. A completed replay
can repair missing bytes only within the original push lease and recovery
window. Credential issuance and planning no longer create named caches; first
commit creates the cache and resolves retention policy.

A first accepted publication captures grace even when the path is already
served. An operation that confirms an already-served path can extend its
retention to the confirmation time plus grace. Replaying the same operation does
not extend that deadline. Legacy skips leave the existing deadline unchanged.

Streamed builds and reconciliation now compare every commit result with the
build's NAR hash, including results from legacy servers. If a concurrent writer
published different contents for the same store path, the client reports
`BuildOutputDivergedError` and excludes that path from the successful build
receipt.

Before release, validate capability selection, reconnect diagnostics and
publication on a hosted runner. Release publication, deployment and adoption by
consumer repositories remain separate steps.
