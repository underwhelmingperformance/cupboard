# Security

See [SECURITY.md](../SECURITY.md) for how to report a vulnerability and which
releases get security fixes.

The rest of cupboard's security documentation sits with the features it covers:

- [docs/trust-rules.md](./trust-rules.md): how a CI push authenticates, and how
  to pin a trust rule to a repository, workflow and ref.
- [docs/runner-provenance.md](./runner-provenance.md): what runner labels do and
  don't prove, and what self-hosted runners should enforce.
- [docs/nix.md](./nix.md#what-a-private-cache-protects): what a private cache's
  read credential protects.
- [docs/deploying.md](./deploying.md#cache-read-credentials): how read
  credentials are removed when a cache is deleted.
