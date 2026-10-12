# Attestation list lifecycle

Deployment installs `tenant-namespace-cleanup` before the attestation-list
reader transition completes. Refresh jobs and list publication require the
reader transition to be active. Publication checks that state atomically with
the source revision and tenant status. Once revision readers activate, entering
offboarding records an 86-minute cleanup window in `CUPBOARD_DB`. The window
uses the existing late-write horizon and the database clock. Repeating the
offboarding request does not restart it.

The guard persists if an earlier controller purges the tenant's Durable Object.
A database trigger then refuses premature finalisation, and scheduled passes
continue to remove objects under the tenant's R2 prefix. Current controllers
check the guard before purging local storage and preserve tenant metadata while
the window is active. After the window expires, the normal drain and object
checks still decide whether finalisation can proceed.

An offboarding tenant can therefore remain in that state after its reference
rows and visible objects have been removed. Continue scheduled maintenance.
Native multipart completion can create an object after an earlier prefix sweep;
a subsequent pass removes that object before finalisation. The guard remains
with the terminal tenant record, and the tenant slug cannot be reused.

Tenant teardown also removes attestation-list revisions and local refresh state
in bounded passes. Each published list key is recorded for cleanup before its
revision row is deleted. A failed pass can retry without losing the key. The
scheduler can recover revision cleanup after an earlier controller has purged
local storage. Finalisation and provisioning checks include revision residue,
and a database trigger prevents older controllers from completing offboarding
while revisions remain.

Run `cupboard deploy` to reconcile the bucket lifecycle configuration before
activating revision readers. Deployment installs an abort-only rule for
incomplete multipart uploads under `t/`, with an age of one day. This rule
reclaims abandoned uploads whose creation succeeded after a timeout without
returning an upload ID. Completed list objects continue to follow the normal
cleanup lifecycle, and the 86-minute tenant finalisation guard remains in place.
Deployment refuses to upload the Workers if lifecycle reconciliation fails.

Cache teardown retains its durable marker until list revisions and local refresh
state have drained. Each pass retires a bounded page and preserves publications
and active jobs from a later cache generation, including a cache recreated with
the same name. Uncertain multipart completions retain their cleanup deadline.
