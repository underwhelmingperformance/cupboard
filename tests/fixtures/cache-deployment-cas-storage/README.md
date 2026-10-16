# CAS storage deployment fixture

The fixture contains the control and tenant Workers from revision
`6b532f66d05effbcf73eb13c5a339a8b20ffc2cc`, with tree
`e1b0c73b6f149cfdab6986b36bca1e120518c5b9`. This revision includes CAS storage
and its local migration step, but predates `cas-demotion-progress`. The build
version is `6b532f66d05e`.

The staged upgrade tests deploy these Workers after the path read authority
release. They complete the tenant CAS migration and contract shared CAS storage
before preparing the current release. A transition record alone does not replace
that deployment.

The loader checks each compressed file before decoding:

| File                   |   Bytes | SHA-256                                                            |
| ---------------------- | ------: | ------------------------------------------------------------------ |
| `control-worker.js.br` | 356,185 | `64290c794dc79d94f509196f5f7fb5c2b18fb10525fa3a4336c9a087a26ef26e` |
| `tenant-worker.js.br`  | 478,290 | `a1ad9330bd6137638e1f825846d03a21e5028b335cd61b9609d5d2826acb9984` |
| `artifact.json.br`     |  11,941 | `f5011208e4b14e069d4f101858f1452cb9a9d6f7da584a62367d9169801d0581` |

`artifact.json.br` contains configuration, bundle entrypoints, migration sets
and the original schema transitions. The other files contain the original Worker
bundles. Tests require neither Git history nor network access.

The fixture was generated from a Git archive of the pinned revision. Workspace
imports resolved within that export, with the pinned dependencies. The
production [artifact builder] and [Worker bundler] produced the payload with
esbuild 0.28.2 and `CUPBOARD_BUILD_VERSION=6b532f66d05e`. Worker code was
compressed separately from `JSON.stringify({ payload, transitions })` metadata
with Node Brotli quality 11 and a 24-bit window.

The decompressed Worker SHA-256 digests are
`643197e97069cad570cacc86c1179b6c0c743b63183a2626f0a49f2e6c73a0e8` (control) and
`52657f4a98726265537ac9fbe1bd4e5428e3167ff4ec8f6d636376dd8cfb37a2` (tenant).

[artifact builder]: ../../../packages/cli/src/deploy/artifact.ts
[Worker bundler]: ../../../packages/cli/src/deploy/bundle.ts
