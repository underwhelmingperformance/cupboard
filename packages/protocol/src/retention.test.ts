import { describe, expect, it } from 'vitest';

import {
	retentionPolicyAddBodySchema,
	retentionPolicyListResponseSchema,
	retentionPolicyRemoveResponseSchema,
	rootEnsureResponseSchema,
	rootSetBodySchema
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
