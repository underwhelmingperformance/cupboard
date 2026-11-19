import {
	cacheScopeSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import { buildInputsVersionSchema } from './build-inputs.ts';

// The most hashes that one dependency-status request may contain. The tenant
// object answers a larger request with `UPLOAD_REQUEST_LIMIT_EXCEEDED` and
// HTTP 413 before it reads any narinfo or cache rows.
export const dependencyStatusMaxPaths = 1024;

// In compact JSON, a full page is the 22-byte `{"storePathHashes":[]}`, 34
// bytes for each quoted 32-character hash, and a comma between hashes. The
// limit is twice that, so a client may also send whitespace.
export const dependencyStatusMaxRequestBytes =
	2 * (22 + 35 * dependencyStatusMaxPaths - 1);

// A `.max` here would answer a larger request with a 400 validation error.
// Clients expect the typed 413 that the tenant object returns.
export const dependencyStatusRequestSchema = z.strictObject({
	storePathHashes: z.array(storePathHashSchema)
});

/**
The state of one dependency output in the destination cache.

- `absent`: the cache has no narinfo row for the path. `source`, when
  present, is another live cache of the tenant. It has a committed row for
  the path, and the caller's token may reuse NARs from it. A private cache
  is a source only for a private destination. A destination that does not
  exist has the access that a write would create it with. The lookup
  considers only the first 16 caches in identity order that the token may
  reuse from, so a missing `source` does not mean that no cache has the
  path. The source is a hint: the commit of a copy decides again whether the
  token may reuse the NAR.
- `in-flight`: an upload of the path into the cache is pending or
  committing, whether or not it has reserved its narinfo row.
- `present`: the cache has a committed row without recorded build inputs.
- `recorded`: the cache has a committed row with build inputs recorded by
  the client algorithm `buildInputsVersion`.
*/
const dependencyStatusEntrySchema = z.discriminatedUnion('state', [
	z.strictObject({
		storePathHash: storePathHashSchema,
		state: z.literal('absent'),
		source: cacheScopeSchema.optional()
	}),
	z.strictObject({
		storePathHash: storePathHashSchema,
		state: z.literal('in-flight')
	}),
	z.strictObject({
		storePathHash: storePathHashSchema,
		state: z.literal('present')
	}),
	z.strictObject({
		storePathHash: storePathHashSchema,
		state: z.literal('recorded'),
		buildInputsVersion: buildInputsVersionSchema
	})
]);
export type DependencyStatusEntry = z.output<
	typeof dependencyStatusEntrySchema
>;

/**
One entry for each requested hash, in request order.
*/
export const dependencyStatusResponseSchema = z.strictObject({
	paths: z.array(dependencyStatusEntrySchema).max(dependencyStatusMaxPaths)
});
export type DependencyStatusResponse = z.output<
	typeof dependencyStatusResponseSchema
>;
