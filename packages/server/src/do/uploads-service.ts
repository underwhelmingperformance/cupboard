import {
	type NixSha256HashString,
	type StoredCache,
	type StorePathHash
} from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import {
	type ParsedUploadGraceFact,
	type ParsedUploadNegotiateRequest,
	type ParsedUploadPathMetadata,
	type ParsedUploadPathNegotiation,
	type ParsedUploadPreviewRequest,
	type PushCredential,
	type PushId,
	type UploadConfirmResponse,
	type UploadDecision,
	type UploadId,
	uploadIdSchema,
	type UploadNegotiateResponse,
	type UploadPreviewResponse,
	type UploadStatusResponse
} from '@cupboard/protocol/upload';
import { and, eq, inArray } from 'drizzle-orm';

import { pushCredentialTtlSeconds } from '../blob/push-credential.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { InvalidPushIdError } from '../errors.ts';
import {
	narObjectKey,
	type RequestOrigin,
	stagingObjectKey
} from '../http/http.ts';

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
import { commitMetadataFromPathAndBlob } from './upload-metadata.ts';
import { type UploadStateService } from './upload-state-service.ts';

type NarInfoRow = typeof schema.narInfos.$inferSelect;
type BlobStateRow = typeof d1Schema.blobState.$inferSelect;

// The blob facts a reuse decision plans from, satisfied by a `blob_state` row
// and by a Worker-computed hint alike.
type ReusableBlob = Pick<
	BlobStateRow,
	'fileHash' | 'fileSize' | 'compression' | 'narSize'
>;

// A pending upload, and a reuse upload's reclaim window, both live for fifteen
// minutes from when they are negotiated.
const uploadTtlMs = 15 * 60 * 1000;

// The read-only classification `negotiate` and `preview` share: what a closure
// looks like against the tenant's committed rows and shared blobs, before
// either decides what to do about it. `committed` is broader than `skippable`
// (a committed path can still lack its `blob_state` backing), so a caller that
// heals a stale narinfo can tell the two apart.
interface ClosureClassification {
	readonly facts: NegotiateFacts | undefined;
	readonly existingByStorePathHash: ReadonlyMap<StorePathHash, NarInfoRow>;
	readonly committed: ReadonlySet<StorePathHash>;
	readonly skippableRows: readonly NarInfoRow[];
	readonly skippable: ReadonlySet<StorePathHash>;
	readonly reusableByNarHash: ReadonlyMap<string, ReusableBlob>;
}

// What `classifyClosure` needs of a request body. Negotiate's body carries a
// pushId beside the paths; preview's carries no pushId at all. Both satisfy
// this narrower shape structurally, so shared classification never needs a
// pushId, real or fabricated.
interface ClosureRequest {
	readonly paths: readonly ParsedUploadPathNegotiation[];
}

type PendingVerdict = (typeof schema.pendingUploads.$inferSelect)['verdict'];

// Maps a polled upload's durable verdict to the status a `push --wait` client reads.
// An absent row is `absent`; a terminal verdict maps straight across; any in-flight
// or not-yet-committed verdict (null, `pending`, `committing`) is `pending`.
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
		private readonly retention: RetentionService
	) {}

	// The committed narinfo rows for a closure, read in cache-scoped chunks that
	// stay under D1's bound-parameter cap. The DO's own SQLite backs this table,
	// so the reads are local, but chunking keeps every batched lookup uniform.
	private existingNarInfos(
		cache: StoredCache,
		storePathHashes: readonly StorePathHash[]
	): Map<StorePathHash, NarInfoRow> {
		const rows = chunk(storePathHashes, maxInClauseValues).flatMap(
			(storePathHashBatch) =>
				this.context.db
					.select()
					.from(schema.narInfos)
					.where(
						and(
							eq(schema.narInfos.cache, cache),
							inArray(schema.narInfos.storePathHash, storePathHashBatch)
						)
					)
					.all()
		);

		return new Map(rows.map((row) => [row.storePathHash, row]));
	}

	// Records a pending upload for one path and returns its decision: a reuse of an
	// existing shared blob commits against the canonical object, while a fresh
	// upload stages its bytes under a private, per-upload key so no client write
	// can race or overwrite the shared one.
	private planUpload(
		cache: StoredCache,
		pushId: PushId,
		metadata: ParsedUploadPathNegotiation,
		existingBlob: ReusableBlob | undefined,
		graceDecision: GraceDecision
	): UploadDecision {
		const uploadId = uploadIdSchema.parse(crypto.randomUUID());
		const now = new Date();
		const expiresAt = new Date(now.getTime() + uploadTtlMs);
		const pendingMetadata:
			ParsedUploadPathNegotiation | ParsedUploadPathMetadata =
			existingBlob === undefined
				? metadata
				: {
						...commitMetadataFromPathAndBlob(metadata, existingBlob),
						// Sign the blob's verified narSize, never the client's declared
						// one: a reuse skips re-verification, so an unchecked size must
						// not reach the signed narinfo.
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
				// Bind the upload to its cache so a later commit cannot redirect it
				// to a different one.
				cache,
				narHash: metadata.narHash,
				r2Key,
				metadataJson: JSON.stringify(pendingMetadata),
				createdAt: isoTimestamp(now),
				expiresAt: isoTimestamp(expiresAt),
				graceDecisionJson: serialiseGraceDecision(graceDecision)
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

	// The NAR hashes whose `blob_state` row confirms a backing canonical object.
	// The Worker's hints read `blob_state` only for the hashes the request body
	// carries, so they answer nothing about an existing row whose committed NAR
	// differs from the one now pushed (the same store path rebuilt to different
	// bytes). Those rows read their own presence here; treating absence from the
	// hint set as a lost NAR would reconcile a healthy row away.
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

	// Classifies a closure from pure-database facts, so a closure of any size
	// costs a bounded number of D1 queries and no R2 head on the hot path: a
	// negotiate that headed R2 per path hit the per-invocation subrequest cap
	// around a few hundred cached paths and broke large pushes.
	//
	// A `blob_state` row exists exactly while the canonical NAR object does, so it
	// stands in for the head: a committed path whose row is present is skippable;
	// one whose row is gone has lost its NAR (`committed` still names it, so a
	// caller that reconciles stale narinfos can tell the two apart from
	// `skippable`). Shared by `negotiate`, which acts on the classification, and
	// `preview`, which only reports it.
	//
	// `shouldClaim` selects the reusable-blob read's claiming or read-only twin
	// (see {@link UploadStateService.findReusableBlobs} and {@link
	// UploadStateService.peekReusableBlobs}): only a caller that will actually
	// decide the closure (negotiate) may claim, since claiming un-arms a reaper
	// timer over bytes it is about to bind a fresh reference to; a caller that
	// only reports what it would do (preview) must never do that.
	private async classifyClosure(
		cache: StoredCache,
		body: ClosureRequest,
		hints: NegotiateHints | undefined,
		shouldClaim: boolean
	): Promise<ClosureClassification> {
		// With Worker-staged hints the shared-fact reads are already done, and the
		// caller spends no time on D1 for them; without (an older Worker, a lost or
		// expired token) it reads its own.
		const facts = hints === undefined ? undefined : factsFromHints(hints);

		const existingByStorePathHash = this.existingNarInfos(
			cache,
			body.paths.map((path) => path.storePathHash)
		);
		const existingRows = existingByStorePathHash.values().toArray();
		// The edge check and the `blob_state` presence check are independent
		// reads over the same row set, so they run concurrently. Presence is read
		// for every existing row's hash, a superset that includes mid-saga
		// reservations, so both checks complete in one D1 wave.
		const [committed, backedNarHashes] = await Promise.all([
			facts?.committedEdges === undefined
				? this.narInfoObjects.committedReferences(cache, existingRows)
				: this.narInfoObjects.committedReferencesFrom(
						facts.committedEdges,
						existingRows
					),
			this.backedNarHashes(facts, body, existingRows)
		]);

		// A committed path is skippable only while a `blob_state` row still backs
		// its NAR. The reaper drops that row before the object, so its presence
		// confirms the NAR without an R2 head.
		const skippableRows = existingRows.filter(
			(row) =>
				committed.has(row.storePathHash) && backedNarHashes.has(row.narHash)
		);
		const skippable = new Set(skippableRows.map((row) => row.storePathHash));

		// Only a path that will actually plan an upload needs a reusable blob, so a
		// fully cached re-push (every path a skip) reads no reuse facts at all. The
		// hinted map may cover skippable hashes too; only planned uploads read it.
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

	// The status of a deferred upload, polled on the uploadId the client holds.
	// Derived from the durable per-upload verdict: a row that is gone is
	// `absent`; otherwise the terminal `servable`/`mismatch`/`over-quota`, or `pending`
	// while it still verifies (a null or in-flight verdict).
	uploadStatus(uploadId: UploadId): UploadStatusResponse {
		const pending = this.context.db
			.select({ verdict: schema.pendingUploads.verdict })
			.from(schema.pendingUploads)
			.where(eq(schema.pendingUploads.id, uploadId))
			.get();

		return { status: uploadStatusOf(pending) };
	}

	// Plans the per-path uploads for a whole closure. A stale narinfo (committed,
	// but no `blob_state` row backs it) is reconciled here and its path re-plans
	// an upload. The skippable closure is then queued for an off-hot-path
	// reconcile (see {@link ReconcileQueueService}) that probes R2 and repairs any
	// drift the database could not see, so a missing narinfo object is restored
	// in one re-push and a genuinely lost NAR is removed for the next.
	async negotiate(
		cache: StoredCache,
		body: ParsedUploadNegotiateRequest,
		origin: RequestOrigin,
		hints: NegotiateHints | undefined,
		shouldReportGrace: boolean
	): Promise<UploadNegotiateResponse> {
		if (!(await this.context.pushCredentials().verify(body.pushId))) {
			throw new InvalidPushIdError();
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

		// The grace in force is captured once per negotiation and stored with each
		// pending upload, so a policy changed before the commit settles cannot
		// alter what this negotiation promised. Grace facts are attached only when
		// the client declared the corresponding capability, preserving the exact
		// legacy decision and commit-frame shapes otherwise.
		const resolvedGraceSeconds = this.retention.resolveGraceSeconds(cache);
		const graceDecision: GraceDecision = {
			reportsGrace: shouldReportGrace,
			...(resolvedGraceSeconds !== undefined && {
				graceSeconds: resolvedGraceSeconds
			})
		};
		const plannedGraceFact: ParsedUploadGraceFact =
			resolvedGraceSeconds === undefined
				? {}
				: { graceSeconds: resolvedGraceSeconds };

		// An already-present decision is a successful publication too, so its
		// grace is confirmed whether or not the client accepted grace facts; only
		// the reported fact is capability-gated. One batched application covers every
		// skippable path, so a large already-present closure costs a bounded
		// number of statements rather than one transaction per path. The
		// skippable snapshot was read before awaited shared-facts checks, so a
		// row can have moved by now; a moved row is absent from the map, grants
		// nothing, and reports the empty fact.
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

		const uploads: UploadDecision[] = [];
		const armedReuseHashes = new Set<NixSha256HashString>();

		for (const metadata of body.paths) {
			const existing = existingByStorePathHash.get(metadata.storePathHash);
			const skipFact =
				existing !== undefined && skippable.has(metadata.storePathHash)
					? skipFacts.get(metadata.storePathHash)
					: undefined;

			// A skip answers only from a row whose identity the batch just
			// re-checked. A skippable row absent from the map moved during the
			// shared-fact reads, so its snapshot no longer describes what holds
			// the path: fall through and plan this push's own bytes, leaving the
			// concurrent publication untouched — the commit saga arbitrates the
			// race exactly as it does for any contested path.
			if (existing !== undefined && skipFact !== undefined) {
				uploads.push({
					action: 'skip',
					storePathHash: metadata.storePathHash,
					narHash: existing.narHash,
					...(shouldReportGrace && { grace: skipFact })
				});
				continue;
			}

			// Committed, but no `blob_state` row backs its NAR: reconcile the stale
			// narinfo so a re-upload at the requested hash heals it, then plan that
			// upload. A moved row is not stale — whatever holds the path now is a
			// live concurrent publication — so it is planned without reconciling.
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
				graceDecision
			);

			uploads.push(
				shouldReportGrace ? { ...decision, grace: plannedGraceFact } : decision
			);
		}

		// Reusing is a fresh reference, so cancel any armed reaper grace timer
		// before the response commits the client to the plan; the fallback read
		// (`findReusableBlobs`) clears its own. A clear deferred past the
		// response can be lost, leaving the reaper racing the client across its
		// whole negotiate-to-commit window.
		await this.uploadState.clearReaperTimers([...armedReuseHashes]);

		// Queue the skippable closure for the off-hot-path reconcile and arm the
		// alarm. The push returns at once; the alarm probes R2 for each path and
		// restores a missing narinfo object or removes one whose NAR is truly gone.
		await this.reconcileQueue.enqueue(
			origin,
			skippableRows.map((row) => ({ cache, storePathHash: row.storePathHash }))
		);

		return { uploads };
	}

	// The read-only twin of `negotiate`: classifies a closure exactly as
	// negotiate would (skip / reuse-commit / fresh upload) without planning
	// anything. It inserts no pending upload, heals no stale narinfo, queues no
	// reconcile, clears no reaper timer, and extends no grace deadline; a skip
	// reports the deadline already on the row, unstretched, and a commit or
	// upload reports the grace a publication would currently capture. Facts are
	// always attached, since preview has no legacy shape to preserve.
	async preview(
		cache: StoredCache,
		body: ParsedUploadPreviewRequest,
		hints: NegotiateHints | undefined,
		shouldReportGrace: boolean
	): Promise<UploadPreviewResponse> {
		if (body.paths.length === 0) {
			return { uploads: [] };
		}

		const { existingByStorePathHash, skippable, reusableByNarHash } =
			await this.classifyClosure(cache, body, hints, false);
		const resolvedGraceSeconds = this.retention.resolveGraceSeconds(cache);
		const plannedGraceFact: ParsedUploadGraceFact =
			resolvedGraceSeconds === undefined
				? {}
				: { graceSeconds: resolvedGraceSeconds };
		// One chunked read covers every skip answer: a large previewed closure
		// must not cost a stored-deadline query per path.
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
			uploads: body.paths.map((metadata) => {
				const existing = existingByStorePathHash.get(metadata.storePathHash);

				if (existing !== undefined && skippable.has(metadata.storePathHash)) {
					const retainUntil = storedDeadlines.get(metadata.storePathHash);

					// A skip with no stored deadline still reports the resolved
					// policy: an empty fact strictly means no policy matched.
					const decision = {
						action: 'skip',
						storePathHash: metadata.storePathHash,
						narHash: existing.narHash
					} as const;

					return shouldReportGrace
						? {
								...decision,
								grace:
									retainUntil === undefined ? plannedGraceFact : { retainUntil }
							}
						: decision;
				}

				const decision = {
					action: reusableByNarHash.has(metadata.narHash) ? 'commit' : 'upload',
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash
				} as const;

				return shouldReportGrace
					? { ...decision, grace: plannedGraceFact }
					: decision;
			})
		};
	}

	// Confirms an unretained publication by store path, without uploading bytes:
	// the same conditions and monotonic grace extension a negotiate applies to
	// an already-present decision, reused wholesale through {@link
	// confirmGraceBatch}. A path confirms only while it is genuinely
	// substitutable: it needs a committed reference edge, a live `blob_state`
	// backing exactly as negotiate's skippable check does, and a row identity
	// that still holds when the grace is applied, since a caller confirms a
	// path precisely to rely on substituting it afterwards. Anything less
	// confirms false and extends nothing.
	async confirmPaths(
		cache: StoredCache,
		storePathHashes: readonly StorePathHash[]
	): Promise<UploadConfirmResponse> {
		if (storePathHashes.length === 0) {
			return { paths: [] };
		}

		// The work runs once per distinct hash; every occurrence in the request
		// still gets its own response entry.
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
		// The checks above awaited shared facts, so a row can have moved since
		// its snapshot; the batch re-checks each row's identity and applies the
		// grace only to the rows that still match. A moved row is absent from
		// the map and confirms false.
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

	// Issues a push's upload credential, scoped to its staging prefix and the
	// write-only upload actions, and never outliving the access token that asked
	// for it. Without a push id the server signs a fresh one; with one it refreshes
	// the credential for that push, having checked it signed the id.
	async issuePushCredential(
		tokenExpiresAt: Date,
		pushId?: PushId
	): Promise<PushCredential> {
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
