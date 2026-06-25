import { type TenantId, tenantIdSchema } from '@cupboard/nix-store/scalars';

const tenantPrefix = '/t/';

// The tenant a path addresses and the tenant-relative remainder of that path.
export interface TenantRoute {
	readonly tenant: TenantId;
	readonly rest: string;
}

// Splits a leading `/t/<slug>/` tenant prefix off a path. Returns the slug and the
// tenant-relative remainder, or undefined for a bare-host path — the control
// surface. A malformed or invalid slug also returns undefined, so a bad slug is
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
