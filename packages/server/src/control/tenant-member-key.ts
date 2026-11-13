import { type TenantId } from '@cupboard/nix-store/scalars';

/**
The prefix that every membership marker key starts with. A KV listing with
this prefix returns exactly the markers.
*/
export const tenantMemberKeyPrefix = 'tenant-member:';

/**
The KV key under which a tenant's membership marker is stored.

This module holds nothing but the key so that a Node-side test harness can
write the marker without pulling the admission code, and the Workers types it
needs, into its own TypeScript program.
*/
export function tenantMemberKey(slug: TenantId): string {
	return `${tenantMemberKeyPrefix}${slug}`;
}

/**
The slug in a membership marker key. A listing by `tenantMemberKeyPrefix` returns
only keys that start with it.
*/
export function tenantMemberSlug(key: string): string {
	return key.slice(tenantMemberKeyPrefix.length);
}
