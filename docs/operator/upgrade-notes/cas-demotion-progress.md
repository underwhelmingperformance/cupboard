# CAS demotion progress

This release adds shared D1 progress for cleanup of missing CAS objects and a
covering digest/tenant index. Deployment expands `cas-demotion-progress` after
the `cas-storage` transition has contracted. The new cleanup waits for its
storage transition to expand before changing references or scan hints.

An upgrade from a release that has not completed `cas-storage` needs an
intermediate release that completes that transition and does not include
`cas-demotion-progress`. Deploy the intermediate release and complete its tenant
migration before deploying this release. The deploy command refuses the direct
upgrade and reports the incomplete prerequisite.

The KV scan cursor remains a discovery hint. Once a missing object is
discovered, D1 records its physical incarnation and tenant cursor. Active work
continues after a Worker restart or a KV cursor change. A failed tenant remains
eligible for a later pass while other tenants progress. Final reference and
incarnation checks still decide whether metadata can be removed.

There is no manual cursor conversion. Existing missing objects are discovered
through the normal scan. This change bounds global tenant discovery; tenant
reference removal and attestation-list refresh are subsequent work, and native
artifact publication remains disabled.
