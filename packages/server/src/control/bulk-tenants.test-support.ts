import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import { env } from 'cloudflare:workers';
import { onTestFinished } from 'vitest';

import { tenantMemberKey } from './tenant-member-key.ts';

const bulkPrefix = 'bulk';

/**
Adds `count` active tenants with the ids `bulk000001` onwards, which sort
before the fixture tenant's id. The test's cleanup deletes them and their
membership markers.
*/
export async function insertBulkTenants(count: number): Promise<void> {
	await env.CUPBOARD_DB.prepare(
		`WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < ?1)
		INSERT INTO tenant (id, status, owner_issuer, owner_subject, owner_audience, config_version, created_at)
		SELECT printf('${bulkPrefix}%06d', n), 'active', '', '', '', 1, '2026-01-01T00:00:00.000Z' FROM sequence`
	)
		.bind(count)
		.run();
	onTestFinished(async () => {
		await env.CUPBOARD_DB.prepare(
			`DELETE FROM tenant WHERE id LIKE '${bulkPrefix}%'`
		).run();

		const prefix = tenantMemberKey(tenantIdSchema.parse(bulkPrefix));
		let cursor: string | undefined;

		// A KV listing returns at most 1,000 keys, so follow its cursor.
		do {
			const markers = await env.TENANT_CACHE.list({
				prefix,
				...(cursor !== undefined && { cursor })
			});
			await Promise.all(
				markers.keys.map((key) => env.TENANT_CACHE.delete(key.name))
			);
			cursor = markers.list_complete ? undefined : markers.cursor;
		} while (cursor !== undefined);
	});
}
