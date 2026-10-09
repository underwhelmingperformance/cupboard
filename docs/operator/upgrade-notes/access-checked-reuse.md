### Reuse of stored NARs

A push reuses a NAR that the tenant already stores only if the push can already
read it. A readable reference to the NAR must belong to the destination cache, a
public cache in the tenant, a cache covered by `cache:content-read`, or a cache
in a reuse view covered by `view:content-read`. Earlier releases reused a NAR
that any cache in the tenant referred to.

Some pushes that skipped the upload in earlier releases now upload the bytes.
This happens when only private caches that the push token can't read refer to
the NAR. For example, a pull-request job that pushes to a public pull-request
cache now uploads a path that only a private cache has.

Publishing by reference from a private cache or a private reuse view needs the
same grant on the push token when the source differs from the destination.
`cupboard push` now requests `cache:content-read` or `view:content-read` for
each private source in the same tenant, whether the source is given with
`--reference-source` or in a reference manifest. A token request is all or
nothing, so if the trust rule does not permit the grant, the push gets no token
and reports the refused request with its private sources.

A tenant whose flake publish workflow reuses paths from a private reuse view
must permit `view:content-read` for that view in the trust rule of its branch
runs. This applies whether the workflow reads the view through OIDC or with a
static read credential. `cupboard github check` reports the missing grant, and
its guided repair adds it.

cupboard still stores each NAR once.

Use `cupboard check --shared-access <tenant-url>` to review NARs that public and
private caches both reference. The report requires `check:run` and changes no
publications.
