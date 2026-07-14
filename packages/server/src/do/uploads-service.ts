import {
	type NixSha256HashString,
	type StorePathHash
} from '@cupboard/nix-store/scalars';
import {
	type ParsedUploadNegotiateRequest,
	type ParsedUploadPathMetadata,
	type ParsedUploadPathNegotiation,
	type PushCredential,
	type UploadDecision,
	type UploadNegotiateResponse,
	type UploadStatusResponse
} from '@cupboard/protocol/upload';
import { and, eq, inArray } from 'drizzle-orm';

import { pushCredentialTtlSeconds } from '../blob/push-credential.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { InvalidPushIdError } from '../errors.ts';
import { narObjectKey, stagingObjectKey } from '../http/http.ts';

import { chunk, maxInClauseValues } from './bulk.ts';
import { type ServerContext } from './context.ts';
import { type DeletionQueueService } from './deletion-queue-service.ts';
import {
	type GraceDecision,
	serialiseGraceDecision
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
		cache: string,
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
		cache: string,
		pushId: string,
		metadata: ParsedUploadPathNegotiation,
		existingBlob: ReusableBlob | undefined,
		graceDecision: GraceDecision
	): UploadDecision {
		const uploadId = crypto.randomUUID();
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
				createdAt: now.toISOString(),
				expiresAt: expiresAt.toISOString(),
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
			expiresAt: expiresAt.toISOString()
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
		body: ParsedUploadNegotiateRequest,
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

	// The status of a deferred upload, polled on the uploadId the client holds.
	// Derived from the durable per-upload verdict: a row that is gone is
	// `absent`; otherwise the terminal `servable`/`mismatch`/`over-quota`, or `pending`
	// while it still verifies (a null or in-flight verdict).
	uploadStatus(uploadId: string): UploadStatusResponse {
		const pending = this.context.db
			.select({ verdict: schema.pendingUploads.verdict })
			.from(schema.pendingUploads)
			.where(eq(schema.pendingUploads.id, uploadId))
			.get();

		return { status: uploadStatusOf(pending) };
	}

	// Plans the per-path uploads for a whole closure from pure-database facts, so a
	// closure of any size costs a bounded number of D1 queries and no R2 head on
	// the hot path: a negotiate that headed R2 per path hit the per-invocation
	// subrequest cap around a few hundred cached paths and broke large pushes.
	//
	// A `blob_state` row exists exactly while the canonical NAR object does, so it
	// stands in for the head: a committed path whose row is present is skippable;
	// one whose row is gone has lost its NAR, so its stale narinfo is reconciled
	// here and the path re-plans an upload. The skippable closure is then queued
	// for an off-hot-path reconcile (see {@link ReconcileQueueService}) that probes
	// R2 and repairs any drift the database could not see, so a missing narinfo
	// object is restored in one re-push and a genuinely lost NAR is removed for the
	// next.
	async negotiate(
		cache: string,
		body: ParsedUploadNegotiateRequest,
		origin: string,
		hints?: NegotiateHints
	): Promise<UploadNegotiateResponse> {
		if (!(await this.context.pushCredentials().verify(body.pushId))) {
			throw new InvalidPushIdError();
		}

		if (body.paths.length === 0) {
			return { uploads: [] };
		}

		// With Worker-staged hints the shared-fact reads are already done, and
		// negotiate spends no time on D1 for them; without (an older Worker, a
		// lost or expired token) it reads its own.
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
		const reusableByNarHash: ReadonlyMap<string, ReusableBlob> =
			facts?.reusableByNarHash ??
			(await this.uploadState.findReusableBlobs(
				body.paths
					.filter((path) => !skippable.has(path.storePathHash))
					.map((path) => path.narHash)
			));

		// The grace in force is captured once per negotiation and stored with each
		// pending upload, so a policy changed before the commit settles cannot
		// alter what this negotiation promised.
		const resolvedGraceSeconds = this.retention.resolveGraceSeconds(cache);
		const graceDecision: GraceDecision = {
			plan: false,
			...(resolvedGraceSeconds !== undefined && {
				graceSeconds: resolvedGraceSeconds
			})
		};

		const uploads: UploadDecision[] = [];
		const armedReuseHashes = new Set<NixSha256HashString>();

		for (const metadata of body.paths) {
			const existing = existingByStorePathHash.get(metadata.storePathHash);

			if (existing !== undefined && skippable.has(metadata.storePathHash)) {
				uploads.push({
					action: 'skip',
					storePathHash: metadata.storePathHash,
					narHash: existing.narHash
				});
				continue;
			}

			// Committed, but no `blob_state` row backs its NAR: reconcile the stale
			// narinfo so a re-upload at the requested hash heals it, then plan that
			// upload.
			if (existing !== undefined && committed.has(metadata.storePathHash)) {
				await this.deletionQueue.removeStaleNarInfo(existing, origin);
			}

			const hinted = facts?.reusableByNarHash.get(metadata.narHash);

			if (hinted !== undefined && hinted.deleteAfter !== null) {
				armedReuseHashes.add(metadata.narHash);
			}

			uploads.push(
				this.planUpload(
					cache,
					body.pushId,
					metadata,
					reusableByNarHash.get(metadata.narHash),
					graceDecision
				)
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

	// Issues a push's upload credential, scoped to its staging prefix and the
	// write-only upload actions, and never outliving the access token that asked
	// for it. Without a push id the server signs a fresh one; with one it refreshes
	// the credential for that push, having checked it signed the id.
	async issuePushCredential(
		tokenExpiresAt: Date,
		pushId?: string
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
