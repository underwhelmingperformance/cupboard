import { describe, expect, it } from 'vitest';

import { pushAuthorizationDetails } from './attenuate.ts';

describe('pushAuthorizationDetails', () => {
	it('requests only upload operations for a plain push', () => {
		expect(
			pushAuthorizationDetails({ cacheSelector: 'pr-1', attest: false })
		).toStrictEqual([
			{
				type: 'cupboard_cache',
				actions: ['upload:negotiate', 'upload:status', 'upload:commit'],
				cache: 'pr-1'
			}
		]);
	});

	it('adds attestation and root operations when used', () => {
		expect(
			pushAuthorizationDetails({
				cacheSelector: 'pr-1',
				attest: true,
				root: 'main'
			})
		).toStrictEqual([
			{
				type: 'cupboard_cache',
				actions: [
					'upload:negotiate',
					'upload:status',
					'upload:commit',
					'attestation:negotiate',
					'attestation:attach',
					'root:set'
				],
				cache: 'pr-1',
				root: 'main'
			}
		]);
	});

	it('requests the default cache selector', () => {
		const [grant] = pushAuthorizationDetails({
			cacheSelector: '_default',
			attest: false
		});

		expect(grant).toMatchObject({ cache: '_default' });
	});
});
