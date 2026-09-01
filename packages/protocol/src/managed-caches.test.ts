import { describe, expect, it } from 'vitest';

import {
	managedCacheNamespaceSchema,
	managedPolicyPutBodySchema
} from './managed-caches.ts';

const basePolicy = {
	ownerId: '42',
	repositoryId: '123',
	reuseViewName: 'pull-requests',
	access: 'private'
};

describe('managed cache policies', () => {
	it.each([
		{
			name: 'a permanent default when permanent roots are disallowed',
			policy: {
				...basePolicy,
				defaultRootRetention: { kind: 'permanent' },
				allowPermanentRoots: false
			}
		},
		{
			name: 'a default duration above the policy maximum',
			policy: {
				...basePolicy,
				defaultRootRetention: {
					kind: 'duration',
					seconds: 3600
				},
				maximumRootDurationSeconds: 1800
			}
		}
	])('rejects $name', ({ policy }) => {
		expect(managedPolicyPutBodySchema.safeParse(policy).success).toBe(false);
	});

	it('requires room for a pull-request number in a namespace', () => {
		expect(
			managedCacheNamespaceSchema.safeParse(`${'a'.repeat(159)}-`).success
		).toBe(false);
	});
});
