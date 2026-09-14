import {
	storedAuthorizationDetailsSchema,
	storedPermittedGrantsSchema
} from '@cupboard/protocol/grants';
import { eq, sql } from 'drizzle-orm';

import * as schema from '../db/schema.ts';
import type { ServerContext } from '../do/context.ts';

export const grantContractionBatchSize = 100;

/**
Rewrites one bounded batch of each kind of stored grant.
*/
export function contractCacheGrants(context: ServerContext): {
	status: 'complete' | 'pending';
} {
	if (context.grantsContracted) {
		return { status: 'complete' };
	}

	const isComplete = context.db.transaction((transaction) => {
		const rules = transaction
			.select({
				id: schema.oidcTrust.id,
				grants: schema.oidcTrust.permittedGrantsJson
			})
			.from(schema.oidcTrust)
			.where(
				sql`exists (select 1 from json_each(${schema.oidcTrust.permittedGrantsJson}) as grant where json_extract(grant.value, '$.type') = 'cupboard_cache' and json_extract(grant.value, '$.resources.cache.kind') is null)`
			)
			.orderBy(schema.oidcTrust.id)
			.limit(grantContractionBatchSize)
			.all();
		const families = transaction
			.select({
				id: schema.refreshTokenFamilies.id,
				grants: schema.refreshTokenFamilies.grantsJson
			})
			.from(schema.refreshTokenFamilies)
			.where(
				sql`exists (select 1 from json_each(${schema.refreshTokenFamilies.grantsJson}) as grant where json_extract(grant.value, '$.type') = 'cupboard_cache' and json_extract(grant.value, '$.cache.kind') is null)`
			)
			.orderBy(schema.refreshTokenFamilies.id)
			.limit(grantContractionBatchSize)
			.all();

		for (const rule of rules) {
			const grants = storedPermittedGrantsSchema.parse(JSON.parse(rule.grants));
			transaction
				.update(schema.oidcTrust)
				.set({ permittedGrantsJson: JSON.stringify(grants) })
				.where(eq(schema.oidcTrust.id, rule.id))
				.run();
		}
		for (const family of families) {
			const grants = storedAuthorizationDetailsSchema.parse(
				JSON.parse(family.grants ?? 'null')
			);
			transaction
				.update(schema.refreshTokenFamilies)
				.set({ grantsJson: JSON.stringify(grants) })
				.where(eq(schema.refreshTokenFamilies.id, family.id))
				.run();
		}
		if (
			rules.length === grantContractionBatchSize ||
			families.length === grantContractionBatchSize
		) {
			return false;
		}

		transaction
			.update(schema.grantContraction)
			.set({ complete: true })
			.where(eq(schema.grantContraction.id, 1))
			.run();
		return true;
	});
	context.grantsContracted = isComplete;
	return { status: isComplete ? 'complete' : 'pending' };
}
