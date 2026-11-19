# Garbage collection keeps store paths published during a collection

From this version, a garbage collection keeps every store path that is first
published to the cache while the collection marks or deletes store paths, even
if nothing keeps it. The next garbage collection decides whether to keep it. A
cache whose roots were all removed still keeps its store paths, as before.

The upgrade adds two columns to each tenant's narinfo table and one to its
collection state, and writes no row of the narinfo table. A collection that is
in progress when a tenant upgrades starts its marking again.

## Rolling back

You can't roll back past this release. Once a tenant has upgraded its storage,
an earlier version refuses every request for that tenant, and the tenant stays
unavailable until you deploy this release or a later one again. An earlier
version would treat a store path that this release kept during a collection as
retained, and could then delete the other store paths of a cache whose roots
were all removed.
