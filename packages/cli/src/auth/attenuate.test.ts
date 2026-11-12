import {
	cacheNameSchema,
	type CacheScope,
	rootNameSchema
} from '@cupboard/nix-store/scalars';
import { rootBatchCapacity } from '@cupboard/protocol/retention';
import { reuseViewNameSchema } from '@cupboard/protocol/reuse-views';
import { describe, expect, it } from 'vitest';

import {
	attestAttachAuthorizationDetails,
	confirmAuthorizationDetails,
	contentReadAuthorizationDetails,
	exactRootGrantsMaxBytes,
	previewAuthorizationDetails,
	pushAuthorizationDetails,
	rootEnsureAuthorizationDetails,
	rootListAuthorizationDetails,
	rootSetAuthorizationDetails
} from './attenuate.ts';

const rootName = (value: string) => rootNameSchema.parse(value);
const namedCache = (value: string): CacheScope => ({
	kind: 'named',
	name: cacheNameSchema.parse(value)
});
const defaultCache: CacheScope = { kind: 'default' };

describe('contentReadAuthorizationDetails', () => {
	it('requests only cache and view content reads for selected private resources', () => {
		expect(
			contentReadAuthorizationDetails({
				cache: namedCache('builds'),
				view: reuseViewNameSchema.parse('release')
			})
		).toStrictEqual([
			{
				type: 'cupboard_cache',
				actions: ['cache:content-read'],
				cache: { kind: 'named', name: 'builds' }
			},
			{
				type: 'cupboard_view',
				actions: ['view:content-read'],
				view: 'release'
			}
		]);
	});
});

describe('pushAuthorizationDetails', () => {
	it('requests only upload operations for a plain push', () => {
		expect(
			pushAuthorizationDetails({ cache: namedCache('pr-1'), attest: false })
		).toStrictEqual([
			{
				type: 'cupboard_cache',
				actions: ['upload:negotiate', 'upload:status', 'upload:commit'],
				cache: { kind: 'named', name: 'pr-1' }
			}
		]);
	});

	it('adds attestation and root operations when used', () => {
		expect(
			pushAuthorizationDetails({
				cache: namedCache('pr-1'),
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
				cache: { kind: 'named', name: 'pr-1' },
				root: rootName('main')
			}
		]);
	});

	it('requests the default cache scope', () => {
		const [grant] = pushAuthorizationDetails({
			cache: defaultCache,
			attest: false
		});

		expect(grant).toMatchObject({ cache: { kind: 'default' } });
	});

	it('requests a second grant for the run root beside the push grant', () => {
		expect(
			pushAuthorizationDetails({
				cache: namedCache('pr-1'),
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
				cache: { kind: 'named', name: 'pr-1' },
				root: rootName('main')
			},
			{
				type: 'cupboard_cache',
				actions: ['root:attach'],
				cache: { kind: 'named', name: 'pr-1' },
				root: rootName('ci/run-1')
			}
		]);
	});

	it('requests the run-root grant for a push naming no target root', () => {
		expect(
			pushAuthorizationDetails({
				cache: namedCache('pr-1'),
				attest: false,
				runRoot: rootName('ci/run-1')
			})
		).toStrictEqual([
			{
				type: 'cupboard_cache',
				actions: ['upload:negotiate', 'upload:status', 'upload:commit'],
				cache: { kind: 'named', name: 'pr-1' }
			},
			{
				type: 'cupboard_cache',
				actions: ['root:attach'],
				cache: { kind: 'named', name: 'pr-1' },
				root: rootName('ci/run-1')
			}
		]);
	});

	// `--no-retain` is represented by omitting `root`; grant intent has no
	// separate unretained flag.
	it('requests no root:set detail for an unretained (--no-retain) push', () => {
		const [grant] = pushAuthorizationDetails({
			cache: namedCache('pr-1'),
			attest: false
		});

		expect(grant).toStrictEqual({
			type: 'cupboard_cache',
			actions: ['upload:negotiate', 'upload:status', 'upload:commit'],
			cache: { kind: 'named', name: 'pr-1' }
		});
	});
});

describe('rootEnsureAuthorizationDetails', () => {
	it('requests only root:set for the exact cache and root', () => {
		expect(
			rootEnsureAuthorizationDetails({
				cache: namedCache('pr-1'),
				root: rootName('github:owner/repo/pr-1/x86_64-linux/app')
			})
		).toStrictEqual([
			{
				type: 'cupboard_cache',
				actions: ['root:set'],
				cache: { kind: 'named', name: 'pr-1' },
				root: rootName('github:owner/repo/pr-1/x86_64-linux/app')
			}
		]);
	});
});

describe('rootSetAuthorizationDetails', () => {
	const manyRoots = Array.from(
		{ length: 400 },
		(_, index) => `github:acme/app/main/x86_64-linux/target-${String(index)}`
	);
	const manyUnrelatedRoots = manyRoots.map((root, index) =>
		index % 2 === 0 ? root : root.replace('github:', 'gitlab:')
	);

	it.each([
		{
			name: 'the exact name of a single root',
			roots: ['github:acme/app/main/app', 'github:acme/app/main/app'],
			selectors: ['github:acme/app/main/app']
		},
		{
			name: 'the exact name of each root while the grants are small',
			roots: [
				'github:acme/app/main/x86_64-linux/app',
				'github:acme/app/main/x86_64-linux/apps',
				'github:acme/app/main/aarch64-darwin/app'
			],
			selectors: [
				'github:acme/app/main/x86_64-linux/app',
				'github:acme/app/main/x86_64-linux/apps',
				'github:acme/app/main/aarch64-darwin/app'
			]
		},
		{
			name: 'the longest shared prefix when exact grants would exceed the budget',
			roots: manyRoots,
			selectors: ['github:acme/app/main/x86_64-linux/']
		},
		{
			name: 'the exact name of each root when the roots share no prefix',
			roots: manyUnrelatedRoots,
			selectors: manyUnrelatedRoots
		}
	])('selects $name', ({ roots, selectors }) => {
		expect(
			rootSetAuthorizationDetails({
				cache: namedCache('nightly'),
				roots: roots.map((root) => rootName(root))
			})
		).toStrictEqual(
			selectors.map((root) => ({
				type: 'cupboard_cache',
				actions: ['root:set'],
				cache: namedCache('nightly'),
				root
			}))
		);
	});

	// Roots whose exact grants serialise to `bytes`, one batch capacity of them.
	function rootsWithGrantBytes(bytes: number): readonly string[] {
		const prefix = 'github:acme/app/main/';
		const single = JSON.stringify(
			rootSetAuthorizationDetails({
				cache: defaultCache,
				roots: [rootName(prefix)]
			})
		);
		const grantOverhead = single.length - 2 - prefix.length;
		const count = rootBatchCapacity;
		const nameBytes = bytes - 2 - (count - 1) - count * grantOverhead;
		const baseLength = Math.floor(nameBytes / count);

		return Array.from({ length: count }, (_, index) => {
			const length = baseLength + (index < nameBytes % count ? 1 : 0);
			const name = `${prefix}${String(index).padStart(3, '0')}`;

			return name.padEnd(length, 'x');
		});
	}

	it.each([
		{
			name: 'exact grants for one batch of roots at the budget',
			roots: rootsWithGrantBytes(exactRootGrantsMaxBytes),
			isExact: true
		},
		{
			name: 'the shared prefix one byte over the budget',
			roots: rootsWithGrantBytes(exactRootGrantsMaxBytes + 1),
			isExact: false
		}
	])('requests $name', ({ roots, isExact }) => {
		const details = rootSetAuthorizationDetails({
			cache: defaultCache,
			roots: roots.map((root) => rootName(root))
		});

		expect(
			details.map((detail) => ('root' in detail ? detail.root : undefined))
		).toStrictEqual(isExact ? roots : ['github:acme/app/main/']);
	});
});

describe('rootListAuthorizationDetails', () => {
	it('requests only root:list for the exact cache, naming no root, for a cache-wide listing', () => {
		expect(
			rootListAuthorizationDetails({ cache: namedCache('pr-1') })
		).toStrictEqual([
			{
				type: 'cupboard_cache',
				actions: ['root:list'],
				cache: { kind: 'named', name: 'pr-1' }
			}
		]);
	});

	it('requests root:list narrowed to the named root for a single root listing', () => {
		expect(
			rootListAuthorizationDetails({
				cache: namedCache('pr-1'),
				root: rootName('github:owner/repo/pr-1/x86_64-linux/app')
			})
		).toStrictEqual([
			{
				type: 'cupboard_cache',
				actions: ['root:list'],
				cache: { kind: 'named', name: 'pr-1' },
				root: rootName('github:owner/repo/pr-1/x86_64-linux/app')
			}
		]);
	});

	it('requests the default cache scope', () => {
		const [grant] = rootListAuthorizationDetails({ cache: defaultCache });

		expect(grant).toMatchObject({ cache: { kind: 'default' } });
	});
});

describe('attestAttachAuthorizationDetails', () => {
	it('requests the attestation conversation and only the negotiate upload operation', () => {
		expect(
			attestAttachAuthorizationDetails({ cache: namedCache('pr-1') })
		).toStrictEqual([
			{
				type: 'cupboard_cache',
				actions: [
					'upload:negotiate',
					'attestation:negotiate',
					'attestation:attach'
				],
				cache: { kind: 'named', name: 'pr-1' }
			}
		]);
	});

	it('requests the default cache scope', () => {
		const [grant] = attestAttachAuthorizationDetails({
			cache: defaultCache
		});

		expect(grant).toMatchObject({ cache: { kind: 'default' } });
	});
});

describe('confirmAuthorizationDetails', () => {
	it('requests only upload:confirm for the exact cache', () => {
		expect(
			confirmAuthorizationDetails({ cache: namedCache('pr-1') })
		).toStrictEqual([
			{
				type: 'cupboard_cache',
				actions: ['upload:confirm'],
				cache: { kind: 'named', name: 'pr-1' }
			}
		]);
	});

	it('requests the default cache scope', () => {
		const [grant] = confirmAuthorizationDetails({ cache: defaultCache });

		expect(grant).toMatchObject({ cache: { kind: 'default' } });
	});
});

describe('previewAuthorizationDetails', () => {
	it('requests only upload:preview for the exact cache', () => {
		expect(
			previewAuthorizationDetails({ cache: namedCache('pr-1') })
		).toStrictEqual([
			{
				type: 'cupboard_cache',
				actions: ['upload:preview'],
				cache: { kind: 'named', name: 'pr-1' }
			}
		]);
	});

	it('requests the default cache scope', () => {
		const [grant] = previewAuthorizationDetails({ cache: defaultCache });

		expect(grant).toMatchObject({ cache: { kind: 'default' } });
	});
});
