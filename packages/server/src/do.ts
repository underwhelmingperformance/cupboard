import {
	CacheInfo,
	type CommitResponse,
	type InitResponse,
	NarInfo,
	NixSha256Hash,
	ProtocolError,
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

import { buildVersion } from './build-info.generated.ts';
import {
	constantTimeEqual,
	generateSigningKey,
	sha256Hex,
	sha256HexBytes,
	signNixFingerprint
} from './crypto.ts';
import * as schema from './db/schema.ts';
import {
	InvalidJsonRequestBodyError,
	InvalidUploadMetadataRequestError,
	type R2PresignBindingName,
	R2PresignConfigurationMissingError,
	ServerHttpError,
	StoredUploadMetadataInvalidError,
	UploadedObjectChecksumMismatchError,
	UploadedObjectChecksumMissingError,
	UploadNotPreparedError
} from './errors.ts';
import { isNotModified, narObjectKey } from './http.ts';
import { R2Presigner } from './presign.ts';

type WidenStringBindings<T> = {
	readonly [Key in keyof T]: T[Key] extends string ? string : T[Key];
};

type RuntimeEnv = WidenStringBindings<Env>;

interface SigningKey {
	readonly privateJwk: JsonWebKey;
	readonly publicKey: string;
}

const textHeaders = {
	'cache-control': 'public, max-age=3600',
	'x-content-type-options': 'nosniff'
};

export class CupboardServer extends DurableObject<RuntimeEnv> {
	private readonly app = new Hono<{ Bindings: RuntimeEnv }>();
	private readonly db: DrizzleSqliteDODatabase<typeof schema>;
	private readonly cacheInfoBody = new TextBody(CacheInfo.default.render());
	private readonly healthBody = new TextBody('ok\n');
	private readonly versionBody = new TextBody(`${buildVersion}\n`);
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
		this.app.on(['GET', 'HEAD'], '/nix-cache-info', (context) =>
			textResponse(context.req.raw, this.cacheInfoBody, {
				'content-type': 'text/x-nix-cache-info; charset=utf-8'
			})
		);

		this.app.on(['GET', 'HEAD'], '/pubkey', async (context) => {
			const key = await this.signingKey();

			this.publicKeyBody ??= new TextBody(`${key.publicKey}\n`);

			return textResponse(context.req.raw, this.publicKeyBody, {
				'content-type': 'text/plain; charset=utf-8'
			});
		});

		this.app.on(['GET', 'HEAD'], '/_health', (context) =>
			textResponse(context.req.raw, this.healthBody, {
				'content-type': 'text/plain; charset=utf-8',
				'cache-control': 'no-store'
			})
		);

		this.app.on(['GET', 'HEAD'], '/_version', (context) =>
			textResponse(context.req.raw, this.versionBody, {
				'content-type': 'text/plain; charset=utf-8',
				'cache-control': 'no-store'
			})
		);

		this.app.get('/_stats', async (context) => {
			if (!(await this.isTokenAuthorised(context.req.raw))) {
				return context.text('Unauthorised\n', StatusCodes.UNAUTHORIZED);
			}

			return context.json(this.stats());
		});

		this.app.on(['GET', 'HEAD'], '/:narInfoName', (context) => {
			const storePathHash = parseNarInfoName(context.req.param('narInfoName'));

			if (storePathHash === undefined) {
				return new Response('Not found\n', {
					status: StatusCodes.NOT_FOUND
				});
			}

			return this.narInfoResponse(context.req.raw, storePathHash);
		});

		this.app.post('/admin/init', (context) => this.handleInit(context.req.raw));
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
					uploads.push({
						action: 'skip',
						storePathHash: metadata.storePathHash,
						narHash: metadata.narHash
					});
					continue;
				}

				this.clearNarInfo(existingNarInfo.storePathHash);
				this.clearNarBlob(existingNarInfo.narHash);
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

		this.db
			.insert(schema.orphanBlobDeletions)
			.values({
				r2Key,
				createdAt: now
			})
			.onConflictDoNothing()
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

		if (this.hasCommittedBlob(r2Key) || this.hasLivePendingUpload(r2Key, now)) {
			this.clearQueuedBlobDeletion(r2Key);
			return false;
		}

		await this.env.BLOBS.delete(r2Key);
		this.clearQueuedBlobDeletion(r2Key);

		return true;
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
			this.clearPendingUpload(uploadId);

			return Response.json({
				storePathHash: metadata.storePathHash,
				narHash: metadata.narHash,
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

		await this.commitMetadata(metadata);
		this.clearPendingUpload(uploadId);

		return Response.json({
			storePathHash: metadata.storePathHash,
			narHash: metadata.narHash,
			status: 'committed'
		} satisfies CommitResponse);
	}

	private async narInfoResponse(
		request: Request,
		storePathHash: string
	): Promise<Response> {
		const row = this.db
			.select()
			.from(schema.narInfos)
			.where(eq(schema.narInfos.storePathHash, storePathHash))
			.get();

		if (row === undefined) {
			return new Response('Not found\n', { status: StatusCodes.NOT_FOUND });
		}

		const info = new NarInfo(
			row.storePath,
			`nar/${row.narHash}.nar.zst`,
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

		return textResponse(request, info.render(), {
			'content-type': 'text/x-nix-narinfo; charset=utf-8',
			'last-modified': new Date(row.createdAt).toUTCString()
		});
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
	): Promise<void> {
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
		const narInfoRow = {
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
		} satisfies typeof schema.narInfos.$inferInsert;
		const { storePathHash: _storePathHash, ...narInfoUpdate } = narInfoRow;

		this.db
			.insert(schema.narBlobs)
			.values(narBlobRow)
			.onConflictDoUpdate({
				target: schema.narBlobs.narHash,
				set: narBlobUpdate
			})
			.run();

		this.db
			.insert(schema.narInfos)
			.values(narInfoRow)
			.onConflictDoUpdate({
				target: schema.narInfos.storePathHash,
				set: narInfoUpdate
			})
			.run();
	}

	private clearPendingUpload(uploadId: string): void {
		this.db
			.delete(schema.pendingUploads)
			.where(eq(schema.pendingUploads.id, uploadId))
			.run();
	}

	private clearNarInfo(storePathHash: string): void {
		this.db
			.delete(schema.narInfos)
			.where(eq(schema.narInfos.storePathHash, storePathHash))
			.run();
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

function parseNarInfoName(name: string): string | undefined {
	const suffix = '.narinfo';

	if (!name.endsWith(suffix)) {
		return undefined;
	}

	const storePathHash = name.slice(0, -suffix.length);

	if (!/^[0-9a-df-np-sv-z]{32}$/.test(storePathHash)) {
		return undefined;
	}

	return storePathHash;
}

async function textResponse(
	request: Request,
	body: string | TextBody,
	headers: Record<string, string>
): Promise<Response> {
	const responseHeaders = new Headers({ ...textHeaders, ...headers });
	const metadata =
		typeof body === 'string'
			? await textBodyMetadata(body)
			: await body.metadata();
	const text = typeof body === 'string' ? body : body.value;
	responseHeaders.set('etag', metadata.etag);
	responseHeaders.set('content-length', metadata.contentLength);

	if (isNotModified(request, responseHeaders)) {
		return new Response(undefined, {
			status: StatusCodes.NOT_MODIFIED,
			headers: responseHeaders
		});
	}

	return new Response(request.method === 'HEAD' ? undefined : text, {
		headers: responseHeaders
	});
}

interface TextBodyMetadata {
	readonly etag: string;
	readonly contentLength: string;
}

async function textBodyMetadata(body: string): Promise<TextBodyMetadata> {
	const bytes = new TextEncoder().encode(body);

	return {
		etag: `"sha256:${await sha256HexBytes(bytes)}"`,
		contentLength: String(bytes.byteLength)
	};
}

class TextBody {
	private metadataPromise: Promise<TextBodyMetadata> | undefined;

	constructor(public readonly value: string) {}

	metadata(): Promise<TextBodyMetadata> {
		this.metadataPromise ??= textBodyMetadata(this.value);

		return this.metadataPromise;
	}
}
