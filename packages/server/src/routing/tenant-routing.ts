import {
	cacheFromSelector,
	cacheNameSchema,
	DEFAULT_CACHE,
	privateStoredCache,
	publicCacheSelectorSchema,
	type StoredCache,
	storedCacheSchema,
	type TenantId,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';

const tenantPrefix = '/t/';

/**
 * Namespace segments followed by a cache or reuse-view name on routes that
 * require literal spelling.
 */
export type RouteNamespace =
	'cache' | 'private-cache' | 'private-reuse' | 'reuse';

const privateCacheNamespace: RouteNamespace = 'private-cache';
const privateCachePrefix = `/${privateCacheNamespace}/`;
const publicCacheNamespace: RouteNamespace = 'cache';
const publicCachePrefix = `/${publicCacheNamespace}/`;
const defaultCache = storedCacheSchema.parse(DEFAULT_CACHE);

export interface TenantRoute {
	readonly tenant: TenantId;
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

/**
 * Returns whether the raw tenant-relative path contains the literal
 * `/<namespace>/<name>` prefix. `namespace` identifies the route namespace,
 * and `name` is the decoded route parameter.
 *
 * Hono decodes unreserved percent escapes during route matching and parameter
 * extraction. Admission instead parses the raw path to load a private cache's
 * read verifier, and the Workers Cache key also retains the raw path. For
 * `/private%2Dcache/%62uilds`, Hono selects the private-cache route and returns
 * `builds`, but admission finds no literal private-cache prefix and loads no
 * cache verifier. Namespace and resource names contain only unreserved
 * characters, so the raw and decoded spellings must match.
 */
export function isLiteralNamespacePath(
	rest: string,
	namespace: RouteNamespace,
	name: string
): boolean {
	const prefix = `/${namespace}/${name}`;

	return rest === prefix || rest.startsWith(`${prefix}/`);
}

// The name that follows `/<namespace>/` in a tenant-relative path, or undefined
// when the path is outside that namespace. The name is `''` for a path that
// stops at the prefix, and no cache name parses from that.
function namespacedName(pathname: string, prefix: string): string | undefined {
	if (!pathname.startsWith(prefix)) {
		return undefined;
	}

	const remainder = pathname.slice(prefix.length);
	const separator = remainder.indexOf('/');

	return separator === -1 ? remainder : remainder.slice(0, separator);
}

/**
 * The cache a tenant-relative path addresses, taken from its `/cache/<name>` or
 * `/private-cache/<name>` prefix. A path with neither addresses the default
 * cache, and so does one whose name is malformed: a later routing stage refuses
 * that request, and admission must not read another cache's rows for it in the
 * meantime.
 *
 * Admission calls this on the raw path before Hono matches a route, so that the
 * tenant row and the addressed cache's credential and lifecycle rows come from
 * one D1 batch.
 */
export function addressedCache(pathname: string): StoredCache {
	const privateName = namespacedName(pathname, privateCachePrefix);

	if (privateName !== undefined) {
		const name = cacheNameSchema.safeParse(privateName);

		return name.success ? privateStoredCache(name.data) : defaultCache;
	}

	const publicName = namespacedName(pathname, publicCachePrefix);

	if (publicName === undefined) {
		return defaultCache;
	}

	const selector = publicCacheSelectorSchema.safeParse(publicName);

	return selector.success ? cacheFromSelector(selector.data) : defaultCache;
}
