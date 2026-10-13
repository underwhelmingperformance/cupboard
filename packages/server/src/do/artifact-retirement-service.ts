import { and, asc, eq, ne, notExists, type SQL, sql } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

import * as schema from '../db/schema.ts';

import { ArtifactCasService } from './artifact-cas-service.ts';
import type { SchemaDatabase, ServerContext } from './context.ts';
import { hasSubrequestsFor } from './subrequest-slice.ts';

const maximumEntries = 8;
const maximumRows = 16;
const sharedRemovalSubrequests = 8;
type Retirement = typeof schema.artifactReferenceDeletion.$inferSelect;
type CleanupDatabase = Pick<SchemaDatabase, 'select' | 'delete'>;
type CleanupTable =
	| typeof schema.artifactParents
	| typeof schema.artifactRoots
	| typeof schema.narListings
	| typeof schema.buildLogs
	| typeof schema.buildTraceMappings
	| typeof schema.listingGenerationProofs;
interface CleanupPhase {
	readonly table: CleanupTable;
	readonly filter: SQL | undefined;
	readonly order: readonly (SQL | AnySQLiteColumn)[];
}

export interface ArtifactRetirementDrain {
	readonly referencesRemoved: number;
	readonly entriesCompleted: number;
	readonly rowsRemoved: number;
	readonly pending: boolean;
}

/**
Resumes captured artifact retirement within dispatch and local row limits.
*/
export class ArtifactRetirementService {
	constructor(private readonly context: ServerContext) {}

	private retirementFilter(entry: Retirement) {
		return and(
			eq(schema.artifactReferenceDeletion.artifactId, entry.artifactId),
			eq(
				schema.artifactReferenceDeletion.artifactGeneration,
				entry.artifactGeneration
			),
			eq(schema.artifactReferenceDeletion.cacheId, entry.cacheId),
			eq(schema.artifactReferenceDeletion.digest, entry.digest)
		);
	}

	private cleanupPhases(entry: Retirement): readonly CleanupPhase[] {
		const newerFilter = and(
			eq(schema.artifacts.id, entry.artifactId),
			ne(schema.artifacts.generation, entry.artifactGeneration)
		);
		const newer = this.context.db
			.select({ one: sql`1` })
			.from(schema.artifacts)
			.where(newerFilter);
		const noNewerArtifact = notExists(newer);
		return [
			{
				table: schema.artifactParents,
				filter: and(
					eq(schema.artifactParents.artifactId, entry.artifactId),
					eq(
						schema.artifactParents.artifactGeneration,
						entry.artifactGeneration
					)
				),
				order: [
					schema.artifactParents.storePathHash,
					schema.artifactParents.publicationGeneration
				]
			},
			{
				table: schema.artifactRoots,
				filter: and(
					eq(schema.artifactRoots.artifactId, entry.artifactId),
					eq(schema.artifactRoots.artifactGeneration, entry.artifactGeneration)
				),
				order: [schema.artifactRoots.kind]
			},
			{
				table: schema.narListings,
				filter: and(
					eq(schema.narListings.artifactId, entry.artifactId),
					noNewerArtifact
				),
				order: [schema.narListings.artifactId]
			},
			{
				table: schema.buildLogs,
				filter: and(
					eq(schema.buildLogs.artifactId, entry.artifactId),
					noNewerArtifact
				),
				order: [schema.buildLogs.artifactId]
			},
			{
				table: schema.buildTraceMappings,
				filter: and(
					eq(schema.buildTraceMappings.artifactId, entry.artifactId),
					noNewerArtifact
				),
				order: [sql`rowid`]
			},
			{
				table: schema.listingGenerationProofs,
				filter: and(
					eq(schema.listingGenerationProofs.artifactId, entry.artifactId),
					noNewerArtifact
				),
				order: [schema.listingGenerationProofs.artifactId]
			}
		];
	}

	private cleanupPage(
		database: CleanupDatabase,
		phase: CleanupPhase,
		limit: number
	): number {
		const selected = database
			.select({ row: sql<number>`rowid` })
			.from(phase.table)
			.where(phase.filter)
			.orderBy(...phase.order)
			.limit(limit);
		const rows = database
			.delete(phase.table)
			.where(sql`rowid in (${selected})`)
			.returning({ id: phase.table.artifactId })
			.all();
		return rows.length;
	}

	private cleanupEntry(entry: Retirement, allowance: number) {
		const phases = this.cleanupPhases(entry);
		const artifactFilter = and(
			eq(schema.artifacts.id, entry.artifactId),
			eq(schema.artifacts.generation, entry.artifactGeneration),
			eq(schema.artifacts.state, 'retired')
		);
		return this.context.db.transaction((transaction) => {
			let rowsRemoved = 0;
			for (const phase of phases) {
				const remaining = allowance - rowsRemoved;
				if (remaining === 0) {
					return { rowsRemoved, completed: false };
				}
				rowsRemoved += this.cleanupPage(transaction, phase, remaining);
			}
			if (allowance - rowsRemoved < 2) {
				return { rowsRemoved, completed: false };
			}
			const artifacts = transaction
				.delete(schema.artifacts)
				.where(artifactFilter)
				.returning({ id: schema.artifacts.id })
				.all();
			const retired = transaction
				.delete(schema.artifactReferenceDeletion)
				.where(this.retirementFilter(entry))
				.returning({ id: schema.artifactReferenceDeletion.artifactId })
				.all();
			return {
				rowsRemoved: rowsRemoved + artifacts.length + retired.length,
				completed: retired.length > 0
			};
		});
	}

	hasPending(): boolean {
		return (
			this.context.db
				.select({ id: schema.artifactReferenceDeletion.artifactId })
				.from(schema.artifactReferenceDeletion)
				.limit(1)
				.get() !== undefined
		);
	}

	/**
	The caller keeps the tenant critical section open through shared removal and local acknowledgement.
	*/
	async drainInSection(): Promise<ArtifactRetirementDrain> {
		const entries = this.context.db
			.select()
			.from(schema.artifactReferenceDeletion)
			.orderBy(
				asc(schema.artifactReferenceDeletion.artifactId),
				asc(schema.artifactReferenceDeletion.artifactGeneration)
			)
			.limit(maximumEntries)
			.all();
		let referencesRemoved = 0;
		let entriesCompleted = 0;
		let rowsRemoved = 0;
		for (const entry of entries) {
			if (rowsRemoved >= maximumRows) {
				break;
			}
			if (!entry.referenceRemoved) {
				if (!hasSubrequestsFor(sharedRemovalSubrequests)) {
					break;
				}
				const cache = this.context.cacheRepository.resolvedForId(entry.cacheId);
				const outcome = await new ArtifactCasService(
					this.context
				).removeCapturedInSection({
					artifactId: entry.artifactId,
					artifactGeneration: entry.artifactGeneration,
					digest: entry.digest,
					cache
				});
				if (outcome === 'deferred') {
					break;
				}
				if (outcome === 'removed') {
					referencesRemoved += 1;
				}
				this.context.db
					.update(schema.artifactReferenceDeletion)
					.set({ referenceRemoved: true })
					.where(this.retirementFilter(entry))
					.run();
			}
			const cleanup = this.cleanupEntry(entry, maximumRows - rowsRemoved);
			rowsRemoved += cleanup.rowsRemoved;
			if (cleanup.completed) {
				entriesCompleted += 1;
			}
		}
		const pending = this.context.db
			.select({ id: schema.artifactReferenceDeletion.artifactId })
			.from(schema.artifactReferenceDeletion)
			.limit(1)
			.get();
		return {
			referencesRemoved,
			entriesCompleted,
			rowsRemoved,
			pending: pending !== undefined
		};
	}
}
