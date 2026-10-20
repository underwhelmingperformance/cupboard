import { type IsoTimestamp } from '@cupboard/protocol/scalars';
import { publicationIdSchema, type UploadId } from '@cupboard/protocol/upload';
import { and, asc, eq, lte, sql } from 'drizzle-orm';

import * as schema from '../db/schema.ts';
import {
	PublicationConflictError,
	PublicationRecoveryExpiredError
} from '../errors.ts';

import { armAlarmNoLaterThan } from './alarm.ts';
import type { ServerContext } from './context.ts';
import { parseStoredUploadPathMetadata } from './upload-metadata.ts';

const maxTerminalPublicationsPrunedPerRun = 1000;

const terminalPublicationStates = ['servable', 'failed', 'expired'] as const;

export class PublicationStore {
	constructor(private readonly context: ServerContext) {}

	get(id: UploadId) {
		if (!publicationIdSchema.safeParse(id).success) {
			return;
		}
		return this.context.db
			.select()
			.from(schema.publicationOperations)
			.where(eq(schema.publicationOperations.id, id))
			.get();
	}

	assertLive(id: UploadId, now = Date.now()): void {
		const operation = this.get(id);
		if (operation === undefined) {
			return;
		}
		if (operation.state === 'failed') {
			throw new PublicationConflictError(
				'The publication failed. Start a fresh push.'
			);
		}
		if (
			operation.state === 'expired' ||
			Date.parse(operation.recoveryDeadline) <= now
		) {
			throw new PublicationRecoveryExpiredError();
		}
	}

	graceDeadline(id: UploadId, candidate: IsoTimestamp): IsoTimestamp {
		this.context.db
			.update(schema.publicationOperations)
			.set({
				graceDeadline: sql`coalesce(${schema.publicationOperations.graceDeadline}, ${candidate})`
			})
			.where(eq(schema.publicationOperations.id, id))
			.run();
		return this.get(id)?.graceDeadline ?? candidate;
	}

	complete(
		pending: Pick<
			typeof schema.pendingUploads.$inferSelect,
			'id' | 'cacheId' | 'metadataJson'
		>
	): void {
		if (this.get(pending.id) === undefined) {
			return;
		}
		const metadata = parseStoredUploadPathMetadata(
			pending.id,
			pending.metadataJson
		);
		const identity = and(
			eq(schema.narInfos.cacheId, pending.cacheId),
			eq(schema.narInfos.storePathHash, metadata.storePathHash)
		);
		const result = this.context.db
			.select({
				storePathHash: schema.narInfos.storePathHash,
				narHash: schema.narInfos.narHash,
				generation: schema.narInfos.generation
			})
			.from(schema.narInfos)
			.where(identity)
			.get();
		this.finish(pending.id, 'servable', JSON.stringify(result));
	}

	finish(
		id: UploadId,
		state: 'accepted' | 'servable' | 'failed' | 'expired',
		resultJson?: string
	): void {
		if (!publicationIdSchema.safeParse(id).success) {
			return;
		}
		this.context.db
			.update(schema.publicationOperations)
			.set({ state, resultJson })
			.where(
				and(
					eq(schema.publicationOperations.id, id),
					eq(schema.publicationOperations.state, 'accepted')
				)
			)
			.run();
	}

	prune(now: string, limit = maxTerminalPublicationsPrunedPerRun): void {
		const ids = this.context.db
			.select({ id: schema.publicationOperations.id })
			.from(schema.publicationOperations)
			.where(
				and(
					sql`${schema.publicationOperations.state} IN ('servable', 'failed', 'expired')`,
					lte(schema.publicationOperations.pruneAfter, now)
				)
			)
			.limit(limit)
			.all();
		for (const { id } of ids) {
			this.context.db
				.delete(schema.publicationOperations)
				.where(eq(schema.publicationOperations.id, id))
				.run();
		}
	}

	// Wake for the next recovery deadline or the next terminal record to prune.
	// A pass that reached its prune limit leaves records that are already due,
	// so the alarm then fires at `notBefore` and the next pass continues.
	async armRecoveryAlarm(notBefore = Date.now()): Promise<void> {
		const deadline = this.context.db
			.select({ at: schema.publicationOperations.recoveryDeadline })
			.from(schema.publicationOperations)
			.where(eq(schema.publicationOperations.state, 'accepted'))
			.orderBy(asc(schema.publicationOperations.recoveryDeadline))
			.limit(1)
			.get();
		const pruneTimes = terminalPublicationStates.map((state) =>
			this.context.db
				.select({ at: schema.publicationOperations.pruneAfter })
				.from(schema.publicationOperations)
				.where(eq(schema.publicationOperations.state, state))
				.orderBy(asc(schema.publicationOperations.pruneAfter))
				.limit(1)
				.get()
		);
		const times = [deadline, ...pruneTimes]
			.filter((next) => next !== undefined)
			.map((next) => Date.parse(next.at));
		if (times.length === 0) {
			return;
		}
		await armAlarmNoLaterThan(
			this.context.ctx.storage,
			Math.max(notBefore, Math.min(...times))
		);
	}
}
