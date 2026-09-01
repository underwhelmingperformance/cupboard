import {
	type CacheScope,
	type NixSha256HashString,
	type RootName,
	type StorePathHash
} from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import {
	type PushCredentialInput,
	type PushId,
	type UploadConfirmResponse,
	type UploadDecision,
	type UploadGraceFact,
	type UploadId,
	uploadIdSchema,
	type UploadNegotiateRequest,
	type UploadNegotiateResponse,
	type UploadPathMetadata,
	type UploadPathNegotiation,
	type UploadPreviewDecision,
	type UploadPreviewRequest,
	type UploadPreviewResponse,
	type UploadStatusResponse
} from '@cupboard/protocol/upload';
import { and, eq, inArray } from 'drizzle-orm';

import { pushCredentialTtlSeconds } from '../blob/push-credential.ts';
import type { ResolvedCache } from '../db/cache.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { InvalidPushIdError } from '../errors.ts';
import {
	narObjectKey,
	type RequestOrigin,
	stagingObjectKey
} from '../http/http.ts';
import { requireServedStorePaths } from '../policy/served-store.ts';

import { chunk, maxInClauseValues } from './bulk.ts';
import { type ServerContext } from './context.ts';
import { type DeletionQueueService } from './deletion-queue-service.ts';
import {
	confirmGraceBatch,
	type GraceDecision,
	serialiseGraceDecision,
	storedGraceDeadlines
} from './grace-decision.ts';
import { type NarInfoObjectsService } from './narinfo-objects-service.ts';
import {
	factsFromHints,
	type NegotiateFacts,
	type NegotiateHints
} from './negotiate-hints.ts';
import { type ReconcileQueueService } from './reconcile-queue-service.ts';
import { type RetentionService } from './retention-service.ts';
import { type RootsService } from './roots-service.ts';
import { commitMetadataFromPathAndBlob } from './upload-metadata.ts';
import { type UploadStateService } from './upload-state-service.ts';

type NarInfoRow = typeof schema.narInfos.$inferSelect;
type BlobStateRow = typeof d1Schema.blobState.$inferSelect;

type ReusableBlob = Pick<
	BlobStateRow,
	'fileHash' | 'fileSize' | 'compression' | 'narSize'
>;

const uploadTtlMs = 15 * 60 * 1000;

interface ClosureClassification {
	readonly facts: NegotiateFacts | undefined;
	readonly existingByStorePathHash: ReadonlyMap<StorePathHash, NarInfoRow>;
	readonly committed: ReadonlySet<StorePathHash>;
	readonly skippableRows: readonly NarInfoRow[];
	readonly skippable: ReadonlySet<StorePathHash>;
	readonly reusableByNarHash: ReadonlyMap<string, ReusableBlob>;
}

interface ClosureRequest {
	readonly paths: readonly UploadPathNegotiation[];
}

type PendingVerdict = (typeof schema.pendingUploads.$inferSelect)['verdict'];

// Successful materialisation removes the pending row. An `absent` status is
// therefore not proof of failure; clients check narinfo to confirm servability.
export function uploadStatusOf(
	pending: undefined | { readonly verdict: PendingVerdict }
): UploadStatusResponse['status'] {
	if (pending === undefined) {
		return 'absent';
	}

	switch (pending.verdict) {
		case 'servable': {
			return 'servable';
		}
		case 'mismatch': {
			return 'mismatch';
		}
		case 'over-quota': {
			return 'over-quota';
		}
		default: {
			return 'pending';
		}
	}
}

export class UploadsService {
	constructor(
		private readonly context: ServerContext,
		private readonly uploadState: UploadStateService,
		private readonly narInfoObjects: NarInfoObjectsService,
		private readonly deletionQueue: DeletionQueueService,
		private readonly reconcileQueue: ReconcileQueueService,
		private readonly retention: RetentionService,
		private readonly roots: RootsService
	) {}

	// D1 caps the number of bound parameters in one statement. Chunk closure
	// lookups so a large request stays within that limit.
	private existingNarInfos(
		cache: ResolvedCache,
		storePathHashes: readonly StorePathHash[]
	): Map<StorePathHash, NarInfoRow> {
		const rows = chunk(storePathHashes, maxInClauseValues).flatMap(
			(storePathHashBatch) =>
				this.context.db
					.select()
					.from(schema.narInfos)
					.where(
						and(
							eq(schema.narInfos.cacheId, cache.id),
							inArray(schema.narInfos.storePathHash, storePathHashBatch)
						)
					)
					.all()
		);

		return new Map(rows.map((row) => [row.storePathHash, row]));
	}

	// A fresh upload uses a private staging key. Reuse records the canonical key but
	// gives the client no write access to the shared object.
	private planUpload(
		cache: ResolvedCache,
		pushId: PushId,
		metadata: UploadPathNegotiation,
		existingBlob: ReusableBlob | undefined,
		graceDecision: GraceDecision,
		attachRootName: RootName | undefined
	): UploadDecision {
		const uploadId = uploadIdSchema.parse(crypto.randomUUID());
		const now = new Date();
		const expiresAt = new Date(now.getTime() + uploadTtlMs);
		const pendingMetadata: UploadPathNegotiation | UploadPathMetadata =
			existingBlob === undefined
				? metadata
				: {
						...commitMetadataFromPathAndBlob(metadata, existingBlob),
						// The server already verified the reusable blob's `narSize`. Use
						// that value because reuse skips content verification and the
						// client's declared size remains untrusted.
						narSize: existingBlob.narSize
					};
		const r2Key =
			existingBlob === undefined
				? stagingObjectKey(pushId, uploadId)
				: narObjectKey(metadata.narHash);

		this.context.db
			.insert(schema.pendingUploads)
			.values({
				id: uploadId,
				// Store the cache in the pending row. Commit accepts only the upload
				// identifier, so this binding prevents cross-cache redirection.
				cacheId: cache.id,
				narHash: metadata.narHash,
				r2Key,
				metadataJson: JSON.stringify(pendingMetadata),
				createdAt: isoTimestamp(now),
				expiresAt: isoTimestamp(expiresAt),
				graceDecisionJson: serialiseGraceDecision(graceDecision),
				attachRootName
			})
			.run();

		if (existingBlob !== undefined) {
			return {
				action: 'commit',
				storePathHash: metadata.storePathHash,
				narHash: metadata.narHash,
				uploadId
			};
		}

		return {
			action: 'upload',
			storePathHash: metadata.storePathHash,
			narHash: metadata.narHash,
			uploadId,
			r2Key,
			expiresAt: isoTimestamp(expiresAt)
		};
	}

	// Worker hints cover only NAR hashes in the current request. An existing
	// narinfo can refer to a different hash when the same store path has been
	// rebuilt. Query those uncovered hashes here so absence from the hint set does
	// not cause negotiate to remove healthy narinfo.
	private async backedNarHashes(
		facts: NegotiateFacts | undefined,
		body: ClosureRequest,
		existingRows: readonly NarInfoRow[]
	): Promise<ReadonlySet<NixSha256HashString>> {
		const rowHashes = existingRows.map((row) => row.narHash);

		if (facts === undefined) {
			return this.uploadState.presentNarHashes(rowHashes);
		}

		const requested = new Set(body.paths.map((path) => path.narHash));
		const uncovered = rowHashes.filter((hash) => !requested.has(hash));

		if (uncovered.length === 0) {
			return facts.backedNarHashes;
		}

		const present = await this.uploadState.presentNarHashes(uncovered);

		return new Set([...facts.backedNarHashes, ...present]);
	}

	// Per-path R2 heads exceed the Worker's subrequest limit for large closures, so
	// availability comes from the D1 reference and blob indexes. Preview must use
	// the non-claiming lookup because classification must not clear reaper timers.
	private async classifyClosure(
		cache: ResolvedCache,
		body: ClosureRequest,
		hints: NegotiateHints | undefined,
		shouldClaim: boolean
	): Promise<ClosureClassification> {
		const facts = hints === undefined ? undefined : factsFromHints(hints);

		const existingByStorePathHash = this.existingNarInfos(
			cache,
			body.paths.map((path) => path.storePathHash)
		);
		const existingRows = existingByStorePathHash.values().toArray();
		// The presence query must include every existing row, including mid-saga
		// reservations, because request hints do not cover all of their hashes.
		const [committed, backedNarHashes] = await Promise.all([
			facts?.committedEdges === undefined
				? this.narInfoObjects.committedReferences(cache, existingRows)
				: this.narInfoObjects.committedReferencesFrom(
						facts.committedEdges,
						existingRows
					),
			this.backedNarHashes(facts, body, existingRows)
		]);

		const skippableRows = existingRows.filter(
			(row) =>
				committed.has(row.storePathHash) && backedNarHashes.has(row.narHash)
		);
		const skippable = new Set(skippableRows.map((row) => row.storePathHash));

		const candidateNarHashes = body.paths
			.filter((path) => !skippable.has(path.storePathHash))
			.map((path) => path.narHash);
		const reusableByNarHash: ReadonlyMap<string, ReusableBlob> =
			facts?.reusableByNarHash ??
			(await (shouldClaim
				? this.uploadState.findReusableBlobs(candidateNarHashes)
				: this.uploadState.peekReusableBlobs(candidateNarHashes)));

		return {
			facts,
			existingByStorePathHash,
			committed,
			skippableRows,
			skippable,
			reusableByNarHash
		};
	}

	uploadStatus(uploadId: UploadId): UploadStatusResponse {
		const pending = this.context.db
			.select({ verdict: schema.pendingUploads.verdict })
			.from(schema.pendingUploads)
			.where(eq(schema.pendingUploads.id, uploadId))
			.get();

		return { status: uploadStatusOf(pending) };
	}

	async negotiate(
		cacheScope: CacheScope,
		body: UploadNegotiateRequest,
		origin: RequestOrigin,
		hints: NegotiateHints | undefined,
		shouldReportGrace: boolean
	): Promise<UploadNegotiateResponse> {
		if (!(await this.context.pushCredentials().verify(body.pushId))) {
			throw new InvalidPushIdError();
		}

		requireServedStorePaths(body.paths.map((path) => path.storePath));

		if (body.paths.length === 0 && body.attachRoot === undefined) {
			return { uploads: [] };
		}

		const cache = this.context.cacheRepository.require(cacheScope);

		// Reject paths from another store directory before creating or extending the
		// run root. Each pending upload then records the root its commit must attach
		// to.
		if (body.attachRoot !== undefined) {
			this.roots.bindRunRoot(
				cache,
				body.attachRoot.name,
				body.attachRoot.retention
			);
		}

		if (body.paths.length === 0) {
			return { uploads: [] };
		}

		const {
			facts,
			existingByStorePathHash,
			committed,
			skippableRows,
			skippable,
			reusableByNarHash
		} = await this.classifyClosure(cache, body, hints, true);

		// Capture grace once and store it with every pending upload. A later cache
		// change cannot alter the decision before commit finishes. Attach grace facts
		// only when the client requested them, so a client that did not ask still
		// receives the legacy response shape.
		const resolvedGraceSeconds = this.retention.resolveGraceSeconds(cache);
		const graceDecision: GraceDecision = {
			reportsGrace: shouldReportGrace,
			...(resolvedGraceSeconds !== undefined && {
				graceSeconds: resolvedGraceSeconds
			})
		};
		const plannedGraceFact: UploadGraceFact =
			resolvedGraceSeconds === undefined
				? {}
				: { graceSeconds: resolvedGraceSeconds };

		// A skip completes publication during negotiate, so confirm its grace even
		// when the client did not request grace facts. Capability negotiation controls
		// only the response shape. The batch re-checks each row identity because the
		// classification awaited shared facts; a replaced row receives no grace and
		// will not be returned as a skip below.
		const skipFacts = confirmGraceBatch(
			this.context,
			this.retention,
			cache,
			skippableRows.map((row) => ({
				storePathHash: row.storePathHash,
				generation: row.generation,
				narHash: row.narHash
			})),
			resolvedGraceSeconds
		);

		// A skip has no later commit step. Attach each confirmed skip to the run root
		// now, using the same identity-checked set that the response loop uses.
		if (body.attachRoot !== undefined) {
			this.roots.attachRunRootTargets(
				cache,
				body.attachRoot.name,
				body.paths.filter((path) => skipFacts.has(path.storePathHash))
			);
		}

		const uploads: UploadDecision[] = [];
		const armedReuseHashes = new Set<NixSha256HashString>();

		for (const metadata of body.paths) {
			const existing = existingByStorePathHash.get(metadata.storePathHash);
			const skipFact =
				existing !== undefined && skippable.has(metadata.storePathHash)
					? skipFacts.get(metadata.storePathHash)
					: undefined;

			// `skipFacts` contains only rows that survived the identity check. If the
			// row changed during classification, plan this request's bytes and let the
			// commit saga resolve the concurrent publication.
			if (existing !== undefined && skipFact !== undefined) {
				uploads.push({
					action: 'skip',
					storePathHash: metadata.storePathHash,
					narHash: existing.narHash,
					...(shouldReportGrace && { grace: skipFact })
				});
				continue;
			}

			// A committed row without a present NAR is stale. Remove it before
			// planning the replacement. Do not remove a replacement row written by a
			// concurrent publication.
			if (
				existing !== undefined &&
				!skippable.has(metadata.storePathHash) &&
				committed.has(metadata.storePathHash)
			) {
				await this.deletionQueue.removeStaleNarInfo(existing, origin);
			}

			const hinted = facts?.reusableByNarHash.get(metadata.narHash);

			if (hinted !== undefined && hinted.deleteAfter !== null) {
				armedReuseHashes.add(metadata.narHash);
			}

			const decision = this.planUpload(
				cache,
				body.pushId,
				metadata,
				reusableByNarHash.get(metadata.narHash),
				graceDecision,
				body.attachRoot?.name
			);

			uploads.push(
				shouldReportGrace ? { ...decision, grace: plannedGraceFact } : decision
			);
		}

		// Worker hints bypass `findReusableBlobs`, which normally clears armed
		// timers. Clear the hinted timers before returning the decisions. Otherwise
		// the reaper could remove a canonical object after the client receives a
		// commit decision but before that commit binds its new reference.
		await this.uploadState.clearReaperTimers([...armedReuseHashes]);

		await this.reconcileQueue.enqueue(
			origin,
			skippableRows.map((row) => ({
				cacheId: cache.id,
				storePathHash: row.storePathHash
			}))
		);

		return { uploads };
	}

	// Preview does not create pending rows, repair stale publications, enqueue
	// reconciliation, claim reusable blobs, or extend grace. A skip reports its
	// stored deadline; commit and upload actions report the grace that a new
	// publication would capture.
	async preview(
		cacheScope: CacheScope,
		body: UploadPreviewRequest,
		hints: NegotiateHints | undefined,
		shouldReportGrace: boolean
	): Promise<UploadPreviewResponse> {
		if (body.paths.length === 0) {
			return { uploads: [] };
		}

		requireServedStorePaths(body.paths.map((path) => path.storePath));
		const cache = this.context.cacheRepository.resolve(cacheScope);
		const resolvedGraceSeconds =
			cache === undefined
				? undefined
				: this.retention.resolveGraceSeconds(cache);

		if (cache === undefined) {
			const facts = hints === undefined ? undefined : factsFromHints(hints);
			const reusableByNarHash =
				facts?.reusableByNarHash ??
				(await this.uploadState.peekReusableBlobs(
					body.paths.map((path) => path.narHash)
				));
			const plannedGraceFact: UploadGraceFact =
				resolvedGraceSeconds === undefined
					? {}
					: { graceSeconds: resolvedGraceSeconds };

			return {
				uploads: body.paths.map((metadata): UploadPreviewDecision => {
					const decision: UploadPreviewDecision = {
						action: reusableByNarHash.has(metadata.narHash)
							? 'commit'
							: 'upload',
						storePathHash: metadata.storePathHash,
						narHash: metadata.narHash
					};

					return shouldReportGrace
						? { ...decision, grace: plannedGraceFact }
						: decision;
				})
			};
		}

		const { existingByStorePathHash, skippable, reusableByNarHash } =
			await this.classifyClosure(cache, body, hints, false);
		const plannedGraceFact: UploadGraceFact =
			resolvedGraceSeconds === undefined
				? {}
				: { graceSeconds: resolvedGraceSeconds };
		const storedDeadlines = storedGraceDeadlines(
			this.context.db,
			cache,
			body.paths
				.map((metadata) => metadata.storePathHash)
				.filter(
					(storePathHash) =>
						existingByStorePathHash.has(storePathHash) &&
						skippable.has(storePathHash)
				)
		);

		return {
			uploads: body.paths.map((metadata): UploadPreviewDecision => {
				const existing = existingByStorePathHash.get(metadata.storePathHash);

				if (existing !== undefined && skippable.has(metadata.storePathHash)) {
					const retainUntil = storedDeadlines.get(metadata.storePathHash);

					// A skip without a stored deadline reports the current cache grace. An
					// empty grace fact means that grace was not configured.
					const decision: UploadPreviewDecision = {
						action: 'skip',
						storePathHash: metadata.storePathHash,
						narHash: existing.narHash
					};

					return shouldReportGrace
						? {
								...decision,
								grace:
									retainUntil === undefined ? plannedGraceFact : { retainUntil }
							}
						: decision;
				}

				const decision: UploadPreviewDecision = {
					action: reusableByNarHash.has(metadata.narHash) ? 'commit' : 'upload',
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash
				};

				return shouldReportGrace
					? { ...decision, grace: plannedGraceFact }
					: decision;
			})
		};
	}

	// Confirmation requires a committed reference, a present canonical NAR, and the
	// same narinfo identity when grace is applied. If any condition fails, the path
	// is reported as unconfirmed and receives no grace extension.
	async confirmPaths(
		cacheScope: CacheScope,
		storePathHashes: readonly StorePathHash[]
	): Promise<UploadConfirmResponse> {
		if (storePathHashes.length === 0) {
			return { paths: [] };
		}

		const cache = this.context.cacheRepository.resolve(cacheScope);

		if (cache === undefined) {
			return {
				paths: storePathHashes.map((storePathHash) => ({
					storePathHash,
					confirmed: false
				}))
			};
		}

		// Deduplicate the storage queries without removing duplicate response entries.
		const uniqueHashes = [...new Set(storePathHashes)];
		const existingByStorePathHash = this.existingNarInfos(cache, uniqueHashes);
		const existingRows = existingByStorePathHash.values().toArray();
		const [servable, backed] = await Promise.all([
			this.narInfoObjects.servableStorePathHashes(cache, uniqueHashes),
			this.uploadState.presentNarHashes(existingRows.map((row) => row.narHash))
		]);
		const resolvedGraceSeconds = this.retention.resolveGraceSeconds(cache);

		const confirmable = uniqueHashes.flatMap((storePathHash) => {
			const existing = existingByStorePathHash.get(storePathHash);

			if (
				existing === undefined ||
				!servable.has(storePathHash) ||
				!backed.has(existing.narHash)
			) {
				return [];
			}

			return [
				{
					storePathHash: existing.storePathHash,
					generation: existing.generation,
					narHash: existing.narHash
				}
			];
		});
		// The shared-fact reads allow a concurrent publication to replace a row.
		// Re-check identity while applying grace and confirm only unchanged rows.
		const facts = confirmGraceBatch(
			this.context,
			this.retention,
			cache,
			confirmable,
			resolvedGraceSeconds
		);

		return {
			paths: storePathHashes.map((storePathHash) => {
				const fact = facts.get(storePathHash);

				if (fact === undefined) {
					return { storePathHash, confirmed: false };
				}

				return { storePathHash, confirmed: true, grace: fact };
			})
		};
	}

	// The credential is write-only and restricted to one push's staging prefix. Its
	// expiry cannot exceed the access-token expiry.
	async issuePushCredential(
		tokenExpiresAt: Date,
		pushId?: PushId
	): Promise<PushCredentialInput> {
		const now = new Date();
		const ttlSeconds = pushCredentialTtlSeconds(tokenExpiresAt, now);
		const issuer = this.context.pushCredentials();

		if (pushId === undefined) {
			return issuer.issue(ttlSeconds, now);
		}

		if (!(await issuer.verify(pushId))) {
			throw new InvalidPushIdError();
		}

		return issuer.issueFor(pushId, ttlSeconds, now);
	}
}
