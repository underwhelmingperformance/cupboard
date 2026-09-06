import {
	cacheNameSchema,
	type CacheScope,
	rootNameSchema
} from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import {
	attestAttachAuthorizationDetails,
	confirmAuthorizationDetails,
	previewAuthorizationDetails,
	pushAuthorizationDetails,
	rootEnsureAuthorizationDetails,
	rootListAuthorizationDetails
} from './attenuate.ts';

const rootName = (value: string) => rootNameSchema.parse(value);

const prCache: CacheScope = {
	kind: 'named',
	name: cacheNameSchema.parse('pr-1')
};
const defaultCache: CacheScope = { kind: 'default' };

describe('pushAuthorizationDetails', () => {
	it('requests only upload operations for a plain push', () => {
		expect(
			pushAuthorizationDetails({ cache: prCache, attest: false })
		).toStrictEqual([
			{
				type: 'cupboard_cache',
				actions: ['upload:negotiate', 'upload:status', 'upload:commit'],
				cache: prCache
			}
		]);
	});

	it('adds attestation and root operations when used', () => {
		expect(
			pushAuthorizationDetails({
				cache: prCache,
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
				cache: prCache,
				root: rootName('main')
			}
		]);
	});

	it('requests the default cache', () => {
		const [grant] = pushAuthorizationDetails({
			cache: defaultCache,
			attest: false
		});

		expect(grant).toMatchObject({ cache: defaultCache });
	});

	it('requests a second grant for the run root beside the push grant', () => {
		expect(
			pushAuthorizationDetails({
				cache: prCache,
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
				cache: prCache,
				root: rootName('main')
			},
			{
				type: 'cupboard_cache',
				actions: ['root:attach'],
				cache: prCache,
				root: rootName('ci/run-1')
			}
		]);
	});

	it('requests the run-root grant for a push naming no target root', () => {
		expect(
			pushAuthorizationDetails({
				cache: prCache,
				attest: false,
				runRoot: rootName('ci/run-1')
			})
		).toStrictEqual([
			{
				type: 'cupboard_cache',
				actions: ['upload:negotiate', 'upload:status', 'upload:commit'],
				cache: prCache
			},
			{
				type: 'cupboard_cache',
				actions: ['root:attach'],
				cache: prCache,
				root: rootName('ci/run-1')
			}
		]);
	});

	// `--no-retain` is represented by omitting `root`; grant intent has no
	// separate unretained flag.
	it('requests no root:set detail for an unretained (--no-retain) push', () => {
		const [grant] = pushAuthorizationDetails({
			cache: prCache,
			attest: false
		});

		expect(grant).toStrictEqual({
			type: 'cupboard_cache',
			actions: ['upload:negotiate', 'upload:status', 'upload:commit'],
			cache: prCache
		});
	});
});

describe('rootEnsureAuthorizationDetails', () => {
	it('requests only root:set for the exact cache and root', () => {
		expect(
			rootEnsureAuthorizationDetails({
				cache: prCache,
				root: rootName('github:owner/repo/pr-1/x86_64-linux/app')
			})
		).toStrictEqual([
			{
				type: 'cupboard_cache',
				actions: ['root:set'],
				cache: prCache,
				root: rootName('github:owner/repo/pr-1/x86_64-linux/app')
			}
		]);
	});
});

describe('rootListAuthorizationDetails', () => {
	it('requests only root:list for the exact cache, naming no root, for a cache-wide listing', () => {
		expect(rootListAuthorizationDetails({ cache: prCache })).toStrictEqual([
			{
				type: 'cupboard_cache',
				actions: ['root:list'],
				cache: prCache
			}
		]);
	});

	it('requests root:list narrowed to the named root for a single root listing', () => {
		expect(
			rootListAuthorizationDetails({
				cache: prCache,
				root: rootName('github:owner/repo/pr-1/x86_64-linux/app')
			})
		).toStrictEqual([
			{
				type: 'cupboard_cache',
				actions: ['root:list'],
				cache: prCache,
				root: rootName('github:owner/repo/pr-1/x86_64-linux/app')
			}
		]);
	});

	it('requests the default cache', () => {
		const [grant] = rootListAuthorizationDetails({ cache: defaultCache });

		expect(grant).toMatchObject({ cache: defaultCache });
	});
});

describe('attestAttachAuthorizationDetails', () => {
	it('requests the attestation conversation and only the negotiate upload operation', () => {
		expect(attestAttachAuthorizationDetails({ cache: prCache })).toStrictEqual([
			{
				type: 'cupboard_cache',
				actions: [
					'upload:negotiate',
					'attestation:negotiate',
					'attestation:attach'
				],
				cache: prCache
			}
		]);
	});

	it('requests the default cache', () => {
		const [grant] = attestAttachAuthorizationDetails({
			cache: defaultCache
		});

		expect(grant).toMatchObject({ cache: defaultCache });
	});
});

describe('confirmAuthorizationDetails', () => {
	it('requests only upload:confirm for the exact cache', () => {
		expect(confirmAuthorizationDetails({ cache: prCache })).toStrictEqual([
			{
				type: 'cupboard_cache',
				actions: ['upload:confirm'],
				cache: prCache
			}
		]);
	});

	it('requests the default cache', () => {
		const [grant] = confirmAuthorizationDetails({ cache: defaultCache });

		expect(grant).toMatchObject({ cache: defaultCache });
	});
});

describe('previewAuthorizationDetails', () => {
	it('requests only upload:preview for the exact cache', () => {
		expect(previewAuthorizationDetails({ cache: prCache })).toStrictEqual([
			{
				type: 'cupboard_cache',
				actions: ['upload:preview'],
				cache: prCache
			}
		]);
	});

	it('requests the default cache', () => {
		const [grant] = previewAuthorizationDetails({ cache: defaultCache });

		expect(grant).toMatchObject({ cache: defaultCache });
	});
});
