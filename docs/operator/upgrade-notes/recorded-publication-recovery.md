# Recorded publication recovery

Upgrade the server before adopting recorded publication sets in the CLI or
cohort actions. The additive tenant migrations provide confirmation receipts and
publication manifests. Existing ordinary publication remains supported; recorded
workflows require negotiated V4 receipts and server capability support.

Preserve unfinished receipt-side recovery files when updating the CLI or action.
New native and cohort journals use version 3 and retain exact capture
checkpoints. Older state is upgraded only when the journal proves that no
capture mutation started. Ambiguous unfinished capture state is rejected; it is
not converted into a fresh capture with newly resolved versions.

The native journal and action capture files use private ownership directories. A
crash can leave a lock directory behind. If an ownership error reports a lock,
verify that the original writer is inactive before removing only that directory.
Keep the receipt, journals and capture files. There is no automatic stale-lock
timeout or process-ID reclamation.

See [How a publication run works][publication-run] for current recovery and
receipt behaviour.

[publication-run]: ../../ci/how-it-works.md
