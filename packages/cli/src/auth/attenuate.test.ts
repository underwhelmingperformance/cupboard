import { describe, expect, it } from 'vitest';

import {
	pushAuthorizationDetails,
	rootEnsureAuthorizationDetails
} from './attenuate.ts';

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

describe('rootEnsureAuthorizationDetails', () => {
	it('requests only root:set for the exact cache and root', () => {
		expect(
			rootEnsureAuthorizationDetails({
				cacheSelector: 'pr-1',
				root: 'github:owner/repo/pr-1/x86_64-linux/app'
			})
		).toStrictEqual([
			{
				type: 'cupboard_cache',
				actions: ['root:set'],
				cache: 'pr-1',
				root: 'github:owner/repo/pr-1/x86_64-linux/app'
			}
		]);
	});
});
