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
The least time that must remain of the read's deadline when a bounded body
starts. A read with less time left is refused with a retryable 503 before its
headers. A narinfo, attestation list or bundle is typically a few KiB, and one
second is far more than such a body needs once R2 has returned it, so the
floor refuses only reads whose earlier steps used almost the whole deadline.
*/
export const minimumBodyBudgetMs = 1000;
