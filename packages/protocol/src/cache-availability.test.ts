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
	it('accepts a bounded request and response', () => {
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

	it('rejects a request above the Worker subrequest bound', () => {
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

	it('uses a lower bound for reuse-view requests', () => {
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
