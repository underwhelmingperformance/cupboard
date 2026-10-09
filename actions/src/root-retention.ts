/**
How long a target's root lasts after a run sets it.
*/
export type RootRetention =
	| { readonly kind: 'permanent' }
	| { readonly kind: 'ttl'; readonly ttl: string }
	| { readonly kind: 'cache' };

/**
 * Reads the retention from the workflow's `ttl` and `permanent` inputs. With
 * neither, the cache's retention settings apply.
 */
export function rootRetention(
	ttl: string,
	isPermanent: boolean
): RootRetention {
	if (isPermanent) {
		return { kind: 'permanent' };
	}

	return ttl === '' ? { kind: 'cache' } : { kind: 'ttl', ttl };
}
