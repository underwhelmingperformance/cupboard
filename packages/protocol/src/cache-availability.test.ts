import { describe, expect, it } from 'vitest';

import {
	cacheAvailabilityMaxPaths,
	cacheAvailabilityRequestSchema,
	cacheAvailabilityResponseSchema,
	reuseViewAvailabilityMaxPaths,
	reuseViewAvailabilityRequestSchema
} from './cache-availability.ts';

const storePathHash = '1'.repeat(32);

describe('cache availability protocol', () => {
	it('accepts 900 requested and missing hashes', () => {
		const request = {
			storePathHashes: Array.from(
				{ length: cacheAvailabilityMaxPaths },
				() => storePathHash
			)
		};
		const response = {
			missingStorePathHashes: Array.from(
				{ length: cacheAvailabilityMaxPaths },
				() => storePathHash
			)
		};

		expect({
			request: cacheAvailabilityRequestSchema.safeParse(request).success,
			response: cacheAvailabilityResponseSchema.safeParse(response).success
		}).toStrictEqual({ request: true, response: true });
	});

	it('rejects more than 900 requested hashes', () => {
		const request = {
			storePathHashes: Array.from(
				{ length: cacheAvailabilityMaxPaths + 1 },
				() => storePathHash
			)
		};

		expect(cacheAvailabilityRequestSchema.safeParse(request).success).toBe(
			false
		);
	});

	it('accepts 50 reuse-view hashes and rejects 51', () => {
		const bounded = {
			storePathHashes: Array.from(
				{ length: reuseViewAvailabilityMaxPaths },
				() => storePathHash
			)
		};
		const aboveBound = {
			storePathHashes: [...bounded.storePathHashes, storePathHash]
		};

		expect({
			bounded: reuseViewAvailabilityRequestSchema.safeParse(bounded).success,
			aboveBound:
				reuseViewAvailabilityRequestSchema.safeParse(aboveBound).success
		}).toStrictEqual({ bounded: true, aboveBound: false });
	});
});
