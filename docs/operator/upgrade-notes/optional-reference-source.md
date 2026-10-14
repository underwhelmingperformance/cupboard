# Reference sources are read only when permitted

Upgrade the server before updating callers of the flake publication workflow.

The setup action now requests a reference source as an optional read resource.
The read session includes it only when a trust rule permits it. Otherwise the
session reports it as unavailable, and the run builds the outputs that it would
have reused. Earlier servers reject optional read resources, so a run that uses
the new action against an older server fails when it requests one.

This affects branch runs that use trusted-contributor reuse. A branch run no
longer fails when the selected merged PR's cache does not exist, for example
because the PR never published or its closed cache was collected after grace.
Setup warns that it could not read the reference source.

A missing read grant for private PR caches now results in a rebuild instead of a
failed run. `cupboard github check` still reports the missing grant, and its
guided repair adds it.
