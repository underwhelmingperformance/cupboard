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
same grant on the publishing token. Without it, cupboard asks for the bytes, and
publishing that path by reference fails.

cupboard still stores each NAR once.
