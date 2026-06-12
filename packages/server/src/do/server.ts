import { CacheInfo } from '@cupboard/nix/cache-info';
import {
	cacheNameSchema,
	DEFAULT_CACHE,
	rootNameSchema,
	storePathHashSchema
} from '@cupboard/nix/scalars';
import { zstdDecompressionStream } from '@cupboard/nix/zstd';
import { attestationNegotiateRequestSchema } from '@cupboard/protocol/attestations';
import type { ParsedR2CredentialCheck } from '@cupboard/protocol/reports';
import { rootSetBodySchema } from '@cupboard/protocol/retention';
import {
	uploadNegotiateRequestSchema,
	uploadPrepareRequestSchema
} from '@cupboard/protocol/upload';
import { DurableObject } from 'cloudflare:workers';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { StatusCodes } from 'http-status-codes';

import migrations from '../../drizzle/migrations.js';
import type { AccessScope } from '../auth/auth.ts';
import * as schema from '../db/schema.ts';
import {
	CommitUpgradeRequiredError,
	R2PresignConfigurationMissingError,
	ServerHttpError,
	TenantNotConfiguredError,
	UnauthenticatedError,
	ZstdUnavailableError
} from '../errors.ts';
import { serverErrorHandler } from '../http/error-response.ts';
import {
	internalOrigin,
	textResponse,
	verificationBatchSize
} from '../http/http.ts';
import { parseRequestBody, parseRequestValue } from '../http/parse.ts';
import { OidcDiscoveryStore } from '../oidc/oidc.ts';
import { type TenantRpcServices } from '../orpc/context.ts';
import { tenantOrpcHandler } from '../orpc/handler.ts';

import {
	AttestationCasService,
	type AttestationReference,
	type AttestationReferenceOutcome,
	type MeasuredAttestationBundle
} from './attestation-cas-service.ts';
import { AttestationsService } from './attestations-service.ts';
import { AuthKeysService } from './auth-keys-service.ts';
import { type DemoteTarget } from './blob-reaper-service.ts';
import { CacheAdminService } from './cache-admin-service.ts';
import { CommitPipelineService } from './commit-pipeline-service.ts';
import { sendCommitFrame } from './commit-socket.ts';
import { type RuntimeEnv, ServerContext } from './context.ts';
import { DeletionQueueService } from './deletion-queue-service.ts';
import { GarbageCollectionService } from './garbage-collection-service.ts';
import type { TenantHonoEnv } from './hono-env.ts';
import { IntegrityCheckService } from './integrity-check-service.ts';
import { MaintenanceEligibilityService } from './maintenance-eligibility-service.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';
import { OffboardingService } from './offboarding-service.ts';
import { OidcTrustService } from './oidc-trust-service.ts';
import { RetentionService } from './retention-service.ts';
import { RootsService } from './roots-service.ts';
import { SigningKeysService } from './signing-keys-service.ts';
import { StatsService } from './stats-service.ts';
import {
	type TenantIdentity,
	TenantIdentityService
} from './tenant-identity-service.ts';
import { TokenExchangeService } from './token-exchange-service.ts';
import { UploadStateService } from './upload-state-service.ts';
import { UploadsService } from './uploads-service.ts';
import {
	verificationLimitSchema,
	VerificationService
} from './verification-service.ts';

export class CupboardServer extends DurableObject<RuntimeEnv> {
	private readonly app = new Hono<TenantHonoEnv>();
	readonly context: ServerContext;
	private migrationPromise: Promise<void> | undefined;

	private readonly authKeys: AuthKeysService;
	private readonly attestationCas: AttestationCasService;
	private readonly attestations: AttestationsService;
	private readonly narInfoObjects: NarInfoObjectsService;
	private readonly uploadState: UploadStateService;
	private readonly deletionQueue: DeletionQueueService;
	private readonly signingKeys: SigningKeysService;
	private readonly stats: StatsService;
	private readonly tenantIdentity: TenantIdentityService;
	private readonly oidcTrust: OidcTrustService;
	private readonly retention: RetentionService;
	private readonly integrityCheck: IntegrityCheckService;
	private readonly cacheAdmin: CacheAdminService;
	private readonly garbageCollection: GarbageCollectionService;
	private readonly tokenExchange: TokenExchangeService;
	private readonly uploads: UploadsService;
	private readonly commitPipeline: CommitPipelineService;
	private readonly verification: VerificationService;
	private readonly roots: RootsService;
	private readonly offboarding: OffboardingService;
	private readonly maintenanceEligibility: MaintenanceEligibilityService;

	constructor(ctx: DurableObjectState, env: RuntimeEnv) {
		super(ctx, env);
		this.context = new ServerContext(ctx, env);

		this.tenantIdentity = new TenantIdentityService(this.context);
		this.authKeys = new AuthKeysService(this.context, this.tenantIdentity);
		this.attestationCas = new AttestationCasService(this.context);
		this.narInfoObjects = new NarInfoObjectsService(this.context);
		this.attestations = new AttestationsService(
			this.context,
			this.attestationCas,
			this.narInfoObjects
		);
		this.uploadState = new UploadStateService(this.context);
		this.deletionQueue = new DeletionQueueService(
			this.context,
			this.attestationCas,
			this.attestations
		);
		this.signingKeys = new SigningKeysService(this.context);
		this.stats = new StatsService(this.context);
		this.oidcTrust = new OidcTrustService(this.context, this.tenantIdentity);
		this.retention = new RetentionService(this.context);
		this.integrityCheck = new IntegrityCheckService(this.context);
		this.cacheAdmin = new CacheAdminService(this.context, this.deletionQueue);
		this.garbageCollection = new GarbageCollectionService(
			this.context,
			this.deletionQueue
		);
		this.tokenExchange = new TokenExchangeService(
			this.context,
			this.authKeys,
			this.oidcTrust
		);
		this.uploads = new UploadsService(
			this.context,
			this.uploadState,
			this.narInfoObjects,
			this.deletionQueue
		);
		this.commitPipeline = new CommitPipelineService(
			this.context,
			this.cacheAdmin,
			this.signingKeys,
			this.uploadState,
			this.narInfoObjects
		);
		this.verification = new VerificationService(
			this.context,
			this.commitPipeline,
			this.deletionQueue,
			this.narInfoObjects,
			this.uploadState
		);
		this.roots = new RootsService(
			this.context,
			this.cacheAdmin,
			this.retention,
			this.narInfoObjects
		);
		this.offboarding = new OffboardingService(this.context);
		this.maintenanceEligibility = new MaintenanceEligibilityService(
			this.context
		);

		// Parked commit sockets answer keepalive pings without waking the
		// hibernated object.
		ctx.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair('ping', 'pong')
		);

		this.routes();
	}

	// Test seam: the inbound-OIDC discovery store lives on the context so a test
	// can substitute a fixture before exercising a token exchange.
	get discovery(): OidcDiscoveryStore {
		return this.context.discovery;
	}

	set discovery(discovery: OidcDiscoveryStore) {
		this.context.discovery = discovery;
	}

	// Test seam: re-seed the owner rule after mutating the context environment.
	seedOwnerRule(): void {
		this.oidcTrust.seedOwnerRule();
	}

	async fetch(request: Request): Promise<Response> {
		await this.initialise();

		return this.app.fetch(request, this.env);
	}

	// The cron drives maintenance through these RPC methods rather than the HTTP
	// admin routes: the service binding authorises the call, so no token is
	// minted or exchanged. The same cores back `/gc` and `/verify` for manual
	// use. Both sweep every cache and skip the edge-cache purge, exactly as an
	// internal-origin HTTP sweep did, relying on the narinfo TTL and the
	// orphan-blob grace window.
	async runGarbageCollection(): Promise<void> {
		await this.initialise();
		await this.withMaintenanceEligibility(() =>
			this.garbageCollection.collectGarbage()
		);
	}

	async runVerification(): Promise<void> {
		await this.initialise();
		await this.withMaintenanceEligibility(async () => {
			await this.verification.verifyPendingUploads(verificationBatchSize);
			await this.verification.verifyBatch(undefined, verificationBatchSize);
		});
	}

	async runAuthKeyRetirement(): Promise<void> {
		await this.initialise();
		await this.withMaintenanceEligibility(() =>
			this.authKeys.retireScheduledAuthKeys()
		);
	}

	// The global reaper found a shared object gone and routes the de-materialisation
	// of this tenant's narinfos for that hash through here, the single writer of the
	// tenant's objects. Each target is de-materialised only if its live row still
	// names the hash and the object is still absent, so the call is idempotent and the
	// reaper can re-drive it until the `blob_state` row is cleared.
	async demoteNarInfoObjects(
		narHash: string,
		targets: readonly DemoteTarget[]
	): Promise<void> {
		await this.initialise();

		for (const target of targets) {
			await this.narInfoObjects.demoteUnbacked(
				target.cache,
				target.storePathHash,
				narHash
			);
		}
	}

	async measureAttestationBundle(
		stagingKey: string
	): Promise<MeasuredAttestationBundle> {
		await this.initialise();
		return this.attestationCas.measureStagedBundle(stagingKey);
	}

	async promoteAttestationBundle(
		stagingKey: string,
		bundle: MeasuredAttestationBundle
	): Promise<void> {
		await this.initialise();
		return this.attestationCas.promoteMeasuredBundle(stagingKey, bundle);
	}

	async reserveAttestationReference(
		reference: AttestationReference,
		size: number
	): Promise<AttestationReferenceOutcome> {
		await this.initialise();
		return this.attestationCas.reserveReferenceAndCharge(reference, size);
	}

	async removeAttestationReference(
		reference: AttestationReference
	): Promise<void> {
		await this.initialise();
		return this.attestationCas.removeCapturedReference(reference);
	}

	async demoteAttestationReferences(digest: string): Promise<void> {
		await this.initialise();
		await this.attestations.removeReferencesForDigest(digest);
	}

	// The control plane begins offboarding this tenant. Marking it stops the
	// verify-restore path re-materialising an object the drain is about to remove, so
	// an in-flight commit settling on this instance cannot resurrect one.
	async beginOffboard(): Promise<void> {
		await this.initialise();
		this.offboarding.begin();
	}

	// One bounded drain pass: deletes a batch of this tenant's reference and presence
	// rows (the rows only this Durable Object may write) and reports whether any
	// remain, so the Worker drives the drain to completion over successive ticks. The
	// freed shared blobs are collected by the global reaper.
	async runOffboard(limit: number): Promise<{ drained: boolean }> {
		await this.initialise();

		return this.ctx.blockConcurrencyWhile(() => this.offboarding.drain(limit));
	}

	// Wipes this Durable Object's own storage once its tenant is drained: the signing
	// and auth keys, the identity, and the narinfo rows. After this the object is
	// unconfigured and serves nothing, so its tenant retains no secret or data.
	purgeStorage(): Promise<void> {
		return this.ctx.blockConcurrencyWhile(async () => {
			await this.ctx.storage.deleteAll();
			this.migrationPromise = undefined;
			this.authKeys.resetAuthKeyCache();
			this.signingKeys.resetKeyCaches();
		});
	}

	// Proves the R2 credentials this script is bound with: their values cannot
	// be read back, so the control plane asks the Durable Object (which holds
	// them) to sign a HEAD probe and see whether R2 accepts the signature. The
	// probe touches only the env, never this object's storage, so any instance
	// can answer it.
	async checkR2(): Promise<ParsedR2CredentialCheck> {
		let probeUrl: string;

		try {
			probeUrl = await this.context
				.r2Presigner()
				.presignHeadUrl('.cupboard-credential-probe', 60);
		} catch (error) {
			if (error instanceof R2PresignConfigurationMissingError) {
				return { result: 'unconfigured' };
			}

			throw error;
		}

		const response = await fetch(probeUrl, { method: 'HEAD' });

		// A missing probe object still answers 404 with a valid signature; only
		// a rejected signature speaks against the credentials.
		if (response.ok || response.status === 404) {
			return { result: 'ok' };
		}

		return { result: 'rejected', status: response.status };
	}

	// The control plane assigns this Durable Object its identity at provision time
	// and on config-version bumps. The compare-and-set on the config version makes a
	// stale or replayed dispatch a no-op, and the owner admin rule is re-seeded from
	// the newly applied identity. SQLite access in the Durable Object is synchronous
	// and the object is single-threaded, so the read-compare-write is atomic.
	async configure(identity: TenantIdentity): Promise<void> {
		await this.initialise();

		if (this.tenantIdentity.configure(identity)) {
			this.oidcTrust.seedOwnerRule();
		}

		await this.reconcileMaintenanceEligibility();
	}

	private routes(): void {
		this.app.onError(serverErrorHandler);

		// An unconfigured Durable Object has no identity to mint, verify or advertise
		// under, so it serves nothing rather than falling back to a default. This is
		// input-gated: the control plane's `configure` RPC, which assigns the
		// identity, is a method and so is not gated here.
		this.app.use(async (_context, next) => {
			if (this.tenantIdentity.current() === undefined) {
				throw new TenantNotConfiguredError();
			}

			await next();
		});

		// The contract procedures answer first: the oRPC handler serves every
		// JSON admin route declared in @cupboard/protocol/contract, and anything
		// it does not match falls through to the wire-format routes below.
		this.app.use(async (context, next) => {
			const { matched, response } = await tenantOrpcHandler.handle(
				context.req.raw,
				{
					context: { request: context.req.raw, services: this.rpcServices() }
				}
			);

			if (matched) {
				return response;
			}

			await next();
		});

		// Every request addresses a cache: the default one unless a
		// `/cache/:cacheName/` prefix names another, validated here so the routes
		// under the prefix always see a well-formed name.
		this.app.use(async (context, next) => {
			context.set('cache', DEFAULT_CACHE);
			await next();
		});
		this.app.use('/cache/:cacheName/*', async (context, next) => {
			context.set(
				'cache',
				parseRequestValue(cacheNameSchema, context.req.param('cacheName'))
			);
			await next();
		});

		this.app.get('/pubkey', async (context) =>
			// Served uncached so a rotation is visible across colos at once; the
			// strong ETag still lets Nix revalidate conditionally.
			textResponse(
				context.req.raw,
				await this.signingKeys.publishedKeysBody(),
				{
					'content-type': 'text/plain; charset=utf-8',
					'cache-control': 'no-cache'
				}
			)
		);

		// A named cache's nix-cache-info is rendered from its registry priority;
		// the Worker forwards it here (the default cache's is rendered at the edge).
		this.app.get('/cache/:cacheName/nix-cache-info', (context) =>
			textResponse(
				context.req.raw,
				this.cacheAdmin.cacheInfoBody(context.get('cache')),
				{
					'content-type': 'text/x-nix-cache-info; charset=utf-8'
				}
			)
		);

		// The OAuth 2.0 token-exchange endpoint and the auth key set that verifies
		// the tokens it mints. `/token` is unauthenticated: the subject token is
		// itself the credential. The Worker proxies `/.well-known/jwks.json` here.
		this.app.post('/token', (context) =>
			this.tokenExchange.handleToken(context.req.raw)
		);
		// Both key documents are served uncached so a rotation is visible across
		// colos at once.
		this.app.get('/.well-known/jwks.json', async (context) =>
			context.json({ keys: await this.authKeys.authPublicJwks() }, 200, {
				'cache-control': 'no-cache'
			})
		);
		this.app.get('/.well-known/oauth-authorization-server', (context) =>
			context.json(
				this.authKeys.authorizationServerMetadata(
					new URL(context.req.url).origin
				)
			)
		);

		// A read-only storage check across every cache. Blobs are shared, so it is
		// deployment-wide: one bare `/check` covering all caches.
		this.app.get('/check', this.scoped('admin'), async (context) =>
			context.json(
				await this.integrityCheck.check(context.req.query('deep') === 'true')
			)
		);

		// A bounded reconciling pass driven by the cron tick. Its own route, kept
		// separate from `/gc`, so each can run and be asserted independently.
		// Interactive runs purge this colo's edge cache via the caller's public
		// origin; the cron sweep arrives on the internal origin, cannot know the
		// public URL, and relies on the narinfo TTL and the orphan-blob grace
		// window instead.
		this.app.post(
			'/verify',
			this.scoped('admin'),
			this.maintenance(),
			async (context) => {
				const { origin } = new URL(context.req.url);
				const requested = context.req.query('limit');
				const limit =
					requested === undefined
						? verificationBatchSize
						: Math.min(
								parseRequestValue(verificationLimitSchema, requested),
								verificationBatchSize
							);

				return context.json(
					await this.verification.verify(
						origin === internalOrigin ? undefined : origin,
						limit
					)
				);
			}
		);

		// Each path-scoped route has a bare form (the default cache) and a
		// `/cache/:cacheName/` form. The per-route scope is identical between the
		// two; the cache-scoped form validates the name inside the error boundary.
		this.app.get('/stats', this.scoped('admin'), async (context) =>
			context.json(await this.stats.stats(context.get('cache')))
		);
		this.app.get('/usage', this.scoped('admin'), async (context) =>
			context.json(await this.stats.usage())
		);
		this.app.get(
			'/cache/:cacheName/stats',
			this.scoped('admin'),
			async (context) =>
				context.json(await this.stats.stats(context.get('cache')))
		);
		this.app.on(
			'DELETE',
			['/paths/:hash', '/cache/:cacheName/paths/:hash'],
			this.scoped('admin'),
			this.maintenance(),
			async (context) =>
				context.json(
					await this.deletionQueue.deleteStorePath(
						context.get('cache'),
						parseRequestValue(storePathHashSchema, context.req.param('hash')),
						new URL(context.req.url).origin
					)
				)
		);
		this.app.on(
			'GET',
			['/roots', '/cache/:cacheName/roots'],
			this.scoped('admin'),
			async (context) =>
				context.json(await this.roots.listRoots(context.get('cache')))
		);
		// Setting a root is the one route whose handler consumes the verified
		// claims: a write token may only set the roots its grant permits.
		this.app.on(
			'PUT',
			['/roots/:name', '/cache/:cacheName/roots/:name'],
			this.scoped('write'),
			this.maintenance(),
			async (context) => {
				const claims = context.get('claims');

				if (claims === undefined) {
					throw new UnauthenticatedError();
				}

				return context.json(
					await this.roots.setRoot(
						claims,
						context.get('cache'),
						parseRequestValue(rootNameSchema, context.req.param('name')),
						await parseRequestBody(rootSetBodySchema, context.req.raw)
					)
				);
			}
		);
		this.app.on(
			'DELETE',
			['/roots/:name', '/cache/:cacheName/roots/:name'],
			this.scoped('admin'),
			this.maintenance(),
			(context) =>
				context.json(
					this.roots.removeRoot(
						context.get('cache'),
						parseRequestValue(rootNameSchema, context.req.param('name'))
					)
				)
		);
		this.app.on(
			'POST',
			['/uploads', '/cache/:cacheName/uploads'],
			this.scoped('write'),
			this.maintenance(),
			async (context) =>
				context.json(
					await this.uploads.negotiate(
						context.get('cache'),
						await parseRequestBody(
							uploadNegotiateRequestSchema,
							context.req.raw
						),
						new URL(context.req.url).origin
					)
				)
		);
		this.app.on(
			'PUT',
			['/uploads/:id', '/cache/:cacheName/uploads/:id'],
			this.scoped('write'),
			this.maintenance(),
			async (context) =>
				context.json(
					await this.uploads.prepareUpload(
						context.get('cache'),
						context.req.param('id'),
						await parseRequestBody(uploadPrepareRequestSchema, context.req.raw)
					)
				)
		);
		// The commit endpoint is a WebSocket: the upgrade request carries the
		// write token, the first frame settles or defers the path, and a
		// deferred upload's socket parks (hibernating) until verification
		// answers with the terminal verdict.
		this.app.on(
			'GET',
			['/uploads/:id/commit', '/cache/:cacheName/uploads/:id/commit'],
			this.scoped('write'),
			(context) =>
				this.commitSocket(
					context.req.raw,
					context.get('cache'),
					context.req.param('id')
				)
		);
		// A deferred upload's status is polled by its uploadId, which is unique
		// across caches, so a single route serves it regardless of cache.
		this.app.get('/uploads/:id/status', this.scoped('write'), (context) =>
			context.json(this.uploads.uploadStatus(context.req.param('id')))
		);
		// The serve routes stream stored objects with conditional-request
		// handling, so they keep their Response-shaped handlers.
		this.app.on(
			'GET',
			['/attestations/:hash', '/cache/:cacheName/attestations/:hash'],
			(context) =>
				this.attestations.handleServeList(
					context.req.raw,
					context.get('cache'),
					context.req.param('hash')
				)
		);
		this.app.on(
			'GET',
			[
				'/attestation-bundles/:digest',
				'/cache/:cacheName/attestation-bundles/:digest'
			],
			(context) =>
				this.attestations.handleServeBundle(
					context.req.raw,
					context.get('cache'),
					context.req.param('digest')
				)
		);
		this.app.on(
			'POST',
			['/attestations', '/cache/:cacheName/attestations'],
			this.scoped('write'),
			this.maintenance(),
			async (context) =>
				context.json(
					await this.attestations.negotiate(
						context.get('cache'),
						await parseRequestBody(
							attestationNegotiateRequestSchema,
							context.req.raw
						)
					)
				)
		);
		this.app.on(
			'PUT',
			['/attestations/:id', '/cache/:cacheName/attestations/:id'],
			this.scoped('write'),
			this.maintenance(),
			async (context) =>
				context.json(
					await this.attestations.prepare(
						context.get('cache'),
						context.req.param('id')
					)
				)
		);
		this.app.on(
			'POST',
			['/attestations/:id/attach', '/cache/:cacheName/attestations/:id/attach'],
			this.scoped('write'),
			this.maintenance(),
			async (context) =>
				context.json(
					await this.attestations.attach(
						context.get('cache'),
						context.req.param('id')
					)
				)
		);
		// Interactive GC purges this colo's edge cache via the caller's public
		// origin. The cron sweep arrives on the internal origin and cannot know
		// the public URL, so it skips purging and relies on the narinfo TTL and
		// the orphan-blob grace window instead. The bare form sweeps every cache;
		// the scoped form sweeps one.
		this.app.post('/gc', this.scoped('admin'), this.maintenance(), (context) =>
			this.garbageCollectionResponse(context.req.url)
		);
		this.app.post(
			'/cache/:cacheName/gc',
			this.scoped('admin'),
			this.maintenance(),
			(context) =>
				this.garbageCollectionResponse(context.req.url, context.get('cache'))
		);
	}

	private async garbageCollectionResponse(
		url: string,
		cache?: string
	): Promise<Response> {
		const { origin } = new URL(url);
		const purgeOrigin = origin === internalOrigin ? undefined : origin;

		return Response.json({
			ok: true,
			...(await this.garbageCollection.collectGarbage(cache, purgeOrigin))
		});
	}

	// Upgrades a commit request, parks the socket through the hibernation API
	// (tagged by upload id, so verification can find every waiter even after
	// this object was evicted), and runs the commit transition once the 101 is
	// on its way. The scoped('write') middleware authenticates the upgrade
	// request as plain HTTP before any socket exists.
	private commitSocket(
		request: Request,
		cache: string,
		uploadId: string
	): Response {
		if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
			throw new CommitUpgradeRequiredError();
		}

		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];

		this.ctx.acceptWebSocket(server, [uploadId]);
		this.ctx.waitUntil(this.runSocketCommit(server, cache, uploadId));

		return new Response(undefined, { status: 101, webSocket: client });
	}

	private async runSocketCommit(
		socket: WebSocket,
		cache: string,
		uploadId: string
	): Promise<void> {
		try {
			const outcome = await this.withMaintenanceEligibility(() =>
				this.commitPipeline.commit(cache, uploadId)
			);

			if (outcome.kind === 'settled') {
				sendCommitFrame(socket, {
					event: 'result',
					response: outcome.response
				});
				socket.close(1000, 'settled');

				return;
			}

			sendCommitFrame(socket, {
				event: 'deferred',
				storePathHash: outcome.storePathHash,
				narHash: outcome.narHash
			});
			// The socket stays parked; verification closes it with the verdict.
		} catch (error) {
			sendCommitFrame(socket, {
				event: 'error',
				status:
					error instanceof ServerHttpError
						? error.status
						: StatusCodes.INTERNAL_SERVER_ERROR,
				message: error instanceof Error ? error.message : String(error)
			});
			socket.close(1000, 'failed');
		}
	}

	// The commit protocol is server-to-client: the only client frames are the
	// keepalive pings the auto-response answers without waking this object, so
	// anything that reaches the handler is a protocol violation.
	webSocketMessage(socket: WebSocket): void {
		socket.close(1002, 'unexpected message');
	}

	// A waiter that hangs up needs no bookkeeping (the hibernation API drops it
	// from `getWebSockets`); closing our end completes the handshake.
	webSocketClose(socket: WebSocket): void {
		socket.close();
	}

	webSocketError(socket: WebSocket): void {
		socket.close(1011, 'socket error');
	}

	// The capabilities the contract procedures reach through the oRPC context:
	// authentication, the maintenance bracket, and the domain services.
	private rpcServices(): TenantRpcServices {
		return {
			requireScope: (request, scope) =>
				this.authKeys.requireScope(request, scope),
			withMaintenanceEligibility: (body) =>
				this.withMaintenanceEligibility(body),
			cacheAdmin: this.cacheAdmin,
			signingKeys: this.signingKeys,
			authKeys: this.authKeys,
			retention: this.retention,
			oidcTrust: this.oidcTrust
		};
	}

	// Authenticates a route against the tenant's auth keys, making the verified
	// claims available to the handler. Admin tokens satisfy every scope.
	private scoped(scope: AccessScope) {
		return createMiddleware<TenantHonoEnv>(async (context, next) => {
			context.set(
				'claims',
				await this.authKeys.requireScope(context.req.raw, scope)
			);
			await next();
		});
	}

	// Brackets a mutating route with the maintenance-eligibility bookkeeping:
	// invalidated before the work, reconciled after it, failing open if the
	// reconciliation cannot run.
	private maintenance() {
		return createMiddleware<TenantHonoEnv>(async (_context, next) => {
			await this.maintenanceEligibility.invalidate();

			try {
				await next();
			} finally {
				await this.reconcileMaintenanceEligibility();
			}
		});
	}

	private async withMaintenanceEligibility<T>(
		body: () => Promise<T>
	): Promise<T> {
		await this.maintenanceEligibility.invalidate();

		try {
			return await body();
		} finally {
			await this.reconcileMaintenanceEligibility();
		}
	}

	private async reconcileMaintenanceEligibility(): Promise<void> {
		try {
			await this.maintenanceEligibility.reconcile();
		} catch {
			// Eligibility is an admission hint. If it cannot be refreshed, cron fails
			// open through a missing or stale row rather than failing the mutation.
		}
	}

	private initialise(): Promise<void> {
		this.migrationPromise ??= this.migrateAndSeed();

		return this.migrationPromise;
	}

	// Fail loudly at initialisation if the runtime lacks native zstd, rather than
	// as an opaque per-request stream error at the first verified commit.
	private async assertZstdAvailable(): Promise<void> {
		const frame = new Uint8Array([
			40, 181, 47, 253, 32, 8, 65, 0, 0, 42, 7, 42, 7, 42, 7, 42, 7
		]);
		const expected = new Uint8Array([42, 7, 42, 7, 42, 7, 42, 7]);

		let restored: Uint8Array;

		try {
			restored = new Uint8Array(
				await new Response(
					new Response(frame).body?.pipeThrough(zstdDecompressionStream())
				).arrayBuffer()
			);
		} catch (error) {
			throw new ZstdUnavailableError({ cause: error });
		}

		const matches =
			restored.length === expected.length &&
			expected.every((byte, index) => restored[index] === byte);

		if (!matches) {
			throw new ZstdUnavailableError();
		}
	}

	private async migrateAndSeed(): Promise<void> {
		await migrate(this.context.db, migrations);
		await this.assertZstdAvailable();

		// The default cache always exists in the registry so its priority is
		// resolved the same way as a named cache's. Idempotent across restarts.
		this.context.db
			.insert(schema.caches)
			.values({
				name: DEFAULT_CACHE,
				priority: CacheInfo.default.priority,
				createdAt: new Date().toISOString()
			})
			.onConflictDoNothing()
			.run();

		this.oidcTrust.seedOwnerRule();
	}
}
