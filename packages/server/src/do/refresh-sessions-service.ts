import { isoTimestamp } from '@cupboard/protocol/scalars';
import {
	type RefreshSessionId,
	type RefreshSessionListResponseInput,
	type RefreshSessionRevokeResponseInput,
	type RefreshSessionSummaryInput
} from '@cupboard/protocol/sessions';
import { asc, eq, gt } from 'drizzle-orm';

import * as schema from '../db/schema.ts';

import { type SchemaWriter, type ServerContext } from './context.ts';

type RefreshTokenFamily = typeof schema.refreshTokenFamilies.$inferSelect;
type RefreshFamilyDeletion = 'deleted' | 'absent';

export function deleteRefreshFamily(
	database: SchemaWriter,
	familyId: string
): RefreshFamilyDeletion {
	database
		.delete(schema.refreshTokenMembers)
		.where(eq(schema.refreshTokenMembers.familyId, familyId))
		.run();

	const deleted = database
		.delete(schema.refreshTokenFamilies)
		.where(eq(schema.refreshTokenFamilies.id, familyId))
		.returning({ id: schema.refreshTokenFamilies.id })
		.all();

	return deleted.length > 0 ? 'deleted' : 'absent';
}

export class RefreshSessionsService {
	constructor(private readonly context: ServerContext) {}

	list(): RefreshSessionListResponseInput {
		const now = isoTimestamp(new Date());
		const families = this.context.db
			.select()
			.from(schema.refreshTokenFamilies)
			.where(gt(schema.refreshTokenFamilies.expiresAt, now))
			.orderBy(
				asc(schema.refreshTokenFamilies.createdAt),
				asc(schema.refreshTokenFamilies.id)
			)
			.all();

		return { sessions: families.map((family) => sessionSummary(family)) };
	}

	revoke(id: RefreshSessionId): RefreshSessionRevokeResponseInput {
		const deletion = this.context.db.transaction((transaction) =>
			deleteRefreshFamily(transaction, id)
		);

		return { id, revoked: deletion === 'deleted' };
	}
}

function sessionSummary(
	family: RefreshTokenFamily
): RefreshSessionSummaryInput {
	return {
		id: family.id,
		...(family.issuer !== null && { issuer: family.issuer }),
		...(family.subject !== null && { subject: family.subject }),
		...(family.rule !== null && { rule: family.rule }),
		createdAt: family.createdAt,
		expiresAt: family.expiresAt
	};
}
