# Intermediate deployment fixture

`artifact.json.br` contains the control and tenant Workers from revision
`6d9d4ac906e8047c25966acf1e83d9796099c0d4`, before the path read authority
transition. It also contains that revision's D1 migrations and schema transition
declarations. The build version is `6d9d4ac906e8`.

The staged deployment tests first complete cache identity with these Workers,
then deploy the current Workers over the same D1, Durable Object and R2 storage.
The tests also check that a direct upgrade refuses incomplete cache identity.
The fixture loader verifies SHA-256
`13b8be056d8b2ae1a4e525ffea7caeab81140b2c11c2ca894ba7e692b2c5c684` before
decoding the artifact. Tests require neither Git history nor a download.

The fixture was generated from a local export of the pinned revision, with its
workspace package imports resolved to that export and its locked dependencies.
The production [artifact builder] and [Worker bundler] produced the payload,
using esbuild 0.28.1 and `CUPBOARD_BUILD_VERSION=6d9d4ac906e8`. The exported
`schemaTransitions` array was included beside the payload. The resulting
`JSON.stringify({ payload, transitions })` bytes were compressed with Node's
`brotliCompressSync` with quality 11 and a 24-bit window. The compressed file
contains 472,160 bytes.

[artifact builder]: ../../../packages/cli/src/deploy/artifact.ts
[Worker bundler]: ../../../packages/cli/src/deploy/bundle.ts
