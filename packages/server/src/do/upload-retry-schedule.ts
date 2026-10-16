import { type UploadId } from '@cupboard/protocol/upload';
import { type SQL, sql } from 'drizzle-orm';

import * as schema from '../db/schema.ts';

import { type ServerContext } from './context.ts';
import { RetryClockService } from './retry-clock-service.ts';

export class UploadRetrySchedule {
	constructor(private readonly context: ServerContext) {}

	private firstAt(
		phase: 'fresh' | 'recorded',
		excluded: readonly UploadId[] = []
	): number | undefined {
		const readyAt =
			phase === 'recorded'
				? sql<string>`CASE WHEN ${schema.pendingUploads.recordedVerdictJson} IS NOT NULL THEN COALESCE(${schema.pendingUploads.settleRetryAfter}, '') ELSE MAX(COALESCE(${schema.pendingUploads.settleRetryAfter}, ''), COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', ${schema.pendingUploads.claimedAt}, '+360 seconds'), '')) END`
				: sql<string>`MAX(COALESCE(${schema.pendingUploads.settleRetryAfter}, ''), COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', ${schema.pendingUploads.claimedAt}, '+360 seconds'), ''))`;
		const row = this.context.db.all<{ readyAt: string }>(
			phase === 'recorded'
				? sql`SELECT ${readyAt} AS readyAt FROM pending_upload INDEXED BY pending_upload_recorded_ready_idx
				WHERE (recorded_verdict_json IS NOT NULL OR settle_exhaustion IS NOT NULL)${excludedIds(excluded)} ORDER BY ${readyAt}, id LIMIT 1`
				: sql`SELECT ${readyAt} AS readyAt FROM pending_upload INDEXED BY pending_upload_fresh_ready_idx
				WHERE (verdict = 'pending' OR verdict = 'committing') AND (recorded_verdict_json IS NULL OR claim_owner IS NULL) AND settle_exhaustion IS NULL
				ORDER BY ${readyAt}, id LIMIT 1`
		)[0];

		if (row === undefined) {
			return undefined;
		}
		return row.readyAt === ''
			? Date.now()
			: Math.max(Date.now(), Date.parse(row.readyAt));
	}

	projectedAt(): number | undefined {
		const pending = [this.firstAt('fresh'), this.firstAt('recorded')].filter(
			(at) => at !== undefined
		);
		return pending.length === 0 ? undefined : Math.min(...pending);
	}

	freshAt(): number | undefined {
		return new RetryClockService(this.context).isBlocked()
			? undefined
			: this.firstAt('fresh');
	}

	/**
	 * When the earliest recorded verdict or exhausted upload becomes ready,
	 * ignoring the uploads in `excluded`.
	 */
	recordedAt(excluded: readonly UploadId[] = []): number | undefined {
		return new RetryClockService(this.context).isBlocked()
			? undefined
			: this.firstAt('recorded', excluded);
	}
}

function excludedIds(excluded: readonly UploadId[]): SQL {
	return excluded.length === 0
		? sql``
		: sql` AND id NOT IN (SELECT value FROM json_each(${JSON.stringify(excluded)}))`;
}
