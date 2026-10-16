# Path read authority deployment fixture

The fixture contains the control and tenant Workers from released v0.0.44,
revision `5e7629f3e813707739e994278ce479b6f1952abd`, with tree
`3e7bee2c3dfe9d6968f03eb92bfad58a3ede0e94`. The payload includes the D1
migration sets and schema transitions from that revision. The build version is
`5e7629f3e813`.

The staged deployment tests complete cache identity with the earlier
intermediate Workers, deploy these released Workers and complete path read
authority before preparing the current cache intersection index. Both released
Workers must serve before their contract migrations run.

The fixture loader checks each compressed file's SHA-256 before decoding:

| File                   |   Bytes | SHA-256                                                            |
| ---------------------- | ------: | ------------------------------------------------------------------ |
| `artifact.json.br`     |  11,113 | `025038611a16dd6708846b429ec8bd0764c051d69a87a5a84c55f1394cd0a2da` |
| `control-worker.js.br` | 350,226 | `2b739edcb4b1c5592ee8a69fc4e37f0f9f81dc462d7335b1b61e2ee90da06a7e` |
| `tenant-worker.js.br`  | 473,635 | `2aeca8b121ba67df436fe0bc1c04642baae06774698fa15c988be49d35d26d66` |

`artifact.json.br` contains the payload's configuration, bundle entrypoints,
migrations and transitions. The two Worker files contain the original bundle
code. Tests require neither Git history nor a download.

The fixture was generated from a Git archive of the pinned revision. Workspace
imports resolved inside that export, with its frozen lockfile and dependencies.
The production [artifact builder] and [Worker bundler] produced the payload,
using esbuild 0.28.2 and `CUPBOARD_BUILD_VERSION=5e7629f3e813`. The exported
`schemaTransitions` array was included beside the payload. Each Worker bundle
and the remaining `JSON.stringify({ payload, transitions })` metadata were
compressed with Node's `brotliCompressSync` with quality 11 and a 24-bit window.
The reconstructed payload and transitions match the original released build byte
for byte. The decompressed Worker SHA-256 digests are
`d154da2ee1a4125db292f7a78bbfad474b38860065d42c57aa63059a7da7ef66` (control) and
`e1d0a6a1b571c054346cda8d4c275305c58f51d4722d1e74a22516d9446cc465` (tenant).

[artifact builder]: ../../../packages/cli/src/deploy/artifact.ts
[Worker bundler]: ../../../packages/cli/src/deploy/bundle.ts
