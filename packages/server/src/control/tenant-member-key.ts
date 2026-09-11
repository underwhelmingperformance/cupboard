import { type TenantId } from '@cupboard/nix-store/scalars';

const memberKeyPrefix = 'tenant-member:';

/**
 * The KV key under which a tenant's membership marker is stored.
 *
 * This module holds nothing but the key so that a Node-side test harness can
 * write the marker without pulling the admission code, and the Workers types it
 * needs, into its own TypeScript program.
 */
export function tenantMemberKey(slug: TenantId): string {
	return `${memberKeyPrefix}${slug}`;
}
