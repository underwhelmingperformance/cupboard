import { describe, expect, it } from 'vitest';

import {
	graceCoverageResponseSchema,
	gracePolicyAddBodySchema,
	gracePolicyListResponseSchema,
	gracePolicyRemoveResponseSchema,
	retentionPolicyAddBodySchema,
	retentionPolicyListResponseSchema,
	retentionPolicyRemoveResponseSchema,
	rootEnsureResponseSchema,
	rootListResponseSchema,
	rootSetBodySchema,
	rootSetMaxTargets,
	rootTargetsPageSchema
} from './retention.ts';

const storePathHash = '0'.repeat(32);
const storePath = `/nix/store/${storePathHash}-name`;

describe('rootSetBodySchema', () => {
	it.each([
		{
			name: 'targets only',
			value: { targets: [storePath] },
			expected: { targets: [storePath] }
		},
		{
			name: 'targets and ttl',
			value: { targets: [storePath], ttlSeconds: 3600 },
			expected: { targets: [storePath], ttlSeconds: 3600 }
		}
	])('accepts $name', ({ value, expected }) => {
		expect(rootSetBodySchema.parse(value)).toStrictEqual(expected);
	});

	it('accepts a target list at the bound', () => {
		const targets = Array.from(
			{ length: rootSetMaxTargets },
			(_, index) =>
				`/nix/store/${String(index).padStart(32, '0')}-name-${String(index)}`
		);

		expect(rootSetBodySchema.parse({ targets })).toStrictEqual({ targets });
	});

	it('rejects a target list over the bound', () => {
		const targets = Array.from(
			{ length: rootSetMaxTargets + 1 },
			(_, index) =>
				`/nix/store/${String(index).padStart(32, '0')}-name-${String(index)}`
		);

		expect(rootSetBodySchema.safeParse({ targets }).success).toBe(false);
	});

	it.each([
		{
			name: 'no targets',
			value: { targets: [] }
		},
		{
			name: 'a nested target path',
			value: { targets: [`${storePath}/x`] }
		},
		{
			name: 'an out-of-range ttl',
			value: { targets: [storePath], ttlSeconds: 0 }
		}
	])('rejects $name', ({ value }) => {
		expect(rootSetBodySchema.safeParse(value).success).toBe(false);
	});
});

describe('rootEnsureResponseSchema', () => {
	it.each([
		{
			name: 'a retained root',
			value: {
				status: 'retained',
				root: {
					name: 'main',
					expired: false,
					createdAt: '2026-07-10T00:00:00.000Z',
					updatedAt: '2026-07-10T00:00:00.000Z',
					targets: [
						{
							storePathHash,
							storePath,
							present: true
						}
					]
				}
			}
		},
		{
			name: 'a build requirement',
			value: { status: 'build-required', unavailable: [storePath] }
		}
	])('accepts $name', ({ value }) => {
		expect(rootEnsureResponseSchema.parse(value)).toStrictEqual(value);
	});
});

describe('rootListResponseSchema', () => {
	const listedRoot = {
		name: 'github:owner/repo/main',
		expired: false,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		targetCount: 3
	};

	it.each([
		{ name: 'a final page', value: { roots: [listedRoot] } },
		{
			name: 'a page with a continuation',
			value: { roots: [listedRoot], cursor: listedRoot.name }
		},
		{ name: 'an empty listing', value: { roots: [] } }
	])('accepts $name', ({ value }) => {
		expect(rootListResponseSchema.parse(value)).toStrictEqual(value);
	});

	it.each([
		{
			name: 'an entry carrying inline targets',
			value: { roots: [{ ...listedRoot, targets: [] }] }
		},
		{
			name: 'a negative target count',
			value: { roots: [{ ...listedRoot, targetCount: -1 }] }
		},
		{ name: 'an empty cursor', value: { roots: [], cursor: '' } }
	])('rejects $name', ({ value }) => {
		expect(rootListResponseSchema.safeParse(value).success).toBe(false);
	});
});

describe('rootTargetsPageSchema', () => {
	const pageTarget = {
		storePathHash: '0'.repeat(32),
		storePath: `/nix/store/${'0'.repeat(32)}-name`,
		present: true
	};

	it.each([
		{ name: 'a final page', value: { targets: [pageTarget] } },
		{
			name: 'a page with a continuation',
			value: { targets: [pageTarget], cursor: pageTarget.storePathHash }
		},
		{ name: 'an empty page', value: { targets: [] } }
	])('accepts $name', ({ value }) => {
		expect(rootTargetsPageSchema.parse(value)).toStrictEqual(value);
	});

	it.each([
		{
			name: 'a target with no present flag',
			value: {
				targets: [
					{
						storePathHash: pageTarget.storePathHash,
						storePath: pageTarget.storePath
					}
				]
			}
		},
		{ name: 'an empty cursor', value: { targets: [], cursor: '' } }
	])('rejects $name', ({ value }) => {
		expect(rootTargetsPageSchema.safeParse(value).success).toBe(false);
	});
});

describe('retention policy schemas', () => {
	it.each([
		{
			name: 'a cache-scoped policy',
			value: { scope: 'cache', pattern: 'builds', ttlSeconds: 1_209_600 },
			expected: { scope: 'cache', pattern: 'builds', ttlSeconds: 1_209_600 }
		},
		{
			name: 'a cache-scoped policy targeting the default cache',
			value: { scope: 'cache', pattern: '', ttlSeconds: 1_209_600 },
			expected: { scope: 'cache', pattern: '', ttlSeconds: 1_209_600 }
		},
		{
			name: 'a prefix-scoped policy',
			value: {
				scope: 'root-name-prefix',
				pattern: 'pr-',
				ttlSeconds: 1_209_600
			},
			expected: {
				scope: 'root-name-prefix',
				pattern: 'pr-',
				ttlSeconds: 1_209_600
			}
		}
	])('accepts add body: $name', ({ value, expected }) => {
		expect(retentionPolicyAddBodySchema.parse(value)).toStrictEqual(expected);
	});

	it.each([
		{
			name: 'a cache scope with an invalid cache name',
			value: { scope: 'cache', pattern: 'Bad!', ttlSeconds: 1_209_600 }
		},
		{
			name: 'an unknown scope',
			value: { scope: 'tag', pattern: 'x', ttlSeconds: 1_209_600 }
		},
		{
			name: 'an out-of-range ttl',
			value: { scope: 'root-name-prefix', pattern: 'pr-', ttlSeconds: 0 }
		}
	])('rejects add body: $name', ({ value }) => {
		expect(retentionPolicyAddBodySchema.safeParse(value).success).toBe(false);
	});

	it('accepts the list and remove responses', () => {
		const policy = {
			id: 'p1',
			scope: 'root-name-prefix',
			pattern: 'pr-',
			ttlSeconds: 1_209_600
		};
		const remove = { id: 'p1', removed: true };

		expect({
			list: retentionPolicyListResponseSchema.parse({ policies: [policy] }),
			remove: retentionPolicyRemoveResponseSchema.parse(remove)
		}).toStrictEqual({
			list: { policies: [policy] },
			remove
		});
	});
});

describe('retention grace policy schemas', () => {
	it.each([
		{
			name: 'a prefix and a positive grace',
			value: { cachePrefix: 'pr-', graceSeconds: 86_400 },
			expected: { cachePrefix: 'pr-', graceSeconds: 86_400 }
		},
		{
			name: 'the empty (tenant-wide default) prefix',
			value: { cachePrefix: '', graceSeconds: 86_400 },
			expected: { cachePrefix: '', graceSeconds: 86_400 }
		},
		{
			name: 'a zero grace',
			value: { cachePrefix: 'pr-', graceSeconds: 0 },
			expected: { cachePrefix: 'pr-', graceSeconds: 0 }
		}
	])('accepts add body: $name', ({ value, expected }) => {
		expect(gracePolicyAddBodySchema.parse(value)).toStrictEqual(expected);
	});

	it.each([
		{
			name: 'a negative grace',
			value: { cachePrefix: 'pr-', graceSeconds: -1 }
		},
		{
			name: 'a grace beyond the root TTL bound',
			value: { cachePrefix: 'pr-', graceSeconds: 315_360_001 }
		},
		{
			name: 'a fractional grace',
			value: { cachePrefix: 'pr-', graceSeconds: 1.5 }
		},
		{
			name: 'an unknown field',
			value: { cachePrefix: 'pr-', graceSeconds: 0, extra: true }
		},
		// A prefix no cache name can start with silently matches nothing;
		// rejecting it at the contract catches the typo at add time.
		{
			name: 'an upper-case prefix no cache name can carry',
			value: { cachePrefix: 'PR-', graceSeconds: 86_400 }
		},
		{
			name: 'a prefix with a leading separator',
			value: { cachePrefix: '-pr', graceSeconds: 86_400 }
		},
		{
			name: 'a prefix over the cache-name length bound',
			value: { cachePrefix: 'a'.repeat(64), graceSeconds: 86_400 }
		}
	])('rejects add body: $name', ({ value }) => {
		expect(gracePolicyAddBodySchema.safeParse(value).success).toBe(false);
	});

	it('accepts the list and remove responses', () => {
		const policy = {
			id: 'g1',
			cachePrefix: 'pr-',
			graceSeconds: 86_400,
			createdAt: '2026-01-01T00:00:00.000Z'
		};
		const remove = { id: 'g1', removed: true };

		expect({
			list: gracePolicyListResponseSchema.parse({ policies: [policy] }),
			remove: gracePolicyRemoveResponseSchema.parse(remove)
		}).toStrictEqual({
			list: { policies: [policy] },
			remove
		});
	});
});

describe('graceCoverageResponseSchema', () => {
	it.each([
		{
			name: 'a covered cache with its resolved grace',
			value: { covered: true, graceSeconds: 86_400 },
			expected: { covered: true, graceSeconds: 86_400 }
		},
		{
			name: 'an uncovered cache',
			value: { covered: false },
			expected: { covered: false }
		}
	])('accepts $name', ({ value, expected }) => {
		expect(graceCoverageResponseSchema.parse(value)).toStrictEqual(expected);
	});

	it.each([
		{
			name: 'covered without a resolved grace',
			value: { covered: true }
		},
		{
			name: 'uncovered with a resolved grace',
			value: { covered: false, graceSeconds: 86_400 }
		},
		{
			name: 'an unknown key',
			value: { covered: false, surprise: true }
		}
	])('rejects $name', ({ value }) => {
		expect(graceCoverageResponseSchema.safeParse(value).success).toBe(false);
	});
});
