import {
	cacheNameSchema,
	type PrivateStoredCache,
	privateStoredCache,
	type TenantId,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';

const tenantPrefix = '/t/';
const privateCachePrefix = '/private-cache/';

export interface TenantRoute {
	readonly tenant: TenantId;
	readonly rest: string;
}

export interface PrivateCacheRoute {
	readonly cache: PrivateStoredCache;
	readonly rest: string;
}

// Splits a leading `/t/<slug>/` tenant prefix off a path. Returns the slug and the
// tenant-relative remainder, or undefined for a bare-host path (the control
// surface). A malformed or invalid slug also returns undefined, so a bad slug is
// never mistaken for a tenant and never reaches a Durable Object.
export function parseTenantPath(pathname: string): TenantRoute | undefined {
	if (!pathname.startsWith(tenantPrefix)) {
		return undefined;
	}

	const remainder = pathname.slice(tenantPrefix.length);
	const separator = remainder.indexOf('/');
	const slug = separator === -1 ? remainder : remainder.slice(0, separator);

	const tenant = tenantIdSchema.safeParse(slug);

	if (!tenant.success) {
		return undefined;
	}

	return {
		tenant: tenant.data,
		rest: separator === -1 ? '/' : remainder.slice(separator)
	};
}

// Splits a leading `/private-cache/<local-name>/` prefix from a tenant-relative
// path. The path contains the local name; the result contains the stored name
// and the cache-relative remainder. Anything else returns undefined: a path
// outside the namespace, an empty or malformed name, or a name with no path
// after it.
export function parsePrivateCachePath(
	pathname: string
): PrivateCacheRoute | undefined {
	if (!pathname.startsWith(privateCachePrefix)) {
		return undefined;
	}

	const remainder = pathname.slice(privateCachePrefix.length);
	const separator = remainder.indexOf('/');

	if (separator <= 0) {
		return undefined;
	}

	const name = cacheNameSchema.safeParse(remainder.slice(0, separator));

	if (!name.success) {
		return undefined;
	}

	return {
		cache: privateStoredCache(name.data),
		rest: remainder.slice(separator)
	};
}
