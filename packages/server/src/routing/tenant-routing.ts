import {
	cacheNameSchema,
	type CacheScope,
	type TenantId,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';

const tenantPrefix = '/t/';

/**
 * Namespace segments followed by a cache or reuse-view name on routes that
 * require literal spelling.
 */
export type RouteNamespace = 'cache' | 'reuse';

const namedCachePrefix = '/cache/';

export interface TenantRoute {
	readonly tenant: TenantId;
	readonly rest: string;
}

export interface NamedCacheRoute {
	readonly scope: CacheScope & { readonly kind: 'named' };
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
 * extraction. Admission instead parses the raw path to select the cache before
 * authentication, and the Workers Cache key retains the raw path. Namespace
 * and resource names contain only unreserved characters, so the raw and
 * decoded spellings must match.
 */
export function isLiteralNamespacePath(
	rest: string,
	namespace: RouteNamespace,
	name: string
): boolean {
	const prefix = `/${namespace}/${name}`;

	return rest === prefix || rest.startsWith(`${prefix}/`);
}

// Splits a leading `/cache/<name>` prefix from a tenant-relative path. The
// remainder is `/` when the path ends at the prefix. A path outside the
// namespace, or one with an empty or malformed name, returns `undefined`.
export function parseNamedCachePath(
	pathname: string
): NamedCacheRoute | undefined {
	if (!pathname.startsWith(namedCachePrefix)) {
		return undefined;
	}

	const remainder = pathname.slice(namedCachePrefix.length);
	const separator = remainder.indexOf('/');
	const localName =
		separator === -1 ? remainder : remainder.slice(0, separator);
	const name = cacheNameSchema.safeParse(localName);

	if (!name.success) {
		return undefined;
	}

	return {
		scope: { kind: 'named', name: name.data },
		rest: separator === -1 ? '/' : remainder.slice(separator)
	};
}
