import { oidcSubjectSchema } from '@cupboard/protocol/oidc';
import { describe, expect, it } from 'vitest';

import { type AccessClaims } from '../auth/auth.ts';

import {
	authoriseRequest,
	MissingPathCacheError,
	noPendingCache
} from './authorise.ts';

describe('authoriseRequest', () => {
	const wildcardClaims: AccessClaims = {
		subject: oidcSubjectSchema.parse('ci'),
		grants: [{ type: 'cupboard_wildcard' }],
		expiresAt: new Date('2030-01-01T00:00:00Z')
	};

	it('refuses a procedure that reads its cache from the path when the router supplies none', async () => {
		await expect(
			authoriseRequest(
				wildcardClaims,
				{ requires: 'stats:read', resource: { cache: { fromPath: true } } },
				{},
				undefined,
				noPendingCache
			)
		).rejects.toThrow(MissingPathCacheError);
	});
});
