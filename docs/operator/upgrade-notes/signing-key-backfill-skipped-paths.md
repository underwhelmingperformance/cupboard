# Signing-key updates report the store paths that they skip

Upgrade the CLI with the server if a tenant may rotate its signing key.

A signing-key rotation now skips a store path whose stored metadata is invalid
or incomplete, and completes without it. The key list then reports the skipped
paths in new fields. An older CLI rejects a response with those fields, so once
a rotation has skipped a path, its `cupboard key list`, `cupboard key status`
and `cupboard key rotate` fail with a response error. `cupboard key rotate`
fails after the server has created the new key, so run `cupboard key status`
with the new CLI to see the result.

The new `cupboard key status` lists the skipped paths and says which of them a
new push can fix. `cupboard key retire` says how many of them the key being
retired signed, because clients need a key that signed a path for as long as
they should accept that path.
