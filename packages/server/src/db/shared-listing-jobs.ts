import {
	artifactJobGenerationSchema,
	type ArtifactJobId,
	artifactJobIdSchema,
	type ArtifactJobVersion,
	artifactTaskIdSchema,
	type ArtifactTaskOwner
} from '@cupboard/protocol/artifact-jobs';
import { type ListingGeneratorRevision } from '@cupboard/protocol/artifacts';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { and, eq, exists, gt, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import {
	type SharedListingDiscoveryClaim,
	type SharedListingDiscoveryClaimResult,
	sharedListingDiscoveryClaimSchema,
	type SharedListingJobSummary,
	sharedListingJobSummarySchema
} from '../blob/shared-listing-jobs.ts';
import { jsonRowList } from '../do/json-list.ts';
import { SharedFactsUnavailableError } from '../errors.ts';

import * as schema from './d1-schema.ts';
import {
	SharedNarDiscovery,
	type SharedNarDiscoveryPage
} from './shared-nar-discovery.ts';

const leaseDurationMs = 60_000;
const maximumJobGeneration = artifactJobGenerationSchema.parse(
	Number.MAX_SAFE_INTEGER
);
type Job = typeof schema.sharedListingJob.$inferSelect;

/**
 * Persists global discovery checkpoints. Jobs and source tasks do not retain
 * NARs or grant cache publication authority.
 */
export class SharedListingJobStore {
	constructor(
		private readonly database: DrizzleD1Database<typeof schema>,
		private readonly discovery: Pick<
			SharedNarDiscovery,
			'page'
		> = new SharedNarDiscovery(database)
	) {}

	private async execute<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			if (error instanceof SharedFactsUnavailableError) {
				throw error;
			}
			throw new SharedFactsUnavailableError(error);
		}
	}
	private decoded(row: Job): SharedListingJobSummary {
		return sharedListingJobSummarySchema.parse({
			id: row.id,
			generation: row.generation,
			generatorRevision: row.generatorRevision,
			state: row.state,
			phase: row.phase,
			cursor: row.cursor ?? undefined,
			eventCursor: row.eventCursor,
			progress: {
				discovered: row.discovered,
				completed: row.completed,
				skipped: row.skipped,
				failed: row.failed
			},
			createdAt: row.createdAt,
			updatedAt: row.updatedAt
		});
	}
	private version(job: ArtifactJobVersion) {
		return and(
			eq(schema.sharedListingJob.id, job.id),
			eq(schema.sharedListingJob.generation, job.generation)
		);
	}
	private current(claim: SharedListingDiscoveryClaim, now: IsoTimestamp) {
		return and(
			this.version(claim.job),
			eq(schema.sharedListingJob.state, 'running'),
			eq(schema.sharedListingJob.phase, 'historical'),
			eq(schema.sharedListingJob.owner, claim.owner),
			eq(schema.sharedListingJob.claimGeneration, claim.generation),
			eq(schema.sharedListingJob.eventCursor, claim.eventCursor),
			gt(schema.sharedListingJob.leaseExpiresAt, now),
			claim.cursor === undefined
				? isNull(schema.sharedListingJob.cursor)
				: eq(schema.sharedListingJob.cursor, claim.cursor)
		);
	}
	private claimOf(row: Job): SharedListingDiscoveryClaim {
		return sharedListingDiscoveryClaimSchema.parse({
			job: { id: row.id, generation: row.generation },
			owner: row.owner,
			generation: row.claimGeneration,
			leaseExpiresAt: row.leaseExpiresAt,
			cursor: row.cursor ?? undefined,
			eventCursor: row.eventCursor
		});
	}
	private async checkpoint(
		claim: SharedListingDiscoveryClaim,
		page: SharedNarDiscoveryPage,
		now: IsoTimestamp
	): Promise<SharedListingJobSummary | undefined> {
		const pageId = crypto.randomUUID();
		const list = jsonRowList(
			page.sources.map((source) => ({
				id: artifactTaskIdSchema.parse(crypto.randomUUID()),
				...source
			}))
		);
		const current = this.current(claim, now);
		const active = this.database
			.select({ one: sql`1` })
			.from(schema.sharedListingJob)
			.where(current);
		const source = list
			.insertSource([
				list.column('id'),
				sql`${claim.job.id}`,
				list.column('narHash'),
				list.column('sourceIncarnation'),
				list.column('narSize'),
				list.column('fileSize'),
				sql`${pageId}`,
				sql`${now}`
			])
			.append(sql` AND ${exists(active)}`);
		const insertedCount = this.database
			.select({ count: sql<number>`count(*)` })
			.from(schema.sharedListingTask)
			.where(eq(schema.sharedListingTask.discoveryPage, pageId));
		const [, rows] = await this.database.batch([
			this.database
				.insert(schema.sharedListingTask)
				.select(source)
				.onConflictDoNothing({
					target: [
						schema.sharedListingTask.jobId,
						schema.sharedListingTask.narHash
					]
				}),
			this.database
				.update(schema.sharedListingJob)
				.set({
					cursor: page.cursor ?? sql`null`,
					phase: page.isComplete ? 'catchup' : 'historical',
					discovered: sql`${schema.sharedListingJob.discovered} + (${insertedCount})`,
					owner: sql`null`,
					leaseExpiresAt: sql`null`,
					updatedAt: sql`max(${schema.sharedListingJob.updatedAt}, ${now})`
				})
				.where(current)
				.returning()
		]);
		const row = rows[0];
		return row === undefined ? undefined : this.decoded(row);
	}
	async start(
		generatorRevision: ListingGeneratorRevision,
		now: IsoTimestamp
	): Promise<SharedListingJobSummary> {
		return this.execute(async () => {
			const capture = this.database
				.select({ latest: schema.narCaptureState.latest })
				.from(schema.narCaptureState)
				.where(
					and(
						eq(schema.narCaptureState.id, 1),
						eq(schema.narCaptureState.isReady, true)
					)
				);
			const rows = await this.database
				.insert(schema.sharedListingJob)
				.values({
					id: artifactJobIdSchema.parse(crypto.randomUUID()),
					generation: artifactJobGenerationSchema.parse(1),
					generatorRevision,
					eventCursor: sql`(${capture})`,
					createdAt: now,
					updatedAt: now
				})
				.returning();
			const row = rows[0];
			if (row === undefined) {
				throw new Error('The shared listing job was not inserted');
			}
			return this.decoded(row);
		});
	}
	async find(id: ArtifactJobId): Promise<SharedListingJobSummary | undefined> {
		return this.execute(async () => {
			const row = await this.database
				.select()
				.from(schema.sharedListingJob)
				.where(eq(schema.sharedListingJob.id, id))
				.get();
			return row === undefined ? undefined : this.decoded(row);
		});
	}
	async claim(
		job: ArtifactJobVersion,
		owner: ArtifactTaskOwner,
		now: IsoTimestamp
	): Promise<SharedListingDiscoveryClaimResult> {
		return this.execute(async () => {
			const deadline = isoTimestamp(
				new Date(Date.parse(now) + leaseDurationMs)
			);
			const available = and(
				this.version(job),
				eq(schema.sharedListingJob.state, 'running'),
				eq(schema.sharedListingJob.phase, 'historical'),
				lt(schema.sharedListingJob.claimGeneration, Number.MAX_SAFE_INTEGER),
				or(
					isNull(schema.sharedListingJob.owner),
					lte(schema.sharedListingJob.leaseExpiresAt, now)
				)
			);
			const rows = await this.database
				.update(schema.sharedListingJob)
				.set({
					owner,
					claimGeneration: sql`${schema.sharedListingJob.claimGeneration} + 1`,
					leaseExpiresAt: deadline,
					updatedAt: sql`max(${schema.sharedListingJob.updatedAt}, ${now})`
				})
				.where(available)
				.returning();
			const inserted = rows[0];
			if (inserted !== undefined) {
				return { kind: 'claimed', claim: this.claimOf(inserted) };
			}
			const row = await this.database
				.select()
				.from(schema.sharedListingJob)
				.where(this.version(job))
				.get();
			if (
				row?.state !== 'running' ||
				row.phase !== 'historical' ||
				row.leaseExpiresAt === null ||
				row.leaseExpiresAt <= now
			) {
				return { kind: 'unavailable' };
			}
			return row.owner === owner
				? { kind: 'claimed', claim: this.claimOf(row) }
				: { kind: 'busy', retryAt: row.leaseExpiresAt };
		});
	}
	async renew(
		claim: SharedListingDiscoveryClaim,
		now: IsoTimestamp
	): Promise<IsoTimestamp | undefined> {
		return this.execute(async () => {
			const deadline = isoTimestamp(
				new Date(Date.parse(now) + leaseDurationMs)
			);
			const rows = await this.database
				.update(schema.sharedListingJob)
				.set({
					leaseExpiresAt: sql`max(${schema.sharedListingJob.leaseExpiresAt}, ${deadline})`,
					updatedAt: sql`max(${schema.sharedListingJob.updatedAt}, ${now})`
				})
				.where(this.current(claim, now))
				.returning({ at: schema.sharedListingJob.leaseExpiresAt });
			return rows[0]?.at ?? undefined;
		});
	}
	async discover(
		claim: SharedListingDiscoveryClaim
	): Promise<SharedListingJobSummary | undefined> {
		return this.execute(async () => {
			const now = isoTimestamp(new Date());
			const current = await this.database
				.select({ id: schema.sharedListingJob.id })
				.from(schema.sharedListingJob)
				.where(this.current(claim, now))
				.get();
			if (current === undefined) {
				return;
			}
			const page = await this.discovery.page(claim.cursor);
			return this.checkpoint(claim, page, isoTimestamp(new Date()));
		});
	}
	async cancel(
		job: ArtifactJobVersion,
		now: IsoTimestamp
	): Promise<SharedListingJobSummary | undefined> {
		return this.execute(async () => {
			const rows = await this.database
				.update(schema.sharedListingJob)
				.set({
					state: 'cancelled',
					owner: sql`null`,
					leaseExpiresAt: sql`null`,
					updatedAt: sql`max(${schema.sharedListingJob.updatedAt}, ${now})`
				})
				.where(
					and(this.version(job), eq(schema.sharedListingJob.state, 'running'))
				)
				.returning();
			const row = rows[0];
			if (row !== undefined) {
				return this.decoded(row);
			}
			const existing = await this.find(job.id);
			return existing?.generation === job.generation &&
				existing.state === 'cancelled'
				? existing
				: undefined;
		});
	}
	async resume(
		job: ArtifactJobVersion,
		now: IsoTimestamp
	): Promise<SharedListingJobSummary | undefined> {
		return this.execute(async () => {
			const rows = await this.database
				.update(schema.sharedListingJob)
				.set({
					state: 'running',
					generation: sql`${schema.sharedListingJob.generation} + 1`,
					owner: sql`null`,
					leaseExpiresAt: sql`null`,
					updatedAt: sql`max(${schema.sharedListingJob.updatedAt}, ${now})`
				})
				.where(
					and(
						this.version(job),
						eq(schema.sharedListingJob.state, 'cancelled'),
						lt(schema.sharedListingJob.generation, maximumJobGeneration)
					)
				)
				.returning();
			const row = rows[0];
			if (row !== undefined) {
				return this.decoded(row);
			}
			const existing = await this.find(job.id);
			return existing?.generation === job.generation + 1 &&
				existing.state === 'running'
				? existing
				: undefined;
		});
	}
}
