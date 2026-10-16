import {
	cacheGenerationSchema,
	narInfoGenerationSchema,
	nixSha256HashSchema,
	storePathHashSchema,
	type TenantId,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from './d1-schema.ts';
import {
	SharedNarDiscovery,
	type SharedNarSource
} from './shared-nar-discovery.ts';

const now = isoTimestamp(new Date('2026-01-01T00:00:00.000Z'));
const firstTenant = tenantIdSchema.parse('discovery-first');
const secondTenant = tenantIdSchema.parse('discovery-second');

export function sharedNarSource(index: number): SharedNarSource {
	return {
		narHash: nixSha256HashSchema.parse(
			`sha256:${String(index).padStart(52, '0')}`
		),
		sourceIncarnation: 2,
		narSize: 200,
		fileSize: 100
	};
}

export async function sharedNarDiscoveryFixture(count = 1) {
	const database = drizzle(env.CUPBOARD_DB, { schema });
	const tenantInsert = (id: TenantId) =>
		database.insert(schema.tenant).values({
			id,
			status: 'active',
			ownerIssuer: 'https://issuer.example',
			ownerSubject: 'subject',
			ownerAudience: 'cupboard',
			configVersion: 1,
			createdAt: now
		});
	await database.batch([tenantInsert(firstTenant), tenantInsert(secondTenant)]);
	const sources = Array.from({ length: count }, (_, index) =>
		sharedNarSource(index)
	);
	for (const [index, item] of sources.entries()) {
		const referenceInsert = (tenant: TenantId) =>
			database.insert(schema.blobReference).values({
				tenant,
				cacheKind: 'default',
				cacheGeneration: cacheGenerationSchema.parse(1),
				storePathHash: storePathHashSchema.parse(
					String(index).padStart(32, '0')
				),
				generation: narInfoGenerationSchema.parse(1),
				narHash: item.narHash
			});
		await database.batch([
			database.insert(schema.blobState).values({
				narHash: item.narHash,
				fileHash: item.narHash,
				fileSize: item.fileSize,
				narSize: item.narSize,
				compression: 'zstd',
				incarnation: item.sourceIncarnation,
				verifiedAt: now
			}),
			database.insert(schema.objectIncarnation).values({
				kind: 'nar',
				objectId: item.narHash,
				incarnation: item.sourceIncarnation,
				state: 'live',
				updatedAt: now
			}),
			referenceInsert(firstTenant),
			referenceInsert(secondTenant)
		]);
	}
	return { database, sources, discovery: new SharedNarDiscovery(database) };
}
