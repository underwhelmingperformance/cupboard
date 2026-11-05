import {
	type CacheScope,
	type StorePathHash
} from '@cupboard/nix-store/scalars';
import {
	trailingEligibilitySubrequests,
	uploadConfirmPresentMaxPathsFor,
	type UploadConfirmPresentPath,
	type UploadConfirmPresentRequest,
	type UploadConfirmPresentResponse
} from '@cupboard/protocol/upload';
import { eq } from 'drizzle-orm';

import type { NarInfoReferenceVersion } from '../blob/narinfo-object-metadata.ts';
import type { ResolvedCache } from '../db/cache.ts';
import { currentCacheGeneration } from '../db/cache-generation.ts';
import * as d1Schema from '../db/d1-schema.ts';
import type * as schema from '../db/schema.ts';
import {
	PublicationConflictError,
	TenantUsageMissingError,
	TenantWritesStoppedError,
	UploadRequestLimitExceededError
} from '../errors.ts';
import { assertRetentionMigrationSettled } from '../migration/cache-retention.ts';
import { requireServedStorePaths } from '../policy/served-store.ts';

import { CacheClosureService } from './cache-closure-service.ts';
import type { ServerContext } from './context.ts';
import { confirmGraceBatch } from './grace-decision.ts';
import type { NarInfoObjectsService } from './narinfo-objects-service.ts';
import type { RetentionService } from './retention-service.ts';
import type { RootsService } from './roots-service.ts';
import {
	subrequestSliceBudget,
	withHeldSubrequests
} from './subrequest-slice.ts';

type NarInfoRow = typeof schema.narInfos.$inferSelect;

function generationConflict(): PublicationConflictError {
	return new PublicationConflictError(
		'The cache generation changed. Start a fresh push.',
		'generation-conflict'
	);
}

/**
Retains paths that a push planned as already served. The paths need no
pending upload, publication operation or commit, so the confirmation's
transaction writes only grace deadlines, the cache's grace-managed flag, the
run root and its targets. Before the transaction, the servability probe can
rewrite narinfo objects in R2 that no longer match their rows, and can queue
purges of the cached public responses for those objects.
*/
export class ConfirmationService {
	constructor(
		private readonly context: ServerContext,
		private readonly narInfoObjects: NarInfoObjectsService,
		private readonly retention: RetentionService,
		private readonly roots: RootsService
	) {}

	private async requireCurrentGeneration(
		scope: CacheScope,
		cacheGeneration: UploadConfirmPresentRequest['cacheGeneration']
	): Promise<void> {
		const tenant = this.context.requireTenant();
		const account = await this.context.d1
			.select({
				generation: currentCacheGeneration(tenant, scope),
				status: d1Schema.tenant.status,
				usageTenant: d1Schema.tenantUsage.tenant
			})
			.from(d1Schema.tenant)
			.leftJoin(
				d1Schema.tenantUsage,
				eq(d1Schema.tenantUsage.tenant, d1Schema.tenant.id)
			)
			.where(eq(d1Schema.tenant.id, tenant))
			.get();
		if (this.context.offboarding || account?.status !== 'active') {
			throw new TenantWritesStoppedError(
				tenant,
				this.context.offboarding ? 'offboarding' : account?.status
			);
		}
		if (account.usageTenant === null) {
			throw new TenantUsageMissingError(tenant);
		}
		if (account.generation !== cacheGeneration) {
			throw generationConflict();
		}
	}

	private requireCurrentCache(cache: ResolvedCache): void {
		if (this.context.offboarding) {
			throw new TenantWritesStoppedError(
				this.context.requireTenant(),
				'offboarding'
			);
		}
		const current = this.context.cacheRepository.resolve(cache.scope);
		if (current?.id !== cache.id || current.generation !== cache.generation) {
			throw generationConflict();
		}
		new CacheClosureService(this.context).assertWritable(cache);
		assertRetentionMigrationSettled(this.context.db);
	}

	/**
	Confirms the declared paths. `onChange` runs when the confirmation wrote
	rows, so the caller can reconcile maintenance only after a change.
	*/
	async confirmPresent(
		scope: CacheScope,
		request: UploadConfirmPresentRequest,
		onChange: () => void = noChange
	): Promise<UploadConfirmPresentResponse> {
		const maxPaths = uploadConfirmPresentMaxPathsFor(subrequestSliceBudget());
		if (request.paths.length > maxPaths) {
			throw new UploadRequestLimitExceededError(maxPaths);
		}
		requireServedStorePaths(request.paths.map((path) => path.storePath));
		await this.requireCurrentGeneration(scope, request.cacheGeneration);

		const cache = this.context.cacheRepository.resolve(scope);
		if (cache === undefined) {
			return {
				paths: request.paths.map(({ storePathHash }) => missing(storePathHash))
			};
		}
		if (cache.generation !== request.cacheGeneration) {
			throw generationConflict();
		}

		const declared = new Map(
			request.paths.map((path) => [path.storePathHash, path])
		);
		const candidates = this.narInfoObjects
			.narInfoRowsFor(cache, declared.keys().toArray())
			.filter(
				(row) => declared.get(row.storePathHash)?.storePath === row.storePath
			)
			.map((row) => row.storePathHash);
		return this.context.narInfoDemotions.watching(
			cache.id,
			candidates,
			async (demotions) => {
				const probed =
					candidates.length === 0
						? new Map<StorePathHash, NarInfoReferenceVersion>()
						: await withHeldSubrequests(trailingEligibilitySubrequests, () =>
								this.narInfoObjects.servableNarInfoVersions(cache, candidates, {
									withinSlice: true
								})
							);

				return this.context.criticalSection(() => {
					this.requireCurrentCache(cache);
					// The section runs no other statement, so the rows written while the
					// transaction runs are its own, including those written by triggers.
					this.context.dbCost.recordOutstanding();
					const writtenBefore = this.context.dbCost.rowsWritten;
					const response = this.context.db.transaction(
						(tx): UploadConfirmPresentResponse => {
							const rows = new Map(
								this.narInfoObjects
									.narInfoRowsFor(cache, probed.keys().toArray())
									.map((row) => [row.storePathHash, row])
							);
							const retained = request.paths.flatMap(
								({ storePathHash, storePath }) => {
									const row = rows.get(storePathHash);
									return isProbedVersion(row, probed.get(storePathHash)) &&
										row.storePath === storePath &&
										!demotions.wasDemoted(storePathHash)
										? [row]
										: [];
								}
							);
							const grace = confirmGraceBatch(
								this.context,
								this.retention,
								cache,
								retained.map(({ storePathHash, generation, narHash }) => ({
									storePathHash,
									generation,
									narHash
								})),
								{
									reportsGrace: true,
									graceSeconds: this.retention.resolveGraceSeconds(cache),
									retentionEpoch: new CacheClosureService(this.context).epoch(
										cache
									)
								},
								{ database: tx, rows }
							);
							const targets = retained
								.filter(({ storePathHash }) => grace.has(storePathHash))
								.map(({ storePathHash, storePath }) => ({
									storePathHash,
									storePath
								}));
							if (request.attachRoot !== undefined && targets.length > 0) {
								this.roots.bindRunRoot(
									cache,
									request.attachRoot.name,
									request.attachRoot.retention,
									tx
								);
								this.roots.attachRunRootTargets(
									cache,
									request.attachRoot.name,
									targets,
									tx
								);
							}

							return {
								paths: request.paths.map(({ storePathHash, narHash }) => {
									const row = rows.get(storePathHash);
									const fact = grace.get(storePathHash);
									if (row === undefined || fact === undefined) {
										return missing(storePathHash);
									}
									return {
										storePathHash,
										status: row.narHash === narHash ? 'confirmed' : 'diverged',
										generation: row.generation,
										narHash: row.narHash,
										grace: fact
									};
								})
							};
						}
					);
					this.context.dbCost.recordOutstanding();
					if (this.context.dbCost.rowsWritten > writtenBefore) {
						onChange();
					}

					return Promise.resolve(response);
				});
			}
		);
	}
}

function noChange(): void {
	return;
}

function isProbedVersion(
	row: NarInfoRow | undefined,
	probed: NarInfoReferenceVersion | undefined
): row is NarInfoRow {
	return (
		row !== undefined &&
		row.generation === probed?.generation &&
		row.narHash === probed.narHash
	);
}

function missing(storePathHash: StorePathHash): UploadConfirmPresentPath {
	return { storePathHash, status: 'missing' };
}
