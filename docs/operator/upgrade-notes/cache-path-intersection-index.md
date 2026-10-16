### Cache path intersection index

The bulk path intersection query adds a covering index to the physical
`blob_ref_storage` table. The `blob-reference-read-authority` transition must be
complete before the deploy can create this index. While that transition is
expanded, `blob_ref_storage` is a compatibility view and cannot be indexed.

If the deploy reports this prerequisite, deploy v0.0.44 first and allow its path
read authority contract to complete. Then deploy this release. Deployments that
already completed the transition can upgrade directly. Use `cupboard deploy` or
`cupboard init` so both released Workers serve before the contract removes the
preceding schema. Do not apply the contract SQL manually while a preceding
Worker still serves traffic.
