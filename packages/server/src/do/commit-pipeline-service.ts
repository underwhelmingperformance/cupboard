import { NarInfo } from '@cupboard/nix/narinfo';
import {
	type CommitResponse,
	type UploadPathMetadataFields
} from '@cupboard/protocol/upload';
import { and, eq, sql } from 'drizzle-orm';

import { type NarVerification } from '../blob/nar-verify.ts';
import { verifyDecompressedNar } from '../blob/nar-verify.ts';
import { verifyUploadedObject } from '../blob/upload-verification.ts';
import { signNixFingerprint } from '../crypto/crypto.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import {
	NarTooLargeError,
	NarVerificationFailedError,
	UploadCacheMismatchError,
	UploadedObjectNotFoundError,
	UploadExpiredError,
	UploadNotFoundError
} from '../errors.ts';
import {
	inlineVerifyMaxBytes,
	narInfoObjectKey,
	narObjectKey,
	verifiableMaxBytes
} from '../http/http.ts';

import { type AuthKeysService } from './auth-keys-service.ts';
import { type CacheAdminService } from './cache-admin-service.ts';
import {
	type MaterialiseOutcome,
	parseStoredUploadMetadata,
	type ReserveOutcome,
	type ServerContext,
	singleTenant
} from './context.ts';
import { type NarInfoObjectsService } from './narinfo-objects-service.ts';
import { type SigningKeysService } from './signing-keys-service.ts';
import { type UploadStateService } from './upload-state-service.ts';

export class CommitPipelineService {
	constructor(
		private readonly context: ServerContext,
		private readonly authKeys: AuthKeysService,
		private readonly cacheAdmin: CacheAdminService,
		private readonly signingKeysService: SigningKeysService,
		private readonly uploadState: UploadStateService,
		private readonly narInfoObjects: NarInfoObjectsService
	) {}

	async handleCommit(
		request: Request,
		cache: string,
		uploadId: string
	): Promise<Response> {
		await this.authKeys.requireScope(request, 'write');

		const pending = this.context.db
			.select()
			.from(schema.pendingUploads)
			.where(eq(schema.pendingUploads.id, uploadId))
			.get();

		if (pending === undefined) {
			throw new UploadNotFoundError(uploadId);
		}

		if (pending.cache !== cache) {
			throw new UploadCacheMismatchError(uploadId, pending.cache, cache);
		}

		if (pending.expiresAt < new Date().toISOString()) {
			await this.uploadState.clearPendingUploadAndStaging(
				uploadId,
				pending.r2Key,
				pending.narHash
			);

			throw new UploadExpiredError(uploadId);
		}

		this.context.db
			.update(schema.pendingUploads)
			.set({
				expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
			})
			.where(eq(schema.pendingUploads.id, uploadId))
			.run();

		const metadata = parseStoredUploadMetadata(uploadId, pending.metadataJson);
		const existingNarInfo = this.context.db
			.select()
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cache, cache),
					eq(schema.narInfos.storePathHash, metadata.storePathHash)
				)
			)
			.get();

		if (existingNarInfo !== undefined) {
			// This upload already started its own commit saga — an inline commit that
			// reserved the row but did not finish, or a deferred upload mid-verify. Its
			// row is reserved, not yet servable, and the verify pass re-drives it from
			// the durable marker. Report it in progress, leaving the marker and the
			// staged bytes the re-drive needs intact, rather than conceding and deleting
			// them. A concurrent commit, by contrast, reaches here with its own verdict
			// still null.
			if (pending.verdict === 'committing' || pending.verdict === 'pending') {
				return Response.json({
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash,
					status: 'pending'
				} satisfies CommitResponse);
			}

			if (
				!(await this.narInfoObjects.hasCommittedReference(
					cache,
					existingNarInfo
				))
			) {
				return Response.json({
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash,
					status: 'pending'
				} satisfies CommitResponse);
			}

			// A concurrent commit already holds the path: heal its object if missing
			// and concede, reclaiming this upload's own staging.
			await this.narInfoObjects.ensureNarInfoObject(
				cache,
				existingNarInfo.storePathHash
			);
			await this.uploadState.clearPendingUploadAndStaging(
				uploadId,
				pending.r2Key,
				metadata.narHash
			);

			return Response.json({
				storePathHash: metadata.storePathHash,
				narHash: existingNarInfo.narHash,
				status: 'already-present'
			} satisfies CommitResponse);
		}

		const object =
			(await this.context.env.BLOBS.head(pending.r2Key)) ?? undefined;

		verifyUploadedObject(object, pending.expectedSize, metadata, pending.r2Key);

		const canonicalKey = narObjectKey(metadata.narHash);

		// A reuse binds a new narinfo to a blob already in the verified CAS. It
		// passed verify-before-serve when it was first promoted, so bind it without
		// re-verifying its bytes.
		if (pending.r2Key === canonicalKey) {
			return this.commitReusedBlob(cache, uploadId, metadata);
		}

		// Verify-before-serve for a fresh upload staged under a private key: a blob
		// within the inline budget is verified and promoted now, so it is immediately
		// servable; a larger one is marked `pending` for the background pass; one too
		// large to verify within the CPU budget is rejected, since it could never be
		// served. A failure deletes the private staging object and leaves no global
		// trace.
		if (metadata.narSize > verifiableMaxBytes) {
			await this.uploadState.clearPendingUploadAndStaging(
				uploadId,
				pending.r2Key,
				metadata.narHash
			);

			throw new NarTooLargeError(metadata.narSize, verifiableMaxBytes);
		}

		if (metadata.narSize > inlineVerifyMaxBytes) {
			this.uploadState.markUploadPending(uploadId);

			return Response.json({
				storePathHash: metadata.storePathHash,
				narHash: metadata.narHash,
				status: 'pending'
			} satisfies CommitResponse);
		}

		return this.commitInlineUpload(cache, uploadId, metadata, pending.r2Key);
	}

	// Commits a fresh inline upload row-first: mark the saga in progress, reserve the
	// not-yet-servable row, verify the staged bytes (never serving them unverified,
	// even when `blob_state` already holds the hash), promote into the shared CAS,
	// then materialise the servable object. A concurrent commit that already holds
	// the path is conceded to; a verification failure reclaims the reserved row and
	// rejects.
	private async commitInlineUpload(
		cache: string,
		uploadId: string,
		metadata: UploadPathMetadataFields,
		stagingKey: string
	): Promise<Response> {
		this.uploadState.markUploadCommitting(uploadId);

		const reserved = await this.reserveNarInfoRow(cache, metadata);

		if (reserved.kind !== 'reserved') {
			return this.concedeToWinner(cache, uploadId, metadata, stagingKey);
		}

		// A returned `{ok:false}` is a definitive content failure (a mismatch or
		// undecodable bytes whose compressed checksum still matched): reject 422 and
		// reclaim the reserved row and staging object. A thrown error (a transient R2
		// read) propagates as a 5xx the client can retry, leaving the row reserved and
		// the bytes staged for the verify pass to re-drive.
		const verification = await this.verifyPendingNar(stagingKey, metadata);

		if (!verification.ok) {
			await this.context.ctx.blockConcurrencyWhile(() =>
				this.reclaimReservedRow(
					cache,
					metadata.storePathHash,
					reserved.generation,
					metadata.narHash
				)
			);
			await this.uploadState.clearPendingUploadAndStaging(
				uploadId,
				stagingKey,
				metadata.narHash
			);

			throw new NarVerificationFailedError(stagingKey, verification.reason);
		}

		await this.uploadState.promoteStagingBlob(stagingKey, metadata);

		const outcome = await this.context.ctx.blockConcurrencyWhile(() =>
			this.materialiseServable(cache, metadata, reserved.generation, uploadId)
		);

		if (outcome !== 'materialised') {
			return this.concedeToWinner(cache, uploadId, metadata, stagingKey);
		}

		await this.context.env.BLOBS.delete(stagingKey);

		return Response.json({
			storePathHash: metadata.storePathHash,
			narHash: metadata.narHash,
			status: 'committed'
		} satisfies CommitResponse);
	}

	// Commits a reuse of a blob already in the verified CAS: reserve the row, then
	// materialise from the existing canonical object and `blob_state`. If the shared
	// blob was reaped between negotiate and now, reclaim the row and report it gone so
	// the client re-uploads, rather than serve a narinfo with no backing object.
	private async commitReusedBlob(
		cache: string,
		uploadId: string,
		metadata: UploadPathMetadataFields
	): Promise<Response> {
		this.uploadState.markUploadCommitting(uploadId);

		const canonicalKey = narObjectKey(metadata.narHash);
		const reserved = await this.reserveNarInfoRow(cache, metadata);

		if (reserved.kind !== 'reserved') {
			return this.concedeToWinner(cache, uploadId, metadata, canonicalKey);
		}

		const outcome = await this.context.ctx.blockConcurrencyWhile(() =>
			this.materialiseServable(cache, metadata, reserved.generation, uploadId)
		);

		if (outcome === 'materialised') {
			return Response.json({
				storePathHash: metadata.storePathHash,
				narHash: metadata.narHash,
				status: 'committed'
			} satisfies CommitResponse);
		}

		if (outcome === 'superseded') {
			return this.concedeToWinner(cache, uploadId, metadata, canonicalKey);
		}

		await this.context.ctx.blockConcurrencyWhile(() =>
			this.reclaimReservedRow(
				cache,
				metadata.storePathHash,
				reserved.generation,
				metadata.narHash
			)
		);
		this.uploadState.clearPendingUpload(uploadId);

		throw new UploadedObjectNotFoundError(canonicalKey);
	}

	// Answers a commit that lost its narinfo to a concurrent winner: ensures the
	// winner's object is materialised, reclaims this upload's staging object, and
	// reports already-present with the winner's narHash. Any blob this upload
	// promoted but no edge now references is left for the reaper to collect.
	private async concedeToWinner(
		cache: string,
		uploadId: string,
		metadata: UploadPathMetadataFields,
		stagingKey: string
	): Promise<Response> {
		const winner = await this.narInfoObjects.committedNarInfoRow(
			cache,
			metadata.storePathHash
		);

		if (winner !== undefined) {
			await this.narInfoObjects.ensureNarInfoObject(
				cache,
				winner.storePathHash
			);
		}

		await this.uploadState.clearPendingUploadAndStaging(
			uploadId,
			stagingKey,
			metadata.narHash
		);

		return Response.json({
			storePathHash: metadata.storePathHash,
			narHash: winner?.narHash ?? metadata.narHash,
			status: 'already-present'
		} satisfies CommitResponse);
	}

	// Reserves the narinfo row for a commit before its bytes are verified, the
	// row-first half of the row-first/edge-last saga. It signs the fingerprint —
	// over the uncompressed `NarHash`/`NarSize`/references only, so it is independent
	// of any compressed encoding — reads and stamps the next generation, and advances
	// the durable counter, all in one DO transaction. It writes neither the D1 edge
	// nor the R2 object and never touches the pending upload, so the reserved row is
	// never servable on its own. On a conflicting row it reports whether that row is
	// this same commit (`mine`, every signed and rendered field matches) or a
	// different version that won the path (`lost`).
	async reserveNarInfoRow(
		cache: string,
		metadata: UploadPathMetadataFields
	): Promise<ReserveOutcome> {
		const now = new Date().toISOString();
		this.cacheAdmin.loadOrCreateCache(cache);
		const signingKeys = await this.signingKeysService.signingKeys();
		const fingerprint = new NarInfo(
			metadata.storePath,
			narObjectKey(metadata.narHash),
			metadata.compression,
			metadata.fileHash,
			metadata.fileSize,
			metadata.narHash,
			metadata.narSize,
			metadata.references,
			metadata.deriver,
			metadata.ca
		).fingerprint();
		const sigs = await Promise.all(
			signingKeys.map((key) =>
				signNixFingerprint(key.privateJwk, fingerprint, key.name)
			)
		);
		const referencesJson = JSON.stringify(metadata.references);

		// Source the generation inside the same transaction as the insert and the
		// counter advance, so a winning reservation reads, stamps and bumps
		// atomically; the counter survives deletes, so a recommit always lands a
		// higher one.
		return this.context.db.transaction((tx) => {
			const seq = tx
				.select({ next: schema.generationSeq.nextGeneration })
				.from(schema.generationSeq)
				.where(
					and(
						eq(schema.generationSeq.cache, cache),
						eq(schema.generationSeq.storePathHash, metadata.storePathHash)
					)
				)
				.get();
			const generation = seq?.next ?? 0;
			const inserted = tx
				.insert(schema.narInfos)
				.values({
					cache,
					storePathHash: metadata.storePathHash,
					storePath: metadata.storePath,
					narHash: metadata.narHash,
					narSize: metadata.narSize,
					referencesJson,
					deriver: metadata.deriver,
					ca: metadata.ca,
					sigsJson: JSON.stringify(sigs),
					generation,
					createdAt: now
				} satisfies typeof schema.narInfos.$inferInsert)
				.onConflictDoNothing()
				.returning()
				.all();

			if (inserted.length > 0) {
				tx.insert(schema.generationSeq)
					.values({
						cache,
						storePathHash: metadata.storePathHash,
						nextGeneration: generation + 1
					})
					.onConflictDoUpdate({
						target: [
							schema.generationSeq.cache,
							schema.generationSeq.storePathHash
						],
						set: { nextGeneration: generation + 1 }
					})
					.run();

				return { kind: 'reserved', generation };
			}

			const existing = tx
				.select()
				.from(schema.narInfos)
				.where(
					and(
						eq(schema.narInfos.cache, cache),
						eq(schema.narInfos.storePathHash, metadata.storePathHash)
					)
				)
				.get();

			// A row already holds the path. Treat it as this same commit only when
			// every signed and rendered field matches; any difference means a
			// different narinfo version won, and this upload must not adopt its row.
			const mine =
				existing?.narHash === metadata.narHash &&
				existing.narSize === metadata.narSize &&
				existing.storePath === metadata.storePath &&
				existing.referencesJson === referencesJson &&
				(existing.deriver ?? undefined) === metadata.deriver &&
				(existing.ca ?? undefined) === metadata.ca;

			if (mine) {
				return { kind: 'mine', generation: existing.generation };
			}

			return { kind: 'lost', narHash: existing?.narHash ?? metadata.narHash };
		});
	}

	// Makes a reserved narinfo servable, the edge-last half of the saga and the only
	// place that writes the reference edge and the served object or clears the
	// pending upload. It requires the shared blob to be present — the `available`
	// `blob_state` fact and the canonical R2 object — re-reads the live row to
	// confirm it is still this reserved version, writes the D1 edge and per-tenant
	// presence, renders the object from the canonical compressed metadata in
	// `blob_state`, puts it, and clears the pending upload last. Every step is
	// idempotent, so a crash before the final clear leaves the upload re-drivable
	// from its durable marker.
	//
	// Runs inside the caller's critical section; must not open its own.
	async materialiseServable(
		cache: string,
		metadata: UploadPathMetadataFields,
		generation: number,
		uploadId: string
	): Promise<MaterialiseOutcome> {
		const blob = await this.context.d1
			.select({ fileSize: d1Schema.blobState.fileSize })
			.from(d1Schema.blobState)
			.where(eq(d1Schema.blobState.narHash, metadata.narHash))
			.get();
		const canonicalPresent =
			(await this.context.env.BLOBS.head(narObjectKey(metadata.narHash))) !==
			null;

		if (blob === undefined || !canonicalPresent) {
			return 'blob-gone';
		}

		const row = this.context.db
			.select()
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cache, cache),
					eq(schema.narInfos.storePathHash, metadata.storePathHash)
				)
			)
			.get();

		// A concurrent recommit may have replaced the row between reserve and now;
		// only materialise the version this commit reserved, so the edge and the
		// served object always describe the same narinfo version.
		if (row?.generation !== generation || row.narHash !== metadata.narHash) {
			return 'superseded';
		}

		const narInfo = await this.narInfoObjects.narInfoFromRow(row);

		if (narInfo === undefined) {
			return 'blob-gone';
		}

		await this.context.d1
			.insert(d1Schema.blobReference)
			.values({
				tenant: singleTenant,
				cache,
				storePathHash: metadata.storePathHash,
				generation,
				narHash: metadata.narHash
			})
			.onConflictDoNothing()
			.run();
		await this.context.d1
			.insert(d1Schema.tenantBlob)
			.values({
				tenant: singleTenant,
				narHash: metadata.narHash,
				fileSize: blob.fileSize
			})
			.onConflictDoNothing()
			.run();

		// Clear any reaper grace timer: writing the edge is a fresh reference, so a
		// reuse commit (which does not promote) and any commit racing the reaper both
		// keep the shared blob alive.
		await this.context.d1
			.update(d1Schema.blobState)
			.set({ deleteAfter: sql`null` })
			.where(eq(d1Schema.blobState.narHash, metadata.narHash))
			.run();

		await this.narInfoObjects.putNarInfoObject(
			cache,
			metadata.storePathHash,
			narInfo
		);
		this.uploadState.clearPendingUpload(uploadId);

		return 'materialised';
	}

	// Removes a reserved narinfo row whose commit failed verification, leaving its
	// burned generation in `generation_seq` (monotonic, never reused). Compare-and-
	// delete on the captured `(generation, narHash)`, and only while the row is not
	// yet materialised, so neither a newer recommit nor a concurrent commit that has
	// already made the path servable is ever removed. Runs in a critical section so
	// the object check and the delete cannot interleave with a materialisation.
	//
	// Runs inside the caller's critical section; must not open its own.
	async reclaimReservedRow(
		cache: string,
		storePathHash: string,
		generation: number,
		narHash: string
	): Promise<void> {
		const materialised = await this.context.d1
			.select({ narHash: d1Schema.blobReference.narHash })
			.from(d1Schema.blobReference)
			.where(
				and(
					eq(d1Schema.blobReference.tenant, singleTenant),
					eq(d1Schema.blobReference.cache, cache),
					eq(d1Schema.blobReference.storePathHash, storePathHash),
					eq(d1Schema.blobReference.generation, generation),
					eq(d1Schema.blobReference.narHash, narHash)
				)
			)
			.get();

		if (materialised !== undefined) {
			return;
		}

		await this.context.env.BLOBS.delete(narInfoObjectKey(storePathHash, cache));

		this.context.db
			.delete(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cache, cache),
					eq(schema.narInfos.storePathHash, storePathHash),
					eq(schema.narInfos.generation, generation),
					eq(schema.narInfos.narHash, narHash)
				)
			)
			.run();
	}

	async verifyPendingNar(
		r2Key: string,
		metadata: UploadPathMetadataFields
	): Promise<NarVerification> {
		const object = await this.context.env.BLOBS.get(r2Key);

		if (object === null) {
			throw new UploadedObjectNotFoundError(r2Key);
		}

		// R2 object bodies are byte streams, but `R2ObjectBody.body` is typed only
		// as `ReadableStream`; narrow it to the byte stream the verifier expects.
		const body = object.body as ReadableStream<Uint8Array>;

		return verifyDecompressedNar(body, {
			narHash: metadata.narHash,
			narSize: metadata.narSize
		});
	}
}
