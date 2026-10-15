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
	type NarCapturePageResult,
	NarSourceCaptureStore
} from './nar-source-capture.ts';
import {
	SharedNarDiscovery,
	type SharedNarDiscoveryPage
} from './shared-nar-discovery.ts';

const leaseDurationMs = 60_000;
const maximumJobGeneration = artifactJobGenerationSchema.parse(
	Number.MAX_SAFE_INTEGER
);
type Job = typeof schema.sharedListingJob.$inferSelect;
type DiscoveryPage =
	| { readonly kind: 'historical'; readonly page: SharedNarDiscoveryPage }
	| {
			readonly kind: 'catchup';
			readonly page: Extract<NarCapturePageResult, { kind: 'page' }>;
	  };

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
		> = new SharedNarDiscovery(database),
		private readonly capture: Pick<
			NarSourceCaptureStore,
			'page'
		> = new NarSourceCaptureStore(database)
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
			eventThrough: row.eventThrough ?? undefined,
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
			eq(schema.sharedListingJob.phase, claim.phase),
			claim.eventThrough === undefined
				? isNull(schema.sharedListingJob.eventThrough)
				: eq(schema.sharedListingJob.eventThrough, claim.eventThrough),
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
			phase: row.phase,
			eventCursor: row.eventCursor,
			eventThrough: row.eventThrough ?? undefined
		});
	}
	private readyCapturePosition() {
		return this.database
			.select({ latest: schema.narCaptureState.latest })
			.from(schema.narCaptureState)
			.where(
				and(
					eq(schema.narCaptureState.id, 1),
					eq(schema.narCaptureState.isReady, true)
				)
			);
	}

	private phaseAfter(page: DiscoveryPage): Job['phase'] {
		if (!page.page.isComplete) {
			return page.kind;
		}
		return page.kind === 'historical' ? 'catchup' : 'processing';
	}

	private async checkpoint(
		claim: SharedListingDiscoveryClaim,
		page: DiscoveryPage,
		now: IsoTimestamp
	): Promise<SharedListingJobSummary | undefined> {
		const pageId = crypto.randomUUID();
		const list = jsonRowList(
			page.page.sources.map((source) => ({
				id: artifactTaskIdSchema.parse(crypto.randomUUID()),
				...source
			}))
		);
		const capture = this.readyCapturePosition();
		const current = and(this.current(claim, now), exists(capture));
		const changes =
			page.kind === 'historical'
				? {
						cursor: page.page.cursor ?? sql`null`,
						eventThrough: page.page.isComplete ? sql`(${capture})` : sql`null`
					}
				: { eventCursor: page.page.cursor };
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
				sql`${now}`,
				sql`'pending'`,
				sql`0`,
				sql`0`,
				sql`null`,
				sql`null`,
				sql`${now}`,
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
				.onConflictDoUpdate({
					target: [
						schema.sharedListingTask.jobId,
						schema.sharedListingTask.narHash
					],
					set: {
						sourceIncarnation: sql`excluded.source_incarnation`,
						narSize: sql`excluded.nar_size`,
						fileSize: sql`excluded.file_size`,
						state: sql`CASE WHEN ${schema.sharedListingTask.state} = 'running' THEN 'pending' ELSE ${schema.sharedListingTask.state} END`,
						leaseExpiresAt: sql`null`,
						readyAt: now,
						updatedAt: now
					},
					setWhere: lt(
						schema.sharedListingTask.sourceIncarnation,
						sql`excluded.source_incarnation`
					)
				}),
			this.database
				.update(schema.sharedListingJob)
				.set({
					...changes,
					phase: this.phaseAfter(page),
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
	private async restartDiscovery(
		claim: SharedListingDiscoveryClaim,
		now: IsoTimestamp
	): Promise<SharedListingJobSummary | undefined> {
		const capture = this.readyCapturePosition();
		const current = and(this.current(claim, now), exists(capture));
		const rows = await this.database
			.update(schema.sharedListingJob)
			.set({
				phase: 'historical',
				cursor: sql`null`,
				eventCursor: sql`(${capture})`,
				eventThrough: sql`null`,
				owner: sql`null`,
				leaseExpiresAt: sql`null`,
				updatedAt: sql`max(${schema.sharedListingJob.updatedAt}, ${now})`
			})
			.where(current)
			.returning();
		return rows[0] === undefined ? undefined : this.decoded(rows[0]);
	}

	async start(
		generatorRevision: ListingGeneratorRevision,
		now: IsoTimestamp
	): Promise<SharedListingJobSummary> {
		return this.execute(async () => {
			const capture = this.readyCapturePosition();
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
			const capture = this.readyCapturePosition();
			const legacyWindow = sql`${schema.sharedListingJob.phase} = 'catchup' AND ${schema.sharedListingJob.eventThrough} IS NULL`;
			const available = and(
				this.version(job),
				eq(schema.sharedListingJob.state, 'running'),
				or(
					eq(schema.sharedListingJob.phase, 'historical'),
					eq(schema.sharedListingJob.phase, 'catchup')
				),
				exists(capture),
				lt(schema.sharedListingJob.claimGeneration, Number.MAX_SAFE_INTEGER),
				or(
					isNull(schema.sharedListingJob.owner),
					lte(schema.sharedListingJob.leaseExpiresAt, now)
				)
			);
			const rows = await this.database
				.update(schema.sharedListingJob)
				.set({
					phase: sql`CASE WHEN ${legacyWindow} THEN 'historical' ELSE ${schema.sharedListingJob.phase} END`,
					cursor: sql`CASE WHEN ${legacyWindow} THEN NULL ELSE ${schema.sharedListingJob.cursor} END`,
					eventCursor: sql`CASE WHEN ${legacyWindow} THEN (${capture}) ELSE ${schema.sharedListingJob.eventCursor} END`,
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
				(row.phase !== 'historical' && row.phase !== 'catchup') ||
				row.leaseExpiresAt === null ||
				row.leaseExpiresAt <= now
			) {
				return { kind: 'unavailable' };
			}
			if (row.phase === 'catchup' && row.eventThrough === null) {
				return { kind: 'busy', retryAt: row.leaseExpiresAt };
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
			if (claim.phase === 'historical') {
				const page = await this.discovery.page(claim.cursor);
				return this.checkpoint(
					claim,
					{ kind: 'historical', page },
					isoTimestamp(new Date())
				);
			}
			const page = await this.capture.page({
				after: claim.eventCursor,
				through: claim.eventThrough
			});
			if (page.kind === 'expired') {
				return this.restartDiscovery(claim, isoTimestamp(new Date()));
			}
			return this.checkpoint(
				claim,
				{ kind: 'catchup', page },
				isoTimestamp(new Date())
			);
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
