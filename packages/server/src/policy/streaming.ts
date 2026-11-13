import { probeDeadlineMs } from '@cupboard/shared/timeout';

/**
The deadline for one read of a narinfo or an attestation, shared by the
reads that select the object and the response body.

A stalled read must end before the client's own attempt deadline. Workers
Cache joins concurrent requests for one URL to a single fill, so a client
whose retry arrived while the fill was still running would wait for the same
stalled fill. The margin covers the network between the client and the edge
and, for a public cache, a quick admission in the control Worker, which runs
before the tenant Worker's deadline starts. A slow admission can use more than
the margin.
*/
export const readRequestBudgetMs = probeDeadlineMs - 10_000;

/**
The deadline for the tenant object to return the response headers of a
forwarded write or admin request when its work is bounded in time: a token
exchange or revocation, the commit WebSocket upgrade, or a tenant procedure
with the `workBound` of `time` in the contract, such as closing a cache.

The slowest such requests take about 70 seconds in the worst case. Closing a
cache or rotating an auth key runs one critical section of 25 seconds, then
the maintenance reconcile, whose three D1 calls are capped at 15 seconds
each. A token exchange fetches issuer metadata and keys with timeouts of 15
seconds and twice 5 seconds, then runs the same reconcile. The 40-second
margin covers waiting behind one critical section of another request. A
request that waits behind a longer queue of critical sections can miss the
deadline while the object is healthy, and the object can then still complete
it. The deadline does not cover the response body or an upgraded WebSocket.
*/
export const tenantOperationBudgetMs = 110_000;

/**
The least time that must remain of the read's deadline when a bounded body
starts. A read with less time left is refused with a retryable 503 before its
headers. A narinfo, attestation list or bundle is typically a few KiB, and one
second is far more than such a body needs once R2 has returned it, so the
floor refuses only reads whose earlier steps used almost the whole deadline.
*/
export const minimumBodyBudgetMs = 1000;
