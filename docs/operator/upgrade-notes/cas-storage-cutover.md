### CAS storage cutover

This upgrade moves physical CAS state and tenant presence to
`cas_object_storage` and `tenant_cas_blob_storage`. The former table identifiers
become read-only compatibility views. Object digests, incarnations, sizes,
retention deadlines and tenant charges remain unchanged.

Use `cupboard deploy` or `cupboard init`. Expansion creates writable views for
the new build while earlier Workers continue to use the physical tables. On an
existing deployment, the command uploads both compatible Workers and waits for
every active or suspended tenant to record local step 6 before contracting the
schema. Step 6 confirms that the tenant object uses the new CAS interface.

The contract migration runs atomically. An earlier collection or quota batch
that attempts to write through a compatibility view fails and rolls back,
including any registry retirement, deletion outbox insertion or quota credit in
that batch. Earlier requests can therefore fail during the cutover and must
retry against the new build.

Both Workers export an unbound Durable Object class that prevents Cloudflare
dashboard rollback across this upgrade. Earlier cupboard deployment tools also
refuse the database once its new transition has contracted. Preserve the
database and deployment bindings and rerun the same deployment if the command
stops. Recovery proceeds forwards; do not restore earlier cleanup code after the
cutover.
