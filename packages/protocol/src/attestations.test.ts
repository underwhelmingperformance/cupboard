import { describe, expect, it } from 'vitest';

import {
	attestationNegotiateMaxBundles,
	attestationNegotiateRequestSchema
} from './attestations.ts';

const storePathHash = '0'.repeat(32);
const digest = 'a'.repeat(64);
const bundle = { storePathHash, digest };
const pushId = 'push-1';

describe('attestationNegotiateRequestSchema', () => {
	it('accepts a request within the bundle cap', () => {
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
			name: 'more bundles than the cap allows',
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
