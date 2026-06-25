import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	type NixSha256HashString,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { type ParsedUploadPathNegotiation } from '@cupboard/protocol/upload';
import { and, eq, inArray, isNull, ne, notInArray, or, sql } from 'drizzle-orm';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { UploadedObjectNotFoundError } from '../errors.ts';
import { narObjectKey } from '../http/http.ts';

import {
	chunk,
	mapWithConcurrency,
	maxInClauseValues,
	maxOutgoingConnections
} from './bulk.ts';
import { type ServerContext } from './context.ts';
import { type CanonicalBlob, canonicalBlobOf } from './upload-metadata.ts';

type BlobStateRow = typeof d1Schema.blobState.$inferSelect;

export class UploadStateService {
	constructor(private readonly context: ServerContext) {}

	private async ensureCanonicalObject(
		stagingKey: string,
		narHash: NixSha256HashString,
		// The blob facts verify derived for a fresh upload. A reuse promotes against
		// an already-canonical object and derives them from it, so it passes none.
		blob: CanonicalBlob | undefined
	): Promise<CanonicalBlob> {
		const canonicalKey = narObjectKey(narHash);
		const existing = await this.context.env.BLOBS.head(canonicalKey);

		if (existing !== null) {
			return canonicalBlobOf(canonicalKey, existing);
		}

		if (blob === undefined) {
			throw new UploadedObjectNotFoundError(canonicalKey);
		}

		const staged = await this.context.env.BLOBS.get(stagingKey);

		if (staged === null) {
			throw new UploadedObjectNotFoundError(stagingKey);
		}

		const written = await this.context.env.BLOBS.put(
			canonicalKey,
			staged.body,
			{
				// The file hash was computed over these exact staging bytes during verify,
				// so R2 re-checking the copy against it confirms the promote moved them
				// intact, not that a client-asserted value matched.
				sha256: NixSha256Hash.parse(blob.fileHash).digestBytes(),
				onlyIf: { etagDoesNotMatch: '*' }
			}
		);

		if (written !== null) {
			return blob;
		}

		// A concurrent promotion won between the head and the conditional put: adopt
		// the stored encoding so this narinfo matches the object that is served.
		const winner = await this.context.env.BLOBS.head(canonicalKey);

		if (winner === null) {
			throw new UploadedObjectNotFoundError(canonicalKey);
		}

		return canonicalBlobOf(canonicalKey, winner);
	}

	// Whether this upload's staging object can be deleted now. The canonical key of
	// a reuse upload is shared and must survive. An S3 ingest stages a NAR by its
	// file hash, so two concurrent uploads of identical content share one staging
	// object; the first to settle must not delete bytes a sibling's verify still
	// needs, so the object is kept while another still-live upload references it.
	private stagingObjectIsDeletable(
		uploadId: string,
		r2Key: string,
		narHash: NixSha256HashString
	): boolean {
		if (r2Key === narObjectKey(narHash)) {
			return false;
		}

		const referencedByLiveSibling = and(
			eq(schema.pendingUploads.r2Key, r2Key),
			ne(schema.pendingUploads.id, uploadId),
			or(
				isNull(schema.pendingUploads.verdict),
				notInArray(schema.pendingUploads.verdict, [
					'servable',
					'mismatch',
					'over-quota'
				])
			)
		);

		const sibling = this.context.db
			.select({ id: schema.pendingUploads.id })
			.from(schema.pendingUploads)
			.where(referencedByLiveSibling)
			.get();

		return sibling === undefined;
	}

	private async ownedNarHashes(
		tenant: TenantId,
		narHashes: readonly NixSha256HashString[]
	): Promise<NixSha256HashString[]> {
		const batches = await mapWithConcurrency(
			chunk(narHashes, maxInClauseValues),
			maxOutgoingConnections,
			(narHashBatch) =>
				this.context.d1
					.select({ narHash: d1Schema.tenantBlob.narHash })
					.from(d1Schema.tenantBlob)
					.where(
						and(
							eq(d1Schema.tenantBlob.tenant, tenant),
							inArray(d1Schema.tenantBlob.narHash, narHashBatch)
						)
					)
					.all()
		);

		return batches.flat().map((row) => row.narHash);
	}

	private async blobStatesByNarHash(
		narHashes: readonly NixSha256HashString[]
	): Promise<Map<NixSha256HashString, BlobStateRow>> {
		const batches = await mapWithConcurrency(
			chunk(narHashes, maxInClauseValues),
			maxOutgoingConnections,
			(narHashBatch) =>
				this.context.d1
					.select()
					.from(d1Schema.blobState)
					.where(inArray(d1Schema.blobState.narHash, narHashBatch))
					.all()
		);

		return new Map(batches.flat().map((row) => [row.narHash, row]));
	}

	private async clearReaperTimers(
		narHashes: readonly NixSha256HashString[]
	): Promise<void> {
		if (narHashes.length === 0) {
			return;
		}

		await mapWithConcurrency(
			chunk(narHashes, maxInClauseValues),
			maxOutgoingConnections,
			(narHashBatch) =>
				this.context.d1
					.update(d1Schema.blobState)
					.set({ deleteAfter: sql`null` })
					.where(inArray(d1Schema.blobState.narHash, narHashBatch))
					.run()
		);
	}

	// The NAR hashes among `narHashes` that still hold a `blob_state` row. A row
	// exists exactly while the canonical `nar/<narHash>.nar.zst` object does (the
	// reaper drops the row before the object), so a present hash confirms the NAR
	// without an R2 head: the skip decision turns on this pure-D1 read.
	async presentNarHashes(
		narHashes: readonly NixSha256HashString[]
	): Promise<Set<NixSha256HashString>> {
		const unique = [...new Set(narHashes)];

		if (unique.length === 0) {
			return new Set();
		}

		const states = await this.blobStatesByNarHash(unique);

		return new Set(states.keys());
	}

	clearPendingUpload(uploadId: string): void {
		this.context.db
			.delete(schema.pendingUploads)
			.where(eq(schema.pendingUploads.id, uploadId))
			.run();
	}

	// Clears an abandoned pending upload's record, deleting its private staging
	// object first so the durable handle to that object is never dropped before the
	// object itself. A reuse upload's r2Key is the shared canonical key, which must
	// survive; only a per-upload staging key is removed. It awaits R2 I/O, so it is
	// called outside any critical section.
	async clearPendingUploadAndStaging(
		uploadId: string,
		r2Key: string,
		narHash: NixSha256HashString
	): Promise<void> {
		if (this.stagingObjectIsDeletable(uploadId, r2Key, narHash)) {
			await this.context.env.BLOBS.delete(r2Key);
		}

		this.clearPendingUpload(uploadId);
	}

	markUploadPending(uploadId: string): void {
		this.context.db
			.update(schema.pendingUploads)
			.set({ verdict: 'pending' })
			.where(eq(schema.pendingUploads.id, uploadId))
			.run();
	}

	// Records the commit session waiting on an upload, so the verify pass can
	// route its verdict to that connection. A no-op for a row that is gone (a bad
	// id, or one already settled and cleared).
	attachSession(uploadId: string, sessionId: string): void {
		this.context.db
			.update(schema.pendingUploads)
			.set({ sessionId })
			.where(eq(schema.pendingUploads.id, uploadId))
			.run();
	}

	// Marks an inline commit in progress before it reserves the narinfo row, so a
	// crash mid-commit leaves a durable saga marker the verify pass re-drives rather
	// than a null-verdict upload indistinguishable from one still awaiting its bytes.
	markUploadCommitting(uploadId: string): void {
		this.context.db
			.update(schema.pendingUploads)
			.set({ verdict: 'committing' })
			.where(eq(schema.pendingUploads.id, uploadId))
			.run();
	}

	// Records a deferred upload's terminal verdict and deletes its staging bytes,
	// keeping the upload row so a later status reader (`push --wait` or a status
	// endpoint) can observe the outcome. `servable` once the background pass commits it,
	// `mismatch` for a failed NAR-hash check, `over-quota` for a quota rejection;
	// distinguished so a quota rejection is not misreported as bad content. Synchronous
	// inline outcomes return at commit and need no retained verdict.
	async markUploadTerminal(
		uploadId: string,
		r2Key: string,
		narHash: NixSha256HashString,
		verdict: 'servable' | 'mismatch' | 'over-quota'
	): Promise<void> {
		if (this.stagingObjectIsDeletable(uploadId, r2Key, narHash)) {
			await this.context.env.BLOBS.delete(r2Key);
		}

		// Refresh the observation window so the terminal verdict reliably outlives
		// the verify pass that recorded it (the pass may run at or past the original
		// upload TTL); GC reaps it once this window passes.
		const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

		this.context.db
			.update(schema.pendingUploads)
			.set({
				verdict,
				expiresAt: expiresAt.toISOString()
			})
			.where(eq(schema.pendingUploads.id, uploadId))
			.run();
	}

	// The reusable shared blobs among `narHashes`, keyed by hash. Pure D1: a
	// `blob_state` row exists exactly while the canonical object does, so its
	// presence confirms reuse without an R2 head, and a closure of any size costs a
	// bounded number of D1 queries rather than a round trip per path. Drift (a row
	// outliving a reaped object) is healed off the hot path by the negotiated
	// reconcile, which probes R2 and removes any narinfo whose NAR is gone.
	//
	// Existence-oracle-safe: reuse only hashes this tenant already holds its own
	// presence edge for, never the global `blob_state`. A tenant that has not
	// itself uploaded a hash is always told to upload, even when another tenant's
	// identical verified bytes exist; the promote then dedups at rest. So negotiate
	// never reveals whether another tenant has a blob.
	async findReusableBlobs(
		narHashes: readonly NixSha256HashString[]
	): Promise<Map<NixSha256HashString, BlobStateRow>> {
		const reusable = new Map<NixSha256HashString, BlobStateRow>();
		const unique = [...new Set(narHashes)];

		if (unique.length === 0) {
			return reusable;
		}

		const tenant = this.context.requireTenant();
		const owned = await this.ownedNarHashes(tenant, unique);

		if (owned.length === 0) {
			return reusable;
		}

		const blobStates = await this.blobStatesByNarHash(owned);
		const candidates = owned.filter((narHash) => blobStates.has(narHash));

		// Reusing is a fresh reference, so cancel any reaper grace timer the rows
		// armed before a commit binds a new edge to the hash.
		await this.clearReaperTimers(
			candidates.filter(
				(narHash) => blobStates.get(narHash)?.deleteAfter !== null
			)
		);

		for (const narHash of candidates) {
			const state = blobStates.get(narHash);

			if (state !== undefined) {
				reusable.set(narHash, state);
			}
		}

		return reusable;
	}

	// Promotes verified staging bytes into the shared, content-addressed CAS and
	// returns the canonical object's compressed metadata. The canonical key is
	// write-once: a conditional put means the first promotion of a hash fixes the
	// stored encoding, and any later or concurrent upload of the same hash adopts
	// that encoding instead of overwriting it — so every narinfo for the hash
	// advertises the one object that is actually served, even when tenants upload
	// different zstd encodings of the same NAR. The staging object is left in place;
	// its caller deletes it only once the commit is durable, so a crash between
	// promotion and commit recovers from the surviving staging copy.
	async promoteStagingBlob(
		stagingKey: string,
		metadata: ParsedUploadPathNegotiation,
		blob: CanonicalBlob | undefined
	): Promise<CanonicalBlob> {
		const canonical = await this.ensureCanonicalObject(
			stagingKey,
			metadata.narHash,
			blob
		);
		const now = new Date();
		const verifiedAt = now.toISOString();

		// Record the shared fact together with the object, so `blob_state` exists
		// exactly when the canonical R2 object does. The first writer for a hash
		// fixes the metadata; a concurrent or repeated promotion keeps it, but clears
		// any reaper grace timer, since promoting is a fresh reference to the hash.
		// A verified frame is always zstd, the only encoding the server stores.
		await this.context.d1
			.insert(d1Schema.blobState)
			.values({
				narHash: metadata.narHash,
				fileHash: canonical.fileHash,
				fileSize: canonical.fileSize,
				compression: 'zstd',
				narSize: metadata.narSize,
				verifiedAt
			})
			.onConflictDoUpdate({
				target: d1Schema.blobState.narHash,
				// Advancing `verified_at` on a re-promote (which re-creates an object the
				// reaper may have collected) makes it the optimistic-concurrency token the
				// demote pass fences its delete on: a demote that scanned the old row will
				// not delete the freshly re-promoted one.
				set: { deleteAfter: sql`null`, verifiedAt }
			})
			.run();

		return canonical;
	}
}
