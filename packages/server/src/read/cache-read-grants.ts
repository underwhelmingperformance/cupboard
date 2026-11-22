import { type CacheScope } from '@cupboard/nix-store/scalars';
import {
	type AuthorizationDetails,
	isCoveredByToken
} from '@cupboard/protocol/grants';

type CacheReadOperation = 'cache:content-read' | 'cache:read';

/**
The operations that each authorise a read of a cache. Metadata authority
can read a cache only while the cache is absent.
*/
export function cacheReadOperations(
	isAbsent: boolean
): readonly CacheReadOperation[] {
	return isAbsent
		? ['cache:content-read', 'cache:read']
		: ['cache:content-read'];
}

/**
Whether `grants` authorise a read of `cache`.
*/
export function isCacheReadCovered(
	grants: AuthorizationDetails,
	cache: CacheScope,
	isAbsent: boolean
): boolean {
	return cacheReadOperations(isAbsent).some((operation) =>
		isCoveredByToken(grants, operation, { cache })
	);
}
