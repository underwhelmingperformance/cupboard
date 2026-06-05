import { describe, expect, it } from 'vitest';

import {
	retentionPolicyAddBodySchema,
	retentionPolicyListResponseSchema,
	retentionPolicyRemoveResponseSchema,
	rootSetBodySchema
} from './retention.ts';

const storePathHash = '0'.repeat(32);
const storePath = `/nix/store/${storePathHash}-name`;

describe('rootSetBodySchema', () => {
	it.each([
		{ name: 'targets only', value: { targets: [storePath] }, valid: true },
		{
			name: 'targets and ttl',
			value: { targets: [storePath], ttlSeconds: 3600 },
			valid: true
		},
		{ name: 'no targets', value: { targets: [] }, valid: false },
		{
			name: 'a nested target path',
			value: { targets: [`${storePath}/x`] },
			valid: false
		},
		{
			name: 'an out-of-range ttl',
			value: { targets: [storePath], ttlSeconds: 0 },
			valid: false
		}
	])('$name', ({ value, valid }) => {
		expect(rootSetBodySchema.safeParse(value).success).toBe(valid);
	});
});

describe('retention policy schemas', () => {
	it.each([
		{
			name: 'a cache-scoped policy',
			value: { scope: 'cache', pattern: 'builds', ttlSeconds: 1_209_600 },
			valid: true
		},
		{
			name: 'a cache-scoped policy targeting the default cache',
			value: { scope: 'cache', pattern: '', ttlSeconds: 1_209_600 },
			valid: true
		},
		{
			name: 'a prefix-scoped policy',
			value: {
				scope: 'root-name-prefix',
				pattern: 'pr-',
				ttlSeconds: 1_209_600
			},
			valid: true
		},
		{
			name: 'a cache scope with an invalid cache name',
			value: { scope: 'cache', pattern: 'Bad!', ttlSeconds: 1_209_600 },
			valid: false
		},
		{
			name: 'an unknown scope',
			value: { scope: 'tag', pattern: 'x', ttlSeconds: 1_209_600 },
			valid: false
		},
		{
			name: 'an out-of-range ttl',
			value: { scope: 'root-name-prefix', pattern: 'pr-', ttlSeconds: 0 },
			valid: false
		}
	])('add body: $name', ({ value, valid }) => {
		expect(retentionPolicyAddBodySchema.safeParse(value).success).toBe(valid);
	});

	it('accepts the list and remove responses', () => {
		expect({
			list: retentionPolicyListResponseSchema.safeParse({
				policies: [
					{
						id: 'p1',
						scope: 'root-name-prefix',
						pattern: 'pr-',
						ttlSeconds: 1_209_600
					}
				]
			}).success,
			remove: retentionPolicyRemoveResponseSchema.safeParse({
				id: 'p1',
				removed: true
			}).success
		}).toStrictEqual({ list: true, remove: true });
	});
});
