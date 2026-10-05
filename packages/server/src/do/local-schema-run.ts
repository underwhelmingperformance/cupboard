import { type TenantId } from '@cupboard/nix-store/scalars';
import { type TenantSchemaMigration } from '@cupboard/protocol/deployment';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { and, eq, type SQL, sql } from 'drizzle-orm';

import journal from '../../drizzle/meta/_journal.json' with { type: 'json' };
import * as d1Schema from '../db/d1-schema.ts';
import { summariseLocalStepError } from '../db/local-step-attempts.ts';
import {
	CacheCatalogueMigrationPendingError,
	LocalSchemaMigrationPendingError
} from '../errors.ts';

import { type ServerContext } from './context.ts';

export const currentLocalSchemaVersion = Math.max(
	...journal.entries.map((entry) => entry.idx)
);

export function belowLocalSchema(): SQL {
	const { localSchemaVersion } = d1Schema.tenant;

	return sql`(${localSchemaVersion} IS NULL OR ${localSchemaVersion} < ${currentLocalSchemaVersion})`;
}

const reportedSchemaKey = 'migration:reported-schema';
const progressWriteIntervalMs = 30_000;

/**
 * Reports schema completion and pending migration work to the control plane.
 * The journal's final index defines the required schema, independently of the
 * local steps for data work.
 */
export class LocalSchemaRun {
	private progressWrittenAt: number | undefined;

	constructor(private readonly context: ServerContext) {}

	async reportError(
		error: unknown,
		tenant: TenantId | undefined
	): Promise<void> {
		if (tenant === undefined) {
			return;
		}

		const isPending =
			error instanceof LocalSchemaMigrationPendingError ||
			error instanceof CacheCatalogueMigrationPendingError;
		const isProgressed =
			error instanceof CacheCatalogueMigrationPendingError ||
			(error instanceof LocalSchemaMigrationPendingError &&
				error.pending.hasCommitted);

		const now = Date.now();

		if (
			isProgressed &&
			this.progressWrittenAt !== undefined &&
			now - this.progressWrittenAt < progressWriteIntervalMs
		) {
			return;
		}

		const at = isoTimestamp(new Date(now));

		await this.context.d1
			.update(d1Schema.tenant)
			.set({
				localStepAttemptedAt: at,
				localStepError: isPending ? sql`null` : summariseLocalStepError(error),
				...(isProgressed && { localStepProgressedAt: at }),
				localSchemaMigration:
					error instanceof LocalSchemaMigrationPendingError
						? JSON.stringify({
								migration: error.migration,
								stage: error.stage,
								cursor: error.pending.cursor
							} satisfies TenantSchemaMigration)
						: sql`null`
			})
			.where(and(eq(d1Schema.tenant.id, tenant), belowLocalSchema()))
			.run();

		this.progressWrittenAt = isProgressed ? now : undefined;
	}

	async complete(tenant: TenantId): Promise<void> {
		if (
			(await this.context.ctx.storage.get(reportedSchemaKey)) ===
			currentLocalSchemaVersion
		) {
			return;
		}

		await this.context.d1
			.update(d1Schema.tenant)
			.set({
				localSchemaVersion: currentLocalSchemaVersion,
				localSchemaMigration: sql`null`,
				localStepAttemptedAt: sql`null`,
				localStepError: sql`null`,
				localStepProgressedAt: isoTimestamp(new Date())
			})
			.where(and(eq(d1Schema.tenant.id, tenant), belowLocalSchema()))
			.run();

		await this.context.ctx.storage.put(
			reportedSchemaKey,
			currentLocalSchemaVersion
		);
	}
}
