### Tenant access tokens issued before the upgrade are refused

Tenant access tokens now contain the sealed identity that they were issued for,
and the upgraded tenant Worker refuses a tenant access token without it. Access
tokens last at most 15 minutes, so these refusals stop within 15 minutes of the
upgrade.

During that time, a client or CI job with a tenant access token from before the
upgrade has its requests refused. Sign in again with `cupboard login`, or
exchange a new subject token. Run a CI job again if it fails this way.
