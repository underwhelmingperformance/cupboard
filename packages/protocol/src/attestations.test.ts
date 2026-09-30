import { describe, expect, it } from 'vitest';

import {
	attestationAttachMaxPaths,
	attestationAttachPathsRequestSchema,
	attestationBundleNegotiateMaxBundles,
	attestationBundleNegotiateRequestSchema,
	attestationNegotiateMaxBundles,
	attestationNegotiateRequestSchema
} from './attestations.ts';

const storePathHash = '0'.repeat(32);
const digest = 'a'.repeat(64);
const bundle = { storePathHash, digest };
const pushId = 'push-1';

describe('attestationNegotiateRequestSchema', () => {
	it('accepts 100,000 bundles', () => {
		const value = {
			pushId,
			bundles: Array.from(
				{ length: attestationNegotiateMaxBundles },
				() => bundle
			)
		};

		expect(attestationNegotiateRequestSchema.parse(value)).toStrictEqual(value);
	});

	it.each([
		{
			name: 'an unknown top-level key',
			value: { bundles: [], extra: 1 }
		},
		{
			name: 'an unknown key inside a bundle',
			value: { bundles: [{ ...bundle, surprise: true }] }
		},
		{
			name: 'a malformed digest',
			value: { bundles: [{ ...bundle, digest: 'nope' }] }
		},
		{
			name: 'one bundle over the negotiated limit',
			value: {
				bundles: Array.from(
					{ length: attestationNegotiateMaxBundles + 1 },
					() => bundle
				)
			}
		}
	])('rejects $name', ({ value }) => {
		expect(
			attestationNegotiateRequestSchema.safeParse({ pushId, ...value }).success
		).toBe(false);
	});
});

describe('bundle attachment pages', () => {
	it('accepts a full path page and rejects the next path', () => {
		const request = {
			id: '00000000-0000-4000-8000-000000000000',
			storePathHashes: Array.from({ length: attestationAttachMaxPaths }, () =>
				'1'.repeat(32)
			)
		};
		expect({
			accepted: attestationAttachPathsRequestSchema.safeParse(request).success,
			oversized: attestationAttachPathsRequestSchema.safeParse({
				...request,
				storePathHashes: [...request.storePathHashes, '1'.repeat(32)]
			}).success
		}).toStrictEqual({ accepted: true, oversized: false });
	});
	it('bounds distinct bundles independently of their subject lists', () => {
		const bundles = Array.from(
			{ length: attestationBundleNegotiateMaxBundles },
			() => ({ digest: 'a'.repeat(64) })
		);
		expect({
			accepted: attestationBundleNegotiateRequestSchema.safeParse({
				pushId,
				bundles
			}).success,
			oversized: attestationBundleNegotiateRequestSchema.safeParse({
				pushId,
				bundles: [...bundles, { digest: 'b'.repeat(64) }]
			}).success
		}).toStrictEqual({ accepted: true, oversized: false });
	});
});
