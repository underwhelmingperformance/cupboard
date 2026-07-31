import { rootNameSchema } from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import {
	confirmAuthorizationDetails,
	previewAuthorizationDetails,
	pushAuthorizationDetails,
	rootEnsureAuthorizationDetails,
	rootListAuthorizationDetails
} from './attenuate.ts';

const rootName = (value: string) => rootNameSchema.parse(value);

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
				root: rootName('main')
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
				root: rootName('main')
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

	it('requests a second grant for the run root beside the push grant', () => {
		expect(
			pushAuthorizationDetails({
				cacheSelector: 'pr-1',
				attest: false,
				root: rootName('main'),
				runRoot: rootName('ci/run-1')
			})
		).toStrictEqual([
			{
				type: 'cupboard_cache',
				actions: [
					'upload:negotiate',
					'upload:status',
					'upload:commit',
					'root:set'
				],
				cache: 'pr-1',
				root: rootName('main')
			},
			{
				type: 'cupboard_cache',
				actions: ['root:attach'],
				cache: 'pr-1',
				root: rootName('ci/run-1')
			}
		]);
	});

	it('requests the run-root grant for a push naming no target root', () => {
		expect(
			pushAuthorizationDetails({
				cacheSelector: 'pr-1',
				attest: false,
				runRoot: rootName('ci/run-1')
			})
		).toStrictEqual([
			{
				type: 'cupboard_cache',
				actions: ['upload:negotiate', 'upload:status', 'upload:commit'],
				cache: 'pr-1'
			},
			{
				type: 'cupboard_cache',
				actions: ['root:attach'],
				cache: 'pr-1',
				root: rootName('ci/run-1')
			}
		]);
	});

	// `--no-retain` carries no `root` on the grant intent, the same shape as a
	// push that simply never names one: no separate "unretained" signal exists at
	// this layer, since the CLI never requests root:set unless it names a root.
	it('requests no root:set detail for an unretained (--no-retain) push', () => {
		const [grant] = pushAuthorizationDetails({
			cacheSelector: 'pr-1',
			attest: false
		});

		expect(grant).toStrictEqual({
			type: 'cupboard_cache',
			actions: ['upload:negotiate', 'upload:status', 'upload:commit'],
			cache: 'pr-1'
		});
	});
});

describe('rootEnsureAuthorizationDetails', () => {
	it('requests only root:set for the exact cache and root', () => {
		expect(
			rootEnsureAuthorizationDetails({
				cacheSelector: 'pr-1',
				root: rootName('github:owner/repo/pr-1/x86_64-linux/app')
			})
		).toStrictEqual([
			{
				type: 'cupboard_cache',
				actions: ['root:set'],
				cache: 'pr-1',
				root: rootName('github:owner/repo/pr-1/x86_64-linux/app')
			}
		]);
	});
});

describe('rootListAuthorizationDetails', () => {
	it('requests only root:list for the exact cache, naming no root, for a cache-wide listing', () => {
		expect(
			rootListAuthorizationDetails({ cacheSelector: 'pr-1' })
		).toStrictEqual([
			{
				type: 'cupboard_cache',
				actions: ['root:list'],
				cache: 'pr-1'
			}
		]);
	});

	it('requests root:list narrowed to the named root for a single root listing', () => {
		expect(
			rootListAuthorizationDetails({
				cacheSelector: 'pr-1',
				root: rootName('github:owner/repo/pr-1/x86_64-linux/app')
			})
		).toStrictEqual([
			{
				type: 'cupboard_cache',
				actions: ['root:list'],
				cache: 'pr-1',
				root: rootName('github:owner/repo/pr-1/x86_64-linux/app')
			}
		]);
	});

	it('requests the default cache selector', () => {
		const [grant] = rootListAuthorizationDetails({ cacheSelector: '_default' });

		expect(grant).toMatchObject({ cache: '_default' });
	});
});

describe('confirmAuthorizationDetails', () => {
	it('requests only upload:confirm for the exact cache', () => {
		expect(
			confirmAuthorizationDetails({ cacheSelector: 'pr-1' })
		).toStrictEqual([
			{
				type: 'cupboard_cache',
				actions: ['upload:confirm'],
				cache: 'pr-1'
			}
		]);
	});

	it('requests the default cache selector', () => {
		const [grant] = confirmAuthorizationDetails({ cacheSelector: '_default' });

		expect(grant).toMatchObject({ cache: '_default' });
	});
});

describe('previewAuthorizationDetails', () => {
	it('requests only upload:preview for the exact cache', () => {
		expect(
			previewAuthorizationDetails({ cacheSelector: 'pr-1' })
		).toStrictEqual([
			{
				type: 'cupboard_cache',
				actions: ['upload:preview'],
				cache: 'pr-1'
			}
		]);
	});

	it('requests the default cache selector', () => {
		const [grant] = previewAuthorizationDetails({ cacheSelector: '_default' });

		expect(grant).toMatchObject({ cache: '_default' });
	});
});
