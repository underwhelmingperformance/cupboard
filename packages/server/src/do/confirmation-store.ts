import type { CacheScope, TenantId } from '@cupboard/nix-store/scalars';
import { uploadConfirmPresentCanonicalPage } from '@cupboard/protocol/publication';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import type { UploadConfirmPresentRequest } from '@cupboard/protocol/upload';
import { asc, eq, lte, sql } from 'drizzle-orm';

import * as schema from '../db/schema.ts';

import { armAlarmNoLaterThan } from './alarm.ts';
import type { SchemaWriter, ServerContext } from './context.ts';

export const confirmationPruneLimit = 100;

export async function confirmationIdentity(
	tenant: TenantId,
	cache: CacheScope,
	request: UploadConfirmPresentRequest
): Promise<{ readonly id: string; readonly canonical: string }> {
	const canonical = uploadConfirmPresentCanonicalPage({
		tenant,
		cache,
		...request
	});
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(canonical)
	);
	const id = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, '0')
	).join('');
	return { id, canonical };
}

export class ConfirmationStore {
	constructor(private readonly context: ServerContext) {}

	get(id: string, database: SchemaWriter = this.context.db) {
		return database
			.select()
			.from(schema.confirmationReceipts)
			.where(eq(schema.confirmationReceipts.id, id))
			.get();
	}

	prune(now = isoTimestamp(new Date())): void {
		const table = schema.confirmationReceipts;
		this.context.db
			.delete(table)
			.where(
				sql`${table.id} in (${this.context.db
					.select({ id: table.id })
					.from(table)
					.where(lte(table.pruneAfter, now))
					.orderBy(asc(table.pruneAfter))
					.limit(confirmationPruneLimit)})`
			)
			.run();
	}

	async armAlarm(notBefore = Date.now()): Promise<void> {
		const next = this.context.db
			.select({ at: schema.confirmationReceipts.pruneAfter })
			.from(schema.confirmationReceipts)
			.orderBy(asc(schema.confirmationReceipts.pruneAfter))
			.limit(1)
			.get();
		if (next === undefined) {
			return;
		}
		await armAlarmNoLaterThan(
			this.context.ctx.storage,
			Math.max(notBefore, Date.parse(next.at))
		);
	}
}
