import {
	type CommitResponse,
	DeletePathRequest,
	type DeletePathRequestFields,
	type DeletePathResponse,
	type InitResponse,
	NarInfo,
	NixSha256Hash,
	ProtocolError,
	type RootListResponse,
	RootRemoveRequest,
	type RootRemoveRequestFields,
	type RootRemoveResponse,
	RootSetRequest,
	type RootSetRequestFields,
	type RootSetResponse,
	type RootSummary,
	type RootTarget,
	type StatsResponse,
	UploadBlobMetadata,
	type UploadDecision,
	type UploadNegotiateRequest,
	type UploadNegotiateResponse,
	UploadPathCommitMetadata,
	UploadPathMetadata,
	type UploadPathMetadataFields,
	type UploadPrepareRequest,
	type UploadPrepareResponse
} from '@cupboard/shared';
import { DurableObject } from 'cloudflare:workers';
import { and, count, eq, gte, lt, sql } from 'drizzle-orm';
import {
	drizzle,
	type DrizzleSqliteDODatabase
} from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { Hono } from 'hono';
import { StatusCodes } from 'http-status-codes';

import migrations from '../drizzle/migrations.js';

import {
	constantTimeEqual,
	generateSigningKey,
	sha256Hex,
	signNixFingerprint
} from './crypto.ts';
import * as schema from './db/schema.ts';
import {
	InvalidDeletePathRequestError,
	InvalidJsonRequestBodyError,
	InvalidRootRequestError,
	InvalidUploadMetadataRequestError,
	type R2PresignBindingName,
	R2PresignConfigurationMissingError,
	ServerHttpError,
	StoredUploadMetadataInvalidError,
	UploadedObjectChecksumMismatchError,
	UploadedObjectChecksumMissingError,
	UploadNotPreparedError
} from './errors.ts';
import {
	narInfoCacheControl,
	narInfoObjectKey,
	narObjectKey,
	orphanBlobDeletionGraceMs,
	TextBody,
	textResponse
} from './http.ts';
import { R2Presigner } from './presign.ts';

type WidenStringBindings<T> = {
	readonly [Key in keyof T]: T[Key] extends string ? string : T[Key];
};

type RuntimeEnv = WidenStringBindings<Env>;

type SchemaDatabase = DrizzleSqliteDODatabase<typeof schema>;

// Either the DO database or a transaction handle from db.transaction(...); both
// expose the same query builder, so writes can be parameterised over the handle.
type SchemaWriter =
	| SchemaDatabase
	| Parameters<Parameters<SchemaDatabase['transaction']>[0]>[0];

interface SigningKey {
	readonly privateJwk: JsonWebKey;
	readonly publicKey: string;
}

export class CupboardServer extends DurableObject<RuntimeEnv> {
	private readonly app = new Hono<{ Bindings: RuntimeEnv }>();
	private readonly db: DrizzleSqliteDODatabase<typeof schema>;
	private migrationPromise: Promise<void> | undefined;
	private presigner: R2Presigner | undefined;
	private publicKeyBody: TextBody | undefined;

	constructor(ctx: DurableObjectState, env: RuntimeEnv) {
		super(ctx, env);
		this.db = drizzle(ctx.storage, {
			schema
		});
		this.routes();
	}

	async fetch(request: Request): Promise<Response> {
		await this.initialise();

		return this.app.fetch(request, this.env);
	}

	private routes(): void {
		this.app.on(['GET', 'HEAD'], '/pubkey', async (context) => {
			const key = await this.signingKey();

			this.publicKeyBody ??= new TextBody(`${key.publicKey}\n`);

			return textResponse(context.req.raw, this.publicKeyBody, {
				'content-type': 'text/plain; charset=utf-8'
			});
		});

		this.app.get('/_stats', async (context) => {
			if (!(await this.isTokenAuthorised(context.req.raw))) {
				return context.text('Unauthorised\n', StatusCodes.UNAUTHORIZED);
			}

			return context.json(this.stats());
		});

		this.app.post('/admin/init', (context) => this.handleInit(context.req.raw));
		this.app.post('/admin/delete', (context) =>
			serverErrorResponse(this.handleDeletePath(context.req.raw))
		);
		this.app.post('/admin/roots', (context) =>
			serverErrorResponse(this.handleSetRoot(context.req.raw))
		);
		this.app.get('/admin/roots', (context) =>
			serverErrorResponse(this.handleListRoots(context.req.raw))
		);
		this.app.post('/admin/roots/remove', (context) =>
			serverErrorResponse(this.handleRemoveRoot(context.req.raw))
		);
		this.app.post('/upload/negotiate', (context) =>
			serverErrorResponse(this.handleNegotiate(context.req.raw))
		);
		this.app.post('/upload/:id/prepare', (context) =>
			serverErrorResponse(
				this.handlePrepareUpload(context.req.raw, context.req.param('id'))
			)
		);
		this.app.post('/upload/:id/commit', (context) =>
			serverErrorResponse(
				this.handleCommit(context.req.raw, context.req.param('id'))
			)
		);
		this.app.post('/_cron/gc', () => this.handleGarbageCollection());
	}

	private async handleInit(request: Request): Promise<Response> {
		if (!(await this.isBootstrapAuthorised(request))) {
			return new Response('Unauthorised\n', {
				status: StatusCodes.UNAUTHORIZED
			});
		}

		const existingToken = this.db
			.select({ count: count() })
			.from(schema.tokens)
			.get();
		const key = await this.signingKey();
		const url = new URL(request.url).origin;

		if ((existingToken?.count ?? 0) > 0) {
			return Response.json({
				url,
				token: '',
				publicKey: key.publicKey
			} satisfies InitResponse);
		}

		const token = crypto.randomUUID().replaceAll('-', '');

		this.db
			.insert(schema.tokens)
			.values({
				id: 'admin',
				hash: await sha256Hex(token),
				scope: 'admin',
				createdAt: new Date().toISOString()
			})
			.run();

		return Response.json({
			url,
			token,
			publicKey: key.publicKey
		} satisfies InitResponse);
	}

	private async handleDeletePath(request: Request): Promise<Response> {
		if (!(await this.isTokenAuthorised(request))) {
			return new Response('Unauthorised\n', {
				status: StatusCodes.UNAUTHORIZED
			});
		}

		const requested = parseDeletePathRequest(
			await parseJsonRequest<DeletePathRequestFields>(request)
		);
		const result = await this.deleteStorePath(
			requested.storePathHash,
			new URL(request.url).origin
		);

		return Response.json(result satisfies DeletePathResponse);
	}

	private async handleSetRoot(request: Request): Promise<Response> {
		if (!(await this.isTokenAuthorised(request))) {
			return new Response('Unauthorised\n', {
				status: StatusCodes.UNAUTHORIZED
			});
		}

		const requested = parseRootSetRequest(
			await parseJsonRequest<RootSetRequestFields>(request)
		);

		return Response.json(this.setRoot(requested) satisfies RootSetResponse);
	}

	private async handleListRoots(request: Request): Promise<Response> {
		if (!(await this.isTokenAuthorised(request))) {
			return new Response('Unauthorised\n', {
				status: StatusCodes.UNAUTHORIZED
			});
		}

		return Response.json(this.listRoots() satisfies RootListResponse);
	}

	private async handleRemoveRoot(request: Request): Promise<Response> {
		if (!(await this.isTokenAuthorised(request))) {
			return new Response('Unauthorised\n', {
				status: StatusCodes.UNAUTHORIZED
			});
		}

		const requested = parseRootRemoveRequest(
			await parseJsonRequest<RootRemoveRequestFields>(request)
		);

		return Response.json(
			this.removeRoot(requested.name) satisfies RootRemoveResponse
		);
	}

	private setRoot(request: RootSetRequest): RootSetResponse {
		const now = new Date();
		const nowIso = now.toISOString();
		const expiresAt =
			request.ttlSeconds === undefined
				? undefined
				: new Date(now.getTime() + request.ttlSeconds * 1000).toISOString();

		// Replace the root wholesale: a re-set fully declares the channel, so the
		// old row and target set are dropped and rewritten. The createdAt of an
		// existing channel is preserved; an absent expiry stores SQL NULL via the
		// undefined insert value.
		const createdAt = this.db.transaction((tx) => {
			const existing = tx
				.select()
				.from(schema.retentionRoots)
				.where(eq(schema.retentionRoots.name, request.name))
				.get();
			const created = existing?.createdAt ?? nowIso;

			tx.delete(schema.retentionRootTargets)
				.where(eq(schema.retentionRootTargets.rootName, request.name))
				.run();
			tx.delete(schema.retentionRoots)
				.where(eq(schema.retentionRoots.name, request.name))
				.run();

			tx.insert(schema.retentionRoots)
				.values({
					name: request.name,
					expiresAt,
					createdAt: created,
					updatedAt: nowIso
				})
				.run();

			tx.insert(schema.retentionRootTargets)
				.values(
					request.targets.map((target) => ({
						rootName: request.name,
						storePathHash: target.storePathHash,
						storePath: target.storePath
					}))
				)
				.run();

			return created;
		});

		return this.rootSummary(request.name, expiresAt, createdAt, nowIso, nowIso);
	}

	private listRoots(): RootListResponse {
		const now = new Date().toISOString();
		const roots = this.db.select().from(schema.retentionRoots).all();

		return {
			roots: roots
				.map((root) =>
					this.rootSummary(
						root.name,
						root.expiresAt ?? undefined,
						root.createdAt,
						root.updatedAt,
						now
					)
				)
				.toSorted((a, b) => (a.name > b.name ? 1 : -1))
		};
	}

	private removeRoot(name: string): RootRemoveResponse {
		return this.db.transaction((tx) => {
			const existing = tx
				.select()
				.from(schema.retentionRoots)
				.where(eq(schema.retentionRoots.name, name))
				.get();

			tx.delete(schema.retentionRootTargets)
				.where(eq(schema.retentionRootTargets.rootName, name))
				.run();
			tx.delete(schema.retentionRoots)
				.where(eq(schema.retentionRoots.name, name))
				.run();

			return { name, removed: existing !== undefined };
		});
	}

	private rootSummary(
		name: string,
		expiresAt: string | undefined,
		createdAt: string,
		updatedAt: string,
		now: string
	): RootSummary {
		const targets = this.db
			.select()
			.from(schema.retentionRootTargets)
			.where(eq(schema.retentionRootTargets.rootName, name))
			.all();

		return {
			name,
			...(expiresAt === undefined ? {} : { expiresAt }),
			expired: expiresAt !== undefined && expiresAt <= now,
			createdAt,
			updatedAt,
			targets: this.rootTargets(targets)
		};
	}

	private rootTargets(
		pairs: readonly { storePathHash: string; storePath: string }[]
	): RootTarget[] {
		return pairs
			.map((pair) => ({
				storePathHash: pair.storePathHash,
				storePath: pair.storePath,
				present: this.hasCommittedNarInfo(pair.storePathHash)
			}))
			.toSorted((a, b) => (a.storePathHash > b.storePathHash ? 1 : -1));
	}

	private hasCommittedNarInfo(storePathHash: string): boolean {
		return (
			this.db
				.select()
				.from(schema.narInfos)
				.where(eq(schema.narInfos.storePathHash, storePathHash))
				.get() !== undefined
		);
	}

	private async handleNegotiate(request: Request): Promise<Response> {
		if (!(await this.isTokenAuthorised(request))) {
			return new Response('Unauthorised\n', {
				status: StatusCodes.UNAUTHORIZED
			});
		}

		const body = await parseJsonRequest<UploadNegotiateRequest>(request);
		const uploads: UploadDecision[] = [];

		for (const fields of body.paths) {
			const metadata = parseUploadMetadata(fields);
			const existingNarInfo = this.db
				.select()
				.from(schema.narInfos)
				.where(eq(schema.narInfos.storePathHash, metadata.storePathHash))
				.get();

			if (existingNarInfo !== undefined) {
				const object = await this.env.BLOBS.head(
					narObjectKey(existingNarInfo.narHash)
				);

				if (object !== null) {
					await this.ensureNarInfoObject(existingNarInfo.storePathHash);
					uploads.push({
						action: 'skip',
						storePathHash: metadata.storePathHash,
						narHash: existingNarInfo.narHash
					});
					continue;
				}

				await this.removeStaleNarInfo(
					existingNarInfo,
					new URL(request.url).origin
				);
			}

			await this.flushQueuedBlobDeletion(metadata.r2Key);

			const existingBlob = await this.findReusableBlob(metadata.narHash);
			const uploadId = crypto.randomUUID();
			const now = new Date();
			const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);
			const pendingMetadata =
				existingBlob === undefined
					? metadata
					: UploadPathCommitMetadata.fromPathAndBlob(
							metadata,
							UploadBlobMetadata.fromFields(existingBlob)
						);

			this.db
				.insert(schema.pendingUploads)
				.values({
					id: uploadId,
					narHash: metadata.narHash,
					r2Key: metadata.r2Key,
					expectedSize:
						pendingMetadata instanceof UploadPathCommitMetadata
							? pendingMetadata.fileSize
							: 0,
					metadataJson: JSON.stringify(pendingMetadata.toFields()),
					createdAt: now.toISOString(),
					expiresAt: expiresAt.toISOString()
				})
				.run();

			if (existingBlob !== undefined) {
				uploads.push({
					action: 'commit',
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash,
					uploadId
				});
				continue;
			}

			uploads.push({
				action: 'upload',
				storePathHash: metadata.storePathHash,
				narHash: metadata.narHash,
				uploadId,
				r2Key: metadata.r2Key,
				expiresAt: expiresAt.toISOString()
			});
		}

		return Response.json({ uploads } satisfies UploadNegotiateResponse);
	}

	private async handlePrepareUpload(
		request: Request,
		uploadId: string
	): Promise<Response> {
		if (!(await this.isTokenAuthorised(request))) {
			return new Response('Unauthorised\n', {
				status: StatusCodes.UNAUTHORIZED
			});
		}

		const pending = this.db
			.select()
			.from(schema.pendingUploads)
			.where(eq(schema.pendingUploads.id, uploadId))
			.get();

		if (pending === undefined) {
			return new Response('Upload not found\n', {
				status: StatusCodes.NOT_FOUND
			});
		}

		if (pending.expiresAt < new Date().toISOString()) {
			this.clearPendingUpload(uploadId);

			return new Response('Upload expired\n', {
				status: StatusCodes.NOT_FOUND
			});
		}

		const pathMetadata = parseStoredUploadPathMetadata(
			uploadId,
			pending.metadataJson
		);
		const blobMetadata = parseUploadBlobMetadata(
			await parseJsonRequest<UploadPrepareRequest>(request)
		);
		const metadata = UploadPathCommitMetadata.fromPathAndBlob(
			pathMetadata,
			blobMetadata
		);
		const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

		this.db
			.update(schema.pendingUploads)
			.set({
				expectedSize: metadata.fileSize,
				metadataJson: JSON.stringify(metadata.toFields()),
				expiresAt: expiresAt.toISOString()
			})
			.where(eq(schema.pendingUploads.id, uploadId))
			.run();

		return Response.json({
			uploadUrl: await this.presignedPutUrl(
				metadata.r2Key,
				metadata.fileHash,
				expiresAt
			),
			uploadHeaders: uploadHeadersFor(metadata),
			expiresAt: expiresAt.toISOString()
		} satisfies UploadPrepareResponse);
	}

	private async findReusableBlob(
		narHash: string
	): Promise<typeof schema.narBlobs.$inferSelect | undefined> {
		const existingBlob = this.db
			.select()
			.from(schema.narBlobs)
			.where(eq(schema.narBlobs.narHash, narHash))
			.get();

		if (existingBlob === undefined) {
			return undefined;
		}

		const object = await this.env.BLOBS.head(existingBlob.r2Key);

		if (object !== null) {
			return existingBlob;
		}

		this.clearNarBlob(existingBlob.narHash);

		return undefined;
	}

	private queueOrphanBlobDeletion(r2Key: string, now: string): void {
		if (this.hasCommittedBlob(r2Key) || this.hasLivePendingUpload(r2Key, now)) {
			return;
		}

		this.enqueueOrphanBlobDeletion(this.db, r2Key, now, now);
	}

	private enqueueOrphanBlobDeletion(
		handle: SchemaWriter,
		r2Key: string,
		notBefore: string,
		now: string
	): void {
		// Monotonic: a delayed entry (a deliberate delete records now + grace) must
		// never be pulled forward by a later immediate enqueue, so take the later
		// timestamp on conflict. ISO-8601 sorts lexicographically.
		handle
			.insert(schema.orphanBlobDeletions)
			.values({ r2Key, notBefore, createdAt: now })
			.onConflictDoUpdate({
				target: schema.orphanBlobDeletions.r2Key,
				set: {
					notBefore: sql`max(${schema.orphanBlobDeletions.notBefore}, excluded.not_before)`
				}
			})
			.run();
	}

	private async flushQueuedBlobDeletion(r2Key: string): Promise<boolean> {
		const queued = this.db
			.select()
			.from(schema.orphanBlobDeletions)
			.where(eq(schema.orphanBlobDeletions.r2Key, r2Key))
			.get();

		if (queued === undefined) {
			return false;
		}

		const now = new Date().toISOString();

		return this.ctx.blockConcurrencyWhile(() =>
			this.deleteQueuedOrphanBlob(r2Key, now)
		);
	}

	private async flushQueuedBlobDeletions(now: string): Promise<number> {
		const queued = this.db.select().from(schema.orphanBlobDeletions).all();
		let deleted = 0;

		for (const deletion of queued) {
			if (await this.deleteQueuedOrphanBlob(deletion.r2Key, now)) {
				deleted += 1;
			}
		}

		return deleted;
	}

	private async deleteQueuedOrphanBlob(
		r2Key: string,
		now: string
	): Promise<boolean> {
		const queued = this.db
			.select()
			.from(schema.orphanBlobDeletions)
			.where(eq(schema.orphanBlobDeletions.r2Key, r2Key))
			.get();

		if (queued === undefined) {
			return false;
		}

		if (now < queued.notBefore) {
			return false;
		}

		if (this.hasCommittedBlob(r2Key) || this.hasLivePendingUpload(r2Key, now)) {
			this.clearQueuedBlobDeletion(r2Key);
			return false;
		}

		await this.env.BLOBS.delete(r2Key);
		this.clearQueuedBlobDeletion(r2Key);

		return true;
	}

	private enqueueNarInfoDeletion(
		handle: SchemaWriter,
		storePathHash: string,
		narHash: string,
		now: string,
		generation = 0
	): void {
		// The R2 key is deterministic, but each captured narinfo version may own a
		// distinct reference edge once generations are introduced later in the stack.
		handle
			.insert(schema.narInfoDeletions)
			.values({ storePathHash, narHash, generation, createdAt: now })
			.onConflictDoNothing()
			.run();
	}

	private clearQueuedNarInfoDeletion(
		storePathHash: string,
		generation: number
	): void {
		this.db
			.delete(schema.narInfoDeletions)
			.where(
				and(
					eq(schema.narInfoDeletions.storePathHash, storePathHash),
					eq(schema.narInfoDeletions.generation, generation)
				)
			)
			.run();
	}

	private narHashUnreferenced(narHash: string): boolean {
		return (
			this.db
				.select()
				.from(schema.narInfos)
				.where(eq(schema.narInfos.narHash, narHash))
				.get() === undefined
		);
	}

	private async flushQueuedNarInfoDeletions(origin?: string): Promise<number> {
		const queued = this.db.select().from(schema.narInfoDeletions).all();
		let deleted = 0;

		for (const entry of queued) {
			const { objectDeleted } = await this.deleteQueuedNarInfo(
				entry.storePathHash,
				entry.generation,
				origin
			);

			if (objectDeleted) {
				deleted += 1;
			}
		}

		return deleted;
	}

	private async deleteQueuedNarInfo(
		storePathHash: string,
		generation: number,
		origin?: string
	): Promise<{ objectDeleted: boolean; narScheduledForDeletion: boolean }> {
		// Must run inside a DO critical section: the row check, object delete, NAR
		// scheduling and queue clear span awaits and must not interleave with a
		// commit or another flush.
		const queued = this.db
			.select()
			.from(schema.narInfoDeletions)
			.where(
				and(
					eq(schema.narInfoDeletions.storePathHash, storePathHash),
					eq(schema.narInfoDeletions.generation, generation)
				)
			)
			.get();

		if (queued === undefined) {
			return { objectDeleted: false, narScheduledForDeletion: false };
		}

		// The row is truth: a re-committed path owns a live object again, so drop
		// the stale cleanup rather than delete the new object.
		const reCommitted =
			this.db
				.select()
				.from(schema.narInfos)
				.where(eq(schema.narInfos.storePathHash, storePathHash))
				.get() !== undefined;

		if (reCommitted) {
			this.clearQueuedNarInfoDeletion(storePathHash, generation);
			return { objectDeleted: false, narScheduledForDeletion: false };
		}

		await this.env.BLOBS.delete(narInfoObjectKey(storePathHash));

		if (origin !== undefined) {
			await this.purgeCachedNarInfo(`${origin}/${storePathHash}.narinfo`);
		}

		// The object is gone, so the NAR grace can start now. Re-check references:
		// a path may have committed the same NAR since the row was removed, so only
		// retire the blob when it is genuinely unreferenced.
		const narScheduledForDeletion = this.narHashUnreferenced(queued.narHash);

		if (narScheduledForDeletion) {
			const now = new Date();
			this.clearNarBlob(queued.narHash);
			this.enqueueOrphanBlobDeletion(
				this.db,
				narObjectKey(queued.narHash),
				new Date(now.getTime() + orphanBlobDeletionGraceMs).toISOString(),
				now.toISOString()
			);
		}

		this.clearQueuedNarInfoDeletion(storePathHash, generation);

		return { objectDeleted: true, narScheduledForDeletion };
	}

	private hasCommittedBlob(r2Key: string): boolean {
		return (
			this.db
				.select()
				.from(schema.narBlobs)
				.where(eq(schema.narBlobs.r2Key, r2Key))
				.get() !== undefined
		);
	}

	private hasLivePendingUpload(r2Key: string, now: string): boolean {
		return (
			this.db
				.select()
				.from(schema.pendingUploads)
				.where(
					and(
						eq(schema.pendingUploads.r2Key, r2Key),
						gte(schema.pendingUploads.expiresAt, now)
					)
				)
				.get() !== undefined
		);
	}

	private async handleCommit(
		request: Request,
		uploadId: string
	): Promise<Response> {
		if (!(await this.isTokenAuthorised(request))) {
			return new Response('Unauthorised\n', {
				status: StatusCodes.UNAUTHORIZED
			});
		}

		const pending = this.db
			.select()
			.from(schema.pendingUploads)
			.where(eq(schema.pendingUploads.id, uploadId))
			.get();

		if (pending === undefined) {
			return new Response('Upload not found\n', {
				status: StatusCodes.NOT_FOUND
			});
		}

		if (pending.expiresAt < new Date().toISOString()) {
			this.clearPendingUpload(uploadId);

			return new Response('Upload expired\n', {
				status: StatusCodes.NOT_FOUND
			});
		}

		this.db
			.update(schema.pendingUploads)
			.set({
				expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
			})
			.where(eq(schema.pendingUploads.id, uploadId))
			.run();

		const metadata = parseStoredUploadMetadata(uploadId, pending.metadataJson);
		const existingNarInfo = this.db
			.select()
			.from(schema.narInfos)
			.where(eq(schema.narInfos.storePathHash, metadata.storePathHash))
			.get();

		if (existingNarInfo !== undefined) {
			await this.ensureNarInfoObject(existingNarInfo.storePathHash);
			this.clearPendingUpload(uploadId);

			return Response.json({
				storePathHash: metadata.storePathHash,
				narHash: existingNarInfo.narHash,
				status: 'already-present'
			} satisfies CommitResponse);
		}

		const object = await this.env.BLOBS.head(pending.r2Key);

		if (object === null) {
			return new Response('Uploaded object not found\n', {
				status: StatusCodes.BAD_REQUEST
			});
		}

		if (object.size !== pending.expectedSize) {
			return new Response('Uploaded object size does not match metadata\n', {
				status: StatusCodes.BAD_REQUEST
			});
		}

		verifyObjectChecksum(metadata, object);

		const committed = await this.commitMetadata(metadata);
		this.clearPendingUpload(uploadId);

		if (committed) {
			return Response.json({
				storePathHash: metadata.storePathHash,
				narHash: metadata.narHash,
				status: 'committed'
			} satisfies CommitResponse);
		}

		const winner = this.db
			.select()
			.from(schema.narInfos)
			.where(eq(schema.narInfos.storePathHash, metadata.storePathHash))
			.get();

		if (winner !== undefined) {
			await this.ensureNarInfoObject(winner.storePathHash);
		}

		return Response.json({
			storePathHash: metadata.storePathHash,
			narHash: winner?.narHash ?? metadata.narHash,
			status: 'already-present'
		} satisfies CommitResponse);
	}

	private narInfoFromRow(row: typeof schema.narInfos.$inferSelect): NarInfo {
		return new NarInfo(
			row.storePath,
			narObjectKey(row.narHash),
			row.compression,
			row.fileHash,
			row.fileSize,
			row.narHash,
			row.narSize,
			JSON.parse(row.referencesJson) as readonly string[],
			row.deriver ?? undefined,
			row.ca ?? undefined,
			row.sig ?? undefined
		);
	}

	private async ensureNarInfoObject(storePathHash: string): Promise<void> {
		// Runs in a critical section, and against a freshly read row, so it cannot
		// race a delete: a concurrent delete that removed the row after the caller
		// read it must not be undone by re-materialising the object from a stale
		// copy.
		await this.ctx.blockConcurrencyWhile(async () => {
			const existing = await this.env.BLOBS.head(
				narInfoObjectKey(storePathHash)
			);

			if (existing !== null) {
				return;
			}

			const row = this.db
				.select()
				.from(schema.narInfos)
				.where(eq(schema.narInfos.storePathHash, storePathHash))
				.get();

			if (row === undefined) {
				return;
			}

			await this.putNarInfoObject(storePathHash, this.narInfoFromRow(row));
		});
	}

	private async putNarInfoObject(
		storePathHash: string,
		narInfo: NarInfo
	): Promise<void> {
		await this.env.BLOBS.put(
			narInfoObjectKey(storePathHash),
			narInfo.render(),
			{
				httpMetadata: {
					contentType: 'text/x-nix-narinfo; charset=utf-8',
					cacheControl: narInfoCacheControl
				}
			}
		);
	}

	private stats(): StatsResponse {
		const storePaths = this.db
			.select({ count: count() })
			.from(schema.narInfos)
			.get();
		const blobs = this.db
			.select({ count: count() })
			.from(schema.narBlobs)
			.get();
		const pending = this.db
			.select({ count: count() })
			.from(schema.pendingUploads)
			.get();
		const total = this.db
			.select({
				total: sql<number>`coalesce(sum(${schema.narBlobs.fileSize}), 0)`
			})
			.from(schema.narBlobs)
			.get();

		return {
			storePaths: storePaths?.count ?? 0,
			narBlobs: blobs?.count ?? 0,
			pendingUploads: pending?.count ?? 0,
			totalFileSize: total?.total ?? 0
		};
	}

	private async handleGarbageCollection(): Promise<Response> {
		const now = new Date().toISOString();
		const result = await this.ctx.blockConcurrencyWhile(async () => {
			const expiredUploads = this.db
				.select()
				.from(schema.pendingUploads)
				.where(lt(schema.pendingUploads.expiresAt, now))
				.all();

			for (const upload of expiredUploads) {
				this.queueOrphanBlobDeletion(upload.r2Key, now);
			}

			this.db
				.delete(schema.pendingUploads)
				.where(lt(schema.pendingUploads.expiresAt, now))
				.run();

			return {
				pendingUploadsDeleted: expiredUploads.length,
				narInfosDeleted: await this.flushQueuedNarInfoDeletions(),
				blobsDeleted: await this.flushQueuedBlobDeletions(now)
			};
		});

		return Response.json({
			ok: true,
			...result
		});
	}

	private async commitMetadata(
		metadata: UploadPathCommitMetadata
	): Promise<boolean> {
		const now = new Date().toISOString();
		const key = await this.signingKey();
		const unsigned = new NarInfo(
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
		);
		const sig = await signNixFingerprint(
			key.privateJwk,
			unsigned.fingerprint()
		);
		const narBlobRow = {
			narHash: metadata.narHash,
			r2Key: metadata.r2Key,
			compression: metadata.compression,
			fileHash: metadata.fileHash,
			fileSize: metadata.fileSize,
			createdAt: now
		} satisfies typeof schema.narBlobs.$inferInsert;
		const { narHash: _narHash, ...narBlobUpdate } = narBlobRow;

		const won = this.db.transaction((tx) => {
			const rows = tx
				.insert(schema.narInfos)
				.values({
					storePathHash: metadata.storePathHash,
					storePath: metadata.storePath,
					narHash: metadata.narHash,
					narSize: metadata.narSize,
					fileHash: metadata.fileHash,
					fileSize: metadata.fileSize,
					compression: metadata.compression,
					referencesJson: JSON.stringify(metadata.references),
					deriver: metadata.deriver,
					ca: metadata.ca,
					sig,
					createdAt: now
				} satisfies typeof schema.narInfos.$inferInsert)
				.onConflictDoNothing()
				.returning()
				.all();

			if (rows.length === 0) {
				return false;
			}

			tx.insert(schema.narBlobs)
				.values(narBlobRow)
				.onConflictDoUpdate({
					target: schema.narBlobs.narHash,
					set: narBlobUpdate
				})
				.run();

			return true;
		});

		if (!won) {
			return false;
		}

		const signed = NarInfo.fromFields({ ...unsigned.toFields(), sig });
		await this.putNarInfoObject(metadata.storePathHash, signed);

		return true;
	}

	private clearPendingUpload(uploadId: string): void {
		this.db
			.delete(schema.pendingUploads)
			.where(eq(schema.pendingUploads.id, uploadId))
			.run();
	}

	private async removeStaleNarInfo(
		row: typeof schema.narInfos.$inferSelect,
		origin: string
	): Promise<void> {
		// Row-first, as for deleteStorePath: the transaction removes the row and
		// queues the narinfo object cleanup, so an interrupted recovery cannot
		// resurrect the path through a heal. The object delete that follows is
		// opportunistic and GC finishes anything left in the queue.
		await this.ctx.blockConcurrencyWhile(async () => {
			const now = new Date().toISOString();

			this.db.transaction((tx) => {
				tx.delete(schema.narInfos)
					.where(eq(schema.narInfos.storePathHash, row.storePathHash))
					.run();
				this.enqueueNarInfoDeletion(tx, row.storePathHash, row.narHash, now);
			});

			try {
				await this.deleteQueuedNarInfo(row.storePathHash, 0, origin);
			} catch {
				// the durable queue row remains for GC to retry
			}
		});
	}

	private async purgeCachedNarInfo(url: string): Promise<void> {
		// Best-effort and colo-local: recovery correctness rests on the R2 delete
		// and row cleanup, so a failed edge purge must not abort them. Other colos
		// serve the stale narinfo until its TTL expires.
		try {
			await caches.default.delete(url);
		} catch {
			/* edge purge is best-effort */
		}
	}

	private deleteStorePath(
		storePathHash: string,
		origin: string
	): Promise<DeletePathResponse> {
		// One critical section so the row transaction and the opportunistic object
		// cleanup cannot interleave with a heal that would re-materialise the
		// object.
		return this.ctx.blockConcurrencyWhile(async () => {
			const row = this.db
				.select()
				.from(schema.narInfos)
				.where(eq(schema.narInfos.storePathHash, storePathHash))
				.get();

			if (row === undefined) {
				return {
					storePathHash,
					deleted: false,
					narScheduledForDeletion: false
				};
			}

			// Row-first: once this transaction commits the path is logically gone.
			// The narinfo object cleanup, and with it the NAR scheduling, runs
			// afterwards and is best-effort; the grace clock for the NAR only starts
			// once the object is actually removed.
			const now = new Date().toISOString();

			this.db.transaction((tx) => {
				tx.delete(schema.narInfos)
					.where(eq(schema.narInfos.storePathHash, storePathHash))
					.run();
				this.enqueueNarInfoDeletion(tx, storePathHash, row.narHash, now);
			});

			let narScheduledForDeletion = false;

			try {
				({ narScheduledForDeletion } = await this.deleteQueuedNarInfo(
					storePathHash,
					0,
					origin
				));
			} catch {
				// the durable queue row remains for GC to retry
			}

			return { storePathHash, deleted: true, narScheduledForDeletion };
		});
	}

	private clearNarBlob(narHash: string): void {
		this.db
			.delete(schema.narBlobs)
			.where(eq(schema.narBlobs.narHash, narHash))
			.run();
	}

	private clearQueuedBlobDeletion(r2Key: string): void {
		this.db
			.delete(schema.orphanBlobDeletions)
			.where(eq(schema.orphanBlobDeletions.r2Key, r2Key))
			.run();
	}

	private async signingKey(): Promise<SigningKey> {
		const existing = this.db
			.select()
			.from(schema.signingKeys)
			.where(eq(schema.signingKeys.id, 'active'))
			.get();

		if (existing !== undefined) {
			return {
				privateJwk: JSON.parse(existing.privateJwkJson) as JsonWebKey,
				publicKey: existing.publicKey
			};
		}

		const generated = await generateSigningKey();

		this.db
			.insert(schema.signingKeys)
			.values({
				id: 'active',
				privateJwkJson: JSON.stringify(generated.privateJwk),
				publicKey: generated.publicKey,
				createdAt: new Date().toISOString()
			})
			.run();

		return generated;
	}

	private async isBootstrapAuthorised(request: Request): Promise<boolean> {
		if (this.env.CUPBOARD_BOOTSTRAP_TOKEN === '') {
			return false;
		}

		const token = bearerToken(request);

		if (token === undefined) {
			return false;
		}

		return constantTimeEqual(
			await sha256Hex(token),
			await sha256Hex(this.env.CUPBOARD_BOOTSTRAP_TOKEN)
		);
	}

	private async isTokenAuthorised(request: Request): Promise<boolean> {
		const token = bearerToken(request);

		if (token === undefined) {
			return false;
		}

		const hash = await sha256Hex(token);
		const matching = this.db
			.select()
			.from(schema.tokens)
			.where(eq(schema.tokens.hash, hash))
			.get();

		return matching?.scope === 'admin';
	}

	private async presignedPutUrl(
		key: string,
		fileHash: string,
		expiresAt: Date
	): Promise<string> {
		return this.r2Presigner().presignPutUrl({
			key,
			checksumSha256: NixSha256Hash.parse(fileHash).digestBase64(),
			expiresSeconds: Math.max(
				1,
				Math.floor((expiresAt.getTime() - Date.now()) / 1000)
			)
		});
	}

	private r2Presigner(): R2Presigner {
		this.presigner ??= new R2Presigner(r2PresignConfiguration(this.env));

		return this.presigner;
	}

	private initialise(): Promise<void> {
		this.migrationPromise ??= migrate(this.db, migrations);

		return this.migrationPromise;
	}
}

function bearerToken(request: Request): string | undefined {
	const header = request.headers.get('authorization');

	if (header?.startsWith('Bearer ') !== true) {
		return undefined;
	}

	return header.slice('Bearer '.length);
}

interface R2PresignConfiguration {
	readonly accountId: string;
	readonly accessKeyId: string;
	readonly bucketName: string;
	readonly secretAccessKey: string;
}

function r2PresignConfiguration(env: RuntimeEnv): R2PresignConfiguration {
	const missingBindings: R2PresignBindingName[] = [];

	if (env.R2_ACCOUNT_ID === '') {
		missingBindings.push('R2_ACCOUNT_ID');
	}

	if (env.R2_ACCESS_KEY_ID === '') {
		missingBindings.push('R2_ACCESS_KEY_ID');
	}

	if (env.R2_BUCKET_NAME === '') {
		missingBindings.push('R2_BUCKET_NAME');
	}

	if (env.R2_SECRET_ACCESS_KEY === '') {
		missingBindings.push('R2_SECRET_ACCESS_KEY');
	}

	if (missingBindings.length > 0) {
		throw new R2PresignConfigurationMissingError(missingBindings);
	}

	return {
		accountId: env.R2_ACCOUNT_ID,
		accessKeyId: env.R2_ACCESS_KEY_ID,
		bucketName: env.R2_BUCKET_NAME,
		secretAccessKey: env.R2_SECRET_ACCESS_KEY
	};
}

async function serverErrorResponse(
	response: Promise<Response>
): Promise<Response> {
	try {
		return await response;
	} catch (error) {
		if (error instanceof ServerHttpError) {
			return new Response(`${error.message}\n`, {
				status: error.status
			});
		}

		throw error;
	}
}

async function parseJsonRequest<T>(request: Request): Promise<T> {
	try {
		return await request.json<T>();
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new InvalidJsonRequestBodyError(error);
		}

		throw error;
	}
}

function parseUploadMetadata(
	fields: UploadNegotiateRequest['paths'][number]
): UploadPathMetadata {
	try {
		return UploadPathMetadata.fromFields(fields);
	} catch (error) {
		if (error instanceof ProtocolError) {
			throw new InvalidUploadMetadataRequestError(error);
		}

		throw error;
	}
}

function parseDeletePathRequest(
	fields: DeletePathRequestFields
): DeletePathRequest {
	try {
		return DeletePathRequest.fromFields(fields);
	} catch (error) {
		if (error instanceof ProtocolError) {
			throw new InvalidDeletePathRequestError(error);
		}

		throw error;
	}
}

function parseRootSetRequest(fields: RootSetRequestFields): RootSetRequest {
	try {
		return RootSetRequest.fromFields(fields);
	} catch (error) {
		if (error instanceof ProtocolError) {
			throw new InvalidRootRequestError(error);
		}

		throw error;
	}
}

function parseRootRemoveRequest(
	fields: RootRemoveRequestFields
): RootRemoveRequest {
	try {
		return RootRemoveRequest.fromFields(fields);
	} catch (error) {
		if (error instanceof ProtocolError) {
			throw new InvalidRootRequestError(error);
		}

		throw error;
	}
}

function parseUploadBlobMetadata(
	fields: UploadPrepareRequest
): UploadBlobMetadata {
	try {
		return UploadBlobMetadata.fromFields(fields);
	} catch (error) {
		if (error instanceof ProtocolError) {
			throw new InvalidUploadMetadataRequestError(error);
		}

		throw error;
	}
}

function parseStoredUploadMetadata(
	uploadId: string,
	source: string
): UploadPathCommitMetadata {
	try {
		return UploadPathCommitMetadata.fromFields(
			JSON.parse(source) as UploadPathMetadataFields
		);
	} catch (error) {
		if (error instanceof ProtocolError) {
			throw new UploadNotPreparedError(uploadId);
		}

		if (error instanceof Error) {
			throw new StoredUploadMetadataInvalidError(uploadId, error);
		}

		throw error;
	}
}

function parseStoredUploadPathMetadata(
	uploadId: string,
	source: string
): UploadPathMetadata {
	try {
		return UploadPathMetadata.fromFields(
			JSON.parse(source) as UploadNegotiateRequest['paths'][number]
		);
	} catch (error) {
		if (error instanceof Error) {
			throw new StoredUploadMetadataInvalidError(uploadId, error);
		}

		throw error;
	}
}

function uploadHeadersFor(
	metadata: UploadPathCommitMetadata
): Readonly<Record<string, string>> {
	return {
		'x-amz-checksum-sha256': NixSha256Hash.parse(
			metadata.fileHash
		).digestBase64()
	};
}

function verifyObjectChecksum(
	metadata: UploadPathCommitMetadata,
	object: R2Object
): void {
	const checksum = object.checksums.sha256;

	if (checksum === undefined) {
		throw new UploadedObjectChecksumMissingError(metadata.r2Key);
	}

	const actual = NixSha256Hash.fromDigest(new Uint8Array(checksum)).toString();

	if (actual === metadata.fileHash) {
		return;
	}

	throw new UploadedObjectChecksumMismatchError(
		metadata.r2Key,
		metadata.fileHash,
		actual
	);
}
