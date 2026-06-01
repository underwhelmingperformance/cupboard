import {
	type BootstrapResponse,
	type CommitResponse,
	type DeletePathResponse,
	type KeyListResponse,
	type KeyRetireResponse,
	type KeyRotateResponse,
	NarInfo,
	NixSha256Hash,
	referencesSchema,
	type ResolvedRootTarget,
	resolveRootTargets,
	type RootListResponse,
	rootNameSchema,
	type RootRemoveResponse,
	rootSetBodySchema,
	type RootSetResponse,
	type RootSummary,
	type RootTarget,
	signingKeyIdSchema,
	type SigningKeyStage,
	type SigningKeySummary,
	type StatsResponse,
	storePathHashSchema,
	type UploadBlobMetadataFields,
	type UploadDecision,
	uploadNegotiateRequestSchema,
	type UploadNegotiateResponse,
	type UploadPathMetadataFields,
	uploadPathMetadataSchema,
	type UploadPathNegotiationFields,
	uploadPathNegotiationSchema,
	uploadPrepareRequestSchema,
	type UploadPrepareResponse
} from '@cupboard/shared';
import { DurableObject } from 'cloudflare:workers';
import { and, count, eq, gte, lt, lte, sql } from 'drizzle-orm';
import {
	drizzle,
	type DrizzleSqliteDODatabase
} from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { Hono } from 'hono';
import { z } from 'zod';

import migrations from '../drizzle/migrations.js';

import {
	type AccessClaims,
	type AccessScope,
	generateAuthKeyPair,
	mintAccessJwt,
	verifyAccessJwt
} from './auth.ts';
import {
	constantTimeEqual,
	generateSigningKey,
	sha256Hex,
	signNixFingerprint
} from './crypto.ts';
import * as schema from './db/schema.ts';
import {
	InsufficientScopeError,
	LastSigningKeyError,
	type R2PresignBindingName,
	R2PresignConfigurationMissingError,
	ServerHttpError,
	StoredReferencesInvalidError,
	StoredSignaturesInvalidError,
	StoredUploadMetadataInvalidError,
	UnauthenticatedError,
	UploadExpiredError,
	UploadNotFoundError,
	UploadNotPreparedError
} from './errors.ts';
import {
	internalOrigin,
	narInfoCacheControl,
	narInfoObjectKey,
	narObjectKey,
	orphanBlobDeletionGraceMs,
	TextBody,
	textResponse
} from './http.ts';
import {
	parseRequestBody,
	parseRequestValue,
	parseStored,
	parseStoredJson
} from './parse.ts';
import { R2Presigner } from './presign.ts';
import { verifyUploadedObject } from './upload-verification.ts';

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

const adminJwtTtlSeconds = 10 * 60;

const storedSignaturesSchema = z.array(z.string());

interface SigningKey {
	readonly id: string;
	readonly name: string;
	readonly privateJwk: JsonWebKey;
	readonly publicKey: string;
	readonly signing: boolean;
	readonly published: boolean;
	readonly createdAt: string;
}

const bootstrapKeyName = 'cupboard-1';

interface AuthKeyPair {
	readonly privateJwk: JsonWebKey;
	readonly publicJwk: JsonWebKey;
}

interface RootSetCommand {
	readonly name: string;
	readonly targets: readonly ResolvedRootTarget[];
	readonly ttlSeconds: number | undefined;
}

export class CupboardServer extends DurableObject<RuntimeEnv> {
	private readonly app = new Hono<{ Bindings: RuntimeEnv }>();
	private readonly db: DrizzleSqliteDODatabase<typeof schema>;
	private migrationPromise: Promise<void> | undefined;
	private keysPromise: Promise<readonly SigningKey[]> | undefined;
	private authKeyPromise: Promise<AuthKeyPair> | undefined;
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
			this.publicKeyBody ??= new TextBody(
				`${await this.publishedKeysText()}\n`
			);

			return textResponse(context.req.raw, this.publicKeyBody, {
				'content-type': 'text/plain; charset=utf-8'
			});
		});

		this.app.post('/auth/bootstrap', (context) =>
			serverErrorResponse(this.handleBootstrap(context.req.raw))
		);
		this.app.get('/stats', (context) =>
			serverErrorResponse(this.handleStats(context.req.raw))
		);
		this.app.get('/keys', (context) =>
			serverErrorResponse(this.handleKeyList(context.req.raw))
		);
		this.app.post('/keys/rotate', (context) =>
			serverErrorResponse(this.handleKeyRotate(context.req.raw))
		);
		this.app.post('/keys/retire/:id', (context) =>
			serverErrorResponse(
				this.handleKeyRetire(context.req.raw, context.req.param('id'))
			)
		);
		this.app.delete('/paths/:hash', (context) =>
			serverErrorResponse(
				this.handleDeletePath(context.req.raw, context.req.param('hash'))
			)
		);
		this.app.get('/roots', (context) =>
			serverErrorResponse(this.handleListRoots(context.req.raw))
		);
		this.app.put('/roots/:name', (context) =>
			serverErrorResponse(
				this.handleSetRoot(context.req.raw, context.req.param('name'))
			)
		);
		this.app.delete('/roots/:name', (context) =>
			serverErrorResponse(
				this.handleRemoveRoot(context.req.raw, context.req.param('name'))
			)
		);
		this.app.post('/uploads', (context) =>
			serverErrorResponse(this.handleNegotiate(context.req.raw))
		);
		this.app.put('/uploads/:id', (context) =>
			serverErrorResponse(
				this.handlePrepareUpload(context.req.raw, context.req.param('id'))
			)
		);
		this.app.post('/uploads/:id/commit', (context) =>
			serverErrorResponse(
				this.handleCommit(context.req.raw, context.req.param('id'))
			)
		);
		this.app.post('/gc', (context) =>
			serverErrorResponse(this.handleGarbageCollection(context.req.raw))
		);
	}

	private async handleBootstrap(request: Request): Promise<Response> {
		if (!(await this.isBootstrapAuthorised(request))) {
			throw new UnauthenticatedError();
		}

		// Ensure both keys exist (narinfo signing + JWT signing), then mint a
		// short-lived admin access token.
		const publicKey = await this.publishedKeysText();
		const token = await this.mintAdminJwt();

		return Response.json({
			url: new URL(request.url).origin,
			publicKey,
			token
		} satisfies BootstrapResponse);
	}

	private async handleStats(request: Request): Promise<Response> {
		await this.requireScope(request, 'admin');

		return Response.json(this.stats() satisfies StatsResponse);
	}

	private async handleKeyList(request: Request): Promise<Response> {
		await this.requireScope(request, 'admin');

		return Response.json((await this.keyList()) satisfies KeyListResponse);
	}

	private async handleKeyRotate(request: Request): Promise<Response> {
		await this.requireScope(request, 'admin');

		return Response.json((await this.rotateKey()) satisfies KeyRotateResponse);
	}

	private async handleKeyRetire(
		request: Request,
		id: string
	): Promise<Response> {
		await this.requireScope(request, 'admin');

		const keyId = parseRequestValue(signingKeyIdSchema, id);

		return Response.json(
			(await this.retireKey(keyId)) satisfies KeyRetireResponse
		);
	}

	private async handleDeletePath(
		request: Request,
		hash: string
	): Promise<Response> {
		await this.requireScope(request, 'admin');

		const storePathHash = parseRequestValue(storePathHashSchema, hash);
		const result = await this.deleteStorePath(
			storePathHash,
			new URL(request.url).origin
		);

		return Response.json(result satisfies DeletePathResponse);
	}

	private async handleSetRoot(
		request: Request,
		name: string
	): Promise<Response> {
		await this.requireScope(request, 'write');

		const body = await parseRequestBody(rootSetBodySchema, request);
		const requested: RootSetCommand = {
			name: parseRequestValue(rootNameSchema, name),
			targets: resolveRootTargets(body.targets),
			ttlSeconds: body.ttlSeconds
		};

		return Response.json(this.setRoot(requested) satisfies RootSetResponse);
	}

	private async handleListRoots(request: Request): Promise<Response> {
		await this.requireScope(request, 'admin');

		return Response.json(this.listRoots() satisfies RootListResponse);
	}

	private async handleRemoveRoot(
		request: Request,
		name: string
	): Promise<Response> {
		await this.requireScope(request, 'admin');

		const rootName = parseRequestValue(rootNameSchema, name);

		return Response.json(
			this.removeRoot(rootName) satisfies RootRemoveResponse
		);
	}

	private setRoot(request: RootSetCommand): RootSetResponse {
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
		await this.requireScope(request, 'write');

		const body = await parseRequestBody(uploadNegotiateRequestSchema, request);
		const uploads: UploadDecision[] = [];

		for (const metadata of body.paths) {
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

			await this.flushQueuedBlobDeletion(narObjectKey(metadata.narHash));

			const existingBlob = await this.findReusableBlob(metadata.narHash);
			const uploadId = crypto.randomUUID();
			const now = new Date();
			const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);
			const pendingMetadata:
				| UploadPathNegotiationFields
				| UploadPathMetadataFields =
				existingBlob === undefined
					? metadata
					: commitMetadataFromPathAndBlob(metadata, existingBlob);

			this.db
				.insert(schema.pendingUploads)
				.values({
					id: uploadId,
					narHash: metadata.narHash,
					r2Key: narObjectKey(metadata.narHash),
					expectedSize:
						'fileHash' in pendingMetadata ? pendingMetadata.fileSize : 0,
					metadataJson: JSON.stringify(pendingMetadata),
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
				r2Key: narObjectKey(metadata.narHash),
				expiresAt: expiresAt.toISOString()
			});
		}

		return Response.json({ uploads } satisfies UploadNegotiateResponse);
	}

	private async handlePrepareUpload(
		request: Request,
		uploadId: string
	): Promise<Response> {
		await this.requireScope(request, 'write');

		const pending = this.db
			.select()
			.from(schema.pendingUploads)
			.where(eq(schema.pendingUploads.id, uploadId))
			.get();

		if (pending === undefined) {
			throw new UploadNotFoundError(uploadId);
		}

		if (pending.expiresAt < new Date().toISOString()) {
			this.clearPendingUpload(uploadId);

			throw new UploadExpiredError(uploadId);
		}

		const pathMetadata = parseStoredUploadPathMetadata(
			uploadId,
			pending.metadataJson
		);
		const blobMetadata = await parseRequestBody(
			uploadPrepareRequestSchema,
			request
		);
		const metadata = commitMetadataFromPathAndBlob(pathMetadata, blobMetadata);
		const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

		this.db
			.update(schema.pendingUploads)
			.set({
				expectedSize: metadata.fileSize,
				metadataJson: JSON.stringify(metadata),
				expiresAt: expiresAt.toISOString()
			})
			.where(eq(schema.pendingUploads.id, uploadId))
			.run();

		return Response.json({
			uploadUrl: await this.presignedPutUrl(
				narObjectKey(metadata.narHash),
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

		// The object is missing. Only drop the accounting row when nothing
		// committed still references this NAR, so a transient head miss cannot
		// undercount a blob that live narinfos depend on.
		if (this.narHashUnreferenced(existingBlob.narHash)) {
			this.clearNarBlob(existingBlob.narHash);
		}

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
		await this.requireScope(request, 'write');

		const pending = this.db
			.select()
			.from(schema.pendingUploads)
			.where(eq(schema.pendingUploads.id, uploadId))
			.get();

		if (pending === undefined) {
			throw new UploadNotFoundError(uploadId);
		}

		if (pending.expiresAt < new Date().toISOString()) {
			this.clearPendingUpload(uploadId);

			throw new UploadExpiredError(uploadId);
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

		const object = (await this.env.BLOBS.head(pending.r2Key)) ?? undefined;

		verifyUploadedObject(object, pending.expectedSize, metadata);

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
			parseStored(
				referencesSchema,
				row.referencesJson,
				(cause) => new StoredReferencesInvalidError(row.storePathHash, cause)
			),
			row.deriver ?? undefined,
			row.ca ?? undefined,
			parseStored(
				storedSignaturesSchema,
				row.sigsJson,
				(cause) => new StoredSignaturesInvalidError(row.storePathHash, cause)
			)
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

	private collectUnreachable(now: string): {
		rootsExpired: number;
		pathsSwept: number;
	} {
		// Expire TTL'd roots first, regardless of whether a sweep follows, so an
		// expiring channel always lapses. A NULL expiry (permanent) never matches.
		const expiredRoots = this.db
			.select({ name: schema.retentionRoots.name })
			.from(schema.retentionRoots)
			.where(lte(schema.retentionRoots.expiresAt, now))
			.all();

		this.db.transaction((tx) => {
			for (const root of expiredRoots) {
				tx.delete(schema.retentionRootTargets)
					.where(eq(schema.retentionRootTargets.rootName, root.name))
					.run();
			}

			tx.delete(schema.retentionRoots)
				.where(lte(schema.retentionRoots.expiresAt, now))
				.run();
		});

		// Mark the closure reachable from the live roots. `visited` guards the
		// traversal; `retainedCommitted` is the keep-set of committed paths that
		// the sweep spares.
		const visited = new Set<string>();
		const retainedCommitted = new Set<string>();
		const queue: string[] = [];

		for (const target of this.db
			.select({ storePathHash: schema.retentionRootTargets.storePathHash })
			.from(schema.retentionRootTargets)
			.all()) {
			if (!visited.has(target.storePathHash)) {
				visited.add(target.storePathHash);
				queue.push(target.storePathHash);
			}
		}

		while (queue.length > 0) {
			const storePathHash = queue.pop();

			if (storePathHash === undefined) {
				break;
			}

			const row = this.db
				.select({ referencesJson: schema.narInfos.referencesJson })
				.from(schema.narInfos)
				.where(eq(schema.narInfos.storePathHash, storePathHash))
				.get();

			if (row === undefined) {
				continue;
			}

			retainedCommitted.add(storePathHash);

			const references = parseStored(
				referencesSchema,
				row.referencesJson,
				(cause) => new StoredReferencesInvalidError(storePathHash, cause)
			);

			for (const reference of references) {
				const separator = reference.indexOf('-');

				if (separator <= 0) {
					continue;
				}

				const referenceHash = reference.slice(0, separator);

				if (!visited.has(referenceHash)) {
					visited.add(referenceHash);
					queue.push(referenceHash);
				}
			}
		}

			// Guard: nothing committed is reachable and no root expired (no roots, or
			// roots that only point at absent paths), so collecting would empty the cache
			// without a retention event. Skip it.
			if (retainedCommitted.size === 0 && expiredRoots.length === 0) {
				return { rootsExpired: expiredRoots.length, pathsSwept: 0 };
			}

		const committed = this.db
			.select({
				storePathHash: schema.narInfos.storePathHash,
				narHash: schema.narInfos.narHash
			})
			.from(schema.narInfos)
			.all();
		let pathsSwept = 0;

		for (const path of committed) {
			if (retainedCommitted.has(path.storePathHash)) {
				continue;
			}

			this.db.transaction((tx) => {
				tx.delete(schema.narInfos)
					.where(eq(schema.narInfos.storePathHash, path.storePathHash))
					.run();
				this.enqueueNarInfoDeletion(tx, path.storePathHash, path.narHash, now);
			});
			pathsSwept += 1;
		}

		return { rootsExpired: expiredRoots.length, pathsSwept };
	}

	private async handleGarbageCollection(request: Request): Promise<Response> {
		await this.requireScope(request, 'admin');

		const now = new Date().toISOString();
		// Interactive GC purges this colo's edge cache via the caller's public
		// origin. The cron sweep arrives on the internal origin and cannot know
		// the public URL, so it skips purging and relies on the narinfo TTL and
		// the orphan-blob grace window instead.
		const requestOrigin = new URL(request.url).origin;
		const purgeOrigin =
			requestOrigin === internalOrigin ? undefined : requestOrigin;
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

			const { rootsExpired, pathsSwept } = this.collectUnreachable(now);

			return {
				pendingUploadsDeleted: expiredUploads.length,
				rootsExpired,
				pathsSwept,
				narInfosDeleted: await this.flushQueuedNarInfoDeletions(purgeOrigin),
				blobsDeleted: await this.flushQueuedBlobDeletions(now)
			};
		});

		return Response.json({
			ok: true,
			...result
		});
	}

	private async commitMetadata(
		metadata: UploadPathMetadataFields
	): Promise<boolean> {
		const now = new Date().toISOString();
		const signingKeys = await this.signingKeys();
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
		const fingerprint = unsigned.fingerprint();
		const sigs = await Promise.all(
			signingKeys.map((key) =>
				signNixFingerprint(key.privateJwk, fingerprint, key.name)
			)
		);
		const narBlobRow = {
			narHash: metadata.narHash,
			r2Key: narObjectKey(metadata.narHash),
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
					sigsJson: JSON.stringify(sigs),
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

		let signed = unsigned;

		for (const sig of sigs) {
			signed = signed.withSignature(sig);
		}

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

	private loadedKeys(): Promise<readonly SigningKey[]> {
		// A shared in-flight promise so concurrent first requests against an
		// empty DO generate and insert the bootstrap key exactly once. A failed
		// attempt clears the cache so a later request can create it.
		this.keysPromise ??= this.loadOrCreateKeys().catch((error: unknown) => {
			this.keysPromise = undefined;
			throw error;
		});

		return this.keysPromise;
	}

	private async loadOrCreateKeys(): Promise<readonly SigningKey[]> {
		const rows = this.db.select().from(schema.signingKeys).all();

		if (rows.length > 0) {
			return rows.map((row) => signingKeyFromRow(row)).toSorted(byPublicKey);
		}

		const generated = await generateSigningKey(bootstrapKeyName);
		const createdAt = new Date().toISOString();

		this.db
			.insert(schema.signingKeys)
			.values({
				id: 'active',
				privateJwkJson: JSON.stringify(generated.privateJwk),
				publicKey: generated.publicKey,
				signing: true,
				published: true,
				createdAt
			})
			.run();

		return [
			{
				id: 'active',
				name: bootstrapKeyName,
				privateJwk: generated.privateJwk,
				publicKey: generated.publicKey,
				signing: true,
				published: true,
				createdAt
			}
		];
	}

	private resetKeyCaches(): void {
		this.keysPromise = undefined;
		this.publicKeyBody = undefined;
	}

	private rotateKey(): Promise<KeyRotateResponse> {
		// One critical section: the read of the existing names, the insert, and
		// the cache reset must not interleave with a concurrent rotation or a
		// commit reading the key set.
		return this.ctx.blockConcurrencyWhile(async () => {
			const existing = await this.loadedKeys();
			const generated = await generateSigningKey(nextKeyName(existing));
			const id = crypto.randomUUID();

			this.db
				.insert(schema.signingKeys)
				.values({
					id,
					privateJwkJson: JSON.stringify(generated.privateJwk),
					publicKey: generated.publicKey,
					signing: true,
					published: true,
					createdAt: new Date().toISOString()
				})
				.run();

			this.resetKeyCaches();

			const keys = await this.loadedKeys();
			const rotated = keys.find((key) => key.id === id);

			if (rotated === undefined) {
				throw new Error('rotated key vanished immediately after insert');
			}

			return {
				rotated: keySummary(rotated),
				keys: keys.map((key) => keySummary(key))
			};
		});
	}

	private async retireKey(id: string): Promise<KeyRetireResponse> {
		// The last-signing-key check and the demotion share one critical section
		// so two concurrent retirements cannot both see themselves as safe. A
		// refused retirement is reported as an outcome and thrown afterwards:
		// throwing inside blockConcurrencyWhile would break the input gate.
		const outcome = await this.ctx.blockConcurrencyWhile(
			async (): Promise<{ stage: SigningKeyStage } | { refused: true }> => {
				const keys = await this.loadedKeys();
				const key = keys.find((candidate) => candidate.id === id);

				if (key === undefined) {
					return { stage: 'absent' };
				}

				if (key.signing) {
					const signingCount = keys.filter(
						(candidate) => candidate.signing
					).length;

					if (signingCount <= 1) {
						return { refused: true };
					}

					this.db
						.update(schema.signingKeys)
						.set({ signing: false })
						.where(eq(schema.signingKeys.id, id))
						.run();
					this.resetKeyCaches();

					return { stage: 'publication' };
				}

				this.db
					.delete(schema.signingKeys)
					.where(eq(schema.signingKeys.id, id))
					.run();
				this.resetKeyCaches();

				return { stage: 'absent' };
			}
		);

		if ('refused' in outcome) {
			throw new LastSigningKeyError(id);
		}

		return { id, stage: outcome.stage };
	}

	private async keyList(): Promise<KeyListResponse> {
		const keys = await this.loadedKeys();

		return { keys: keys.map((key) => keySummary(key)) };
	}

	private async signingKeys(): Promise<readonly SigningKey[]> {
		const keys = await this.loadedKeys();

		return keys.filter((key) => key.signing);
	}

	private async publishedKeys(): Promise<readonly SigningKey[]> {
		const keys = await this.loadedKeys();

		return keys.filter((key) => key.published);
	}

	private async publishedKeysText(): Promise<string> {
		const keys = await this.publishedKeys();

		return keys.map((key) => key.publicKey).join('\n');
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

	private authIssuer(): string {
		return this.env.CUPBOARD_AUTH_ISSUER || 'cupboard';
	}

	private authAudience(): string {
		return this.env.CUPBOARD_AUTH_AUDIENCE || 'cupboard';
	}

	private authKey(): Promise<AuthKeyPair> {
		// A shared in-flight promise so concurrent first requests against an
		// empty DO generate and insert the key exactly once. A failed attempt
		// clears the cache so a later request can create the key.
		this.authKeyPromise ??= this.loadOrCreateAuthKey().catch(
			(error: unknown) => {
				this.authKeyPromise = undefined;
				throw error;
			}
		);

		return this.authKeyPromise;
	}

	private async loadOrCreateAuthKey(): Promise<AuthKeyPair> {
		const existing = this.db
			.select()
			.from(schema.authKeys)
			.where(eq(schema.authKeys.id, 'active'))
			.get();

		if (existing !== undefined) {
			return {
				privateJwk: JSON.parse(existing.privateJwkJson) as JsonWebKey,
				publicJwk: JSON.parse(existing.publicJwkJson) as JsonWebKey
			};
		}

		const generated = await generateAuthKeyPair();

		this.db
			.insert(schema.authKeys)
			.values({
				id: 'active',
				privateJwkJson: JSON.stringify(generated.privateJwk),
				publicJwkJson: JSON.stringify(generated.publicJwk),
				createdAt: new Date().toISOString()
			})
			.run();

		return generated;
	}

	private async mintAdminJwt(): Promise<string> {
		const key = await this.authKey();

		return mintAccessJwt(
			key.privateJwk,
			{
				issuer: this.authIssuer(),
				audience: this.authAudience(),
				subject: 'bootstrap',
				scope: 'admin',
				ttlSeconds: adminJwtTtlSeconds
			},
			new Date()
		);
	}

	private async requireScope(
		request: Request,
		required: AccessScope
	): Promise<AccessClaims> {
		const token = bearerToken(request);

		if (token === undefined) {
			throw new UnauthenticatedError();
		}

		const key = await this.authKey();
		let claims: AccessClaims;

		try {
			claims = await verifyAccessJwt(
				key.publicJwk,
				token,
				{ issuer: this.authIssuer(), audience: this.authAudience() },
				new Date()
			);
		} catch {
			throw new UnauthenticatedError();
		}

		// admin satisfies any write-gated route; write satisfies only write.
		if (claims.scope !== 'admin' && claims.scope !== required) {
			throw new InsufficientScopeError();
		}

		return claims;
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

function signingKeyFromRow(
	row: typeof schema.signingKeys.$inferSelect
): SigningKey {
	return {
		id: row.id,
		name: row.publicKey.slice(0, row.publicKey.indexOf(':')),
		privateJwk: JSON.parse(row.privateJwkJson) as JsonWebKey,
		publicKey: row.publicKey,
		signing: row.signing,
		published: row.published,
		createdAt: row.createdAt
	};
}

// A stable order keeps the rendered `/pubkey` body and the narinfo `Sig:`
// lines deterministic, so a re-materialised narinfo hashes identically.
function byPublicKey(left: SigningKey, right: SigningKey): number {
	return left.publicKey > right.publicKey ? 1 : -1;
}

function keyStage(key: SigningKey): SigningKeyStage {
	if (key.signing) {
		return 'signing';
	}

	return key.published ? 'publication' : 'absent';
}

function keySummary(key: SigningKey): SigningKeySummary {
	return {
		id: key.id,
		publicKey: key.publicKey,
		stage: keyStage(key),
		createdAt: key.createdAt
	};
}

const keyNamePattern = /^cupboard-(\d+)$/;

// Each key needs a distinct Nix key name so old and new keys can coexist in a
// client's trusted set during a rotation. Names follow `cupboard-<n>`; the next
// rotation takes the highest existing index plus one.
function nextKeyName(keys: readonly SigningKey[]): string {
	const indices = keys.flatMap((key) => {
		const match = keyNamePattern.exec(key.name);

		return match === null ? [] : [Number.parseInt(match[1] ?? '0', 10)];
	});
	const next = indices.length === 0 ? 1 : Math.max(...indices) + 1;

	return `cupboard-${String(next)}`;
}

function commitMetadataFromPathAndBlob(
	path: UploadPathNegotiationFields,
	blob: UploadBlobMetadataFields
): UploadPathMetadataFields {
	return {
		...path,
		fileHash: blob.fileHash,
		fileSize: blob.fileSize,
		compression: blob.compression
	};
}

function parseStoredUploadMetadata(
	uploadId: string,
	source: string
): UploadPathMetadataFields {
	const onInvalid = (cause: Error): StoredUploadMetadataInvalidError =>
		new StoredUploadMetadataInvalidError(uploadId, cause);
	const json = parseStoredJson(source, onInvalid);
	const prepared = uploadPathMetadataSchema.safeParse(json);

	if (prepared.success) {
		return prepared.data;
	}

	// Negotiation stores the path metadata alone until the upload is prepared
	// with its blob details. A well-formed path-only record means the client
	// committed before preparing, not that the stored state is corrupt.
	if (uploadPathNegotiationSchema.safeParse(json).success) {
		throw new UploadNotPreparedError(uploadId);
	}

	throw onInvalid(prepared.error);
}

function parseStoredUploadPathMetadata(
	uploadId: string,
	source: string
): UploadPathNegotiationFields {
	return parseStored(
		uploadPathNegotiationSchema,
		source,
		(cause) => new StoredUploadMetadataInvalidError(uploadId, cause)
	);
}

function uploadHeadersFor(
	metadata: UploadPathMetadataFields
): Readonly<Record<string, string>> {
	return {
		'x-amz-checksum-sha256': NixSha256Hash.parse(
			metadata.fileHash
		).digestBase64()
	};
}
