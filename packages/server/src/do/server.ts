import { CacheInfo } from '@cupboard/nix-store/cache-info';
import {
	cacheFromSelector,
	cachePrioritySchema,
	cacheSelectorSchema,
	DEFAULT_CACHE
} from '@cupboard/nix-store/scalars';
import { zstdDecompressionStream } from '@cupboard/nix-store/zstd';
import type { ParsedR2CredentialCheck } from '@cupboard/protocol/reports';
import { commitSessionRequestSchema } from '@cupboard/protocol/upload';
import { DurableObject } from 'cloudflare:workers';
import { eq, or } from 'drizzle-orm';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';

import migrations from '../../drizzle/migrations.js';
import { type NarVerification } from '../blob/nar-verify.ts';
import * as schema from '../db/schema.ts';
import {
	CommitUpgradeRequiredError,
	R2PresignConfigurationMissingError,
	ServerHttpError,
	TenantNotConfiguredError,
	ZstdUnavailableError
} from '../errors.ts';
import { serverErrorHandler } from '../http/error-response.ts';
import { textResponse, verificationBatchSize } from '../http/http.ts';
import { parseRequestValue } from '../http/parse.ts';
import { authoriseRequest } from '../orpc/authorise.ts';
import { type TenantRpcServices } from '../orpc/context.ts';
import { tenantOrpcHandler } from '../orpc/handler.ts';

import { armAlarmNoLaterThan } from './alarm.ts';
import {
	AttestationCasService,
	type AttestationReference,
	type AttestationReferenceOutcome,
	type MeasuredAttestationBundle
} from './attestation-cas-service.ts';
import { AttestationsService } from './attestations-service.ts';
import { AuthKeysService } from './auth-keys-service.ts';
import {
	type CasReferenceDemotion,
	type NarInfoDemotion
} from './blob-reaper-service.ts';
import { CacheAdminService } from './cache-admin-service.ts';
import {
	CommitPipelineService,
	verifyBackstopKey
} from './commit-pipeline-service.ts';
import { sendCommitSessionFrame } from './commit-socket.ts';
import { type RuntimeEnv, ServerContext } from './context.ts';
import { type DatabaseCost, withRequestCost } from './database-cost-meter.ts';
import { DeletionQueueService } from './deletion-queue-service.ts';
import {
	GarbageCollectionService,
	maxPathsSweptPerRun
} from './garbage-collection-service.ts';
import type { TenantHonoEnv } from './hono-env.ts';
import { IntegrityCheckService } from './integrity-check-service.ts';
import {
	MaintenanceEligibilityService,
	withMaintenanceEligibility
} from './maintenance-eligibility-service.ts';
import { applyMigrations } from './migrate.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';
import {
	type NegotiateHints,
	negotiateHintsHeader,
	negotiateHintsSchema,
	type NegotiateHintsToken
} from './negotiate-hints.ts';
import { OffboardingService } from './offboarding-service.ts';
import { OidcTrustService } from './oidc-trust-service.ts';
import { ReconcileQueueService } from './reconcile-queue-service.ts';
import { RetentionService } from './retention-service.ts';
import { RootsService } from './roots-service.ts';
import { SigningKeysService } from './signing-keys-service.ts';
import { StatsService } from './stats-service.ts';
import {
	type TenantIdentity,
	TenantIdentityService
} from './tenant-identity-service.ts';
import { TokenExchangeService } from './token-exchange-service.ts';
import { parseStoredUploadPathMetadata } from './upload-metadata.ts';
import { UploadStateService } from './upload-state-service.ts';
import { UploadsService, uploadStatusOf } from './uploads-service.ts';
import {
	type PendingVerification,
	type PendingVerificationBatch,
	type VerificationResult,
	VerificationService
} from './verification-service.ts';

// What a commit session socket carries across a hibernation wake: the cache it
// was opened against and the id the verify pass routes its verdicts to.
const commitSessionAttachmentSchema = z.object({
	cache: z.string(),
	sessionId: z.string()
});

// A storage key marking that a bounded garbage-collection sweep stopped at its
// per-run cap with work left over. The alarm reads it to resume, so a large
// backlog drains across successive alarm firings without holding the gate open.
export const gcContinuationKey = 'maintenance:gc-pending';

// How many decode-free reuse rows one verify-backstop firing settles locally;
// fresh rows always wait for the queue consumer's off-thread decode.
const verifyBackstopReuseSettleLimit = 16;

export class CupboardServer extends DurableObject<RuntimeEnv> {
	private readonly app = new Hono<TenantHonoEnv>();
	private migrationPromise: Promise<void> | undefined;

	// Whether a mutation is waiting on the next coalesced eligibility publish,
	// and the drain currently publishing; see
	// {@link CupboardServer.scheduleMaintenanceReconcile}.
	private isReconcileDue = false;
	private reconcileDrain: Promise<void> | undefined;

	private readonly authKeys: AuthKeysService;
	private readonly attestationCas: AttestationCasService;
	private readonly attestations: AttestationsService;
	private readonly narInfoObjects: NarInfoObjectsService;
	private readonly uploadState: UploadStateService;
	private readonly deletionQueue: DeletionQueueService;
	private readonly reconcileQueue: ReconcileQueueService;
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
	readonly context: ServerContext;

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
		this.reconcileQueue = new ReconcileQueueService(this.context);
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
			this.deletionQueue,
			this.reconcileQueue
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

	private routes(): void {
		this.app.onError(serverErrorHandler);

		// An unconfigured Durable Object has no identity to issue, verify or advertise
		// under, so it serves nothing. This is
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
			const { matched: isMatched, response } = await tenantOrpcHandler.handle(
				context.req.raw,
				{
					context: { request: context.req.raw, services: this.rpcServices() }
				}
			);

			if (isMatched) {
				return response;
			}

			await next();
		});

		// Every request addresses a cache: the default one unless a
		// `/cache/:cacheName/` prefix names another, validated here so the routes
		// under the prefix always see a well-formed name. The `_default` wire
		// alias maps back to the default cache's stored name.
		this.app.use(async (context, next) => {
			context.set('cache', DEFAULT_CACHE);
			await next();
		});
		this.app.use('/cache/:cacheName/*', async (context, next) => {
			const selector = parseRequestValue(
				cacheSelectorSchema,
				context.req.param('cacheName')
			);

			context.set('cache', cacheFromSelector(selector));
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
		// the tokens it issues. `/token` is unauthenticated: the subject token is
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
		this.app.get('/.well-known/oauth-authorization-server', (context) => {
			const requestUrl = new URL(context.req.url);

			return context.json(
				this.authKeys.authorizationServerMetadata(requestUrl.origin)
			);
		});

		// The commit endpoint is a WebSocket: the upgrade request carries the
		// write token, the first frame settles or defers the path, and a
		// deferred upload's socket parks (hibernating) until verification
		// answers with the terminal verdict.
		this.app.on(
			'GET',
			['/commit', '/cache/:cacheName/commit'],
			this.commitSessionGuard(),
			(context) => this.commitSession(context.req.raw, context.get('cache'))
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
	}

	// Upgrades a push's single commit socket. The session is tagged with one id
	// the verify pass routes verdicts to, and that id plus the cache are stored on
	// the socket so the message handlers have them after a hibernation wake. The
	// guard authenticates the upgrade as plain HTTP before any socket exists; each
	// `commit` is authorised by the cache the session was opened against.
	private commitSession(request: Request, cache: string): Response {
		if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
			throw new CommitUpgradeRequiredError();
		}

		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		const sessionId = crypto.randomUUID();

		this.ctx.acceptWebSocket(server, [sessionId]);
		server.serializeAttachment(
			commitSessionAttachmentSchema.parse({ cache, sessionId })
		);

		return new Response(undefined, { status: 101, webSocket: client });
	}

	// Commits one upload over the session and replies with a per-id frame. The
	// socket stays open: a deferred upload's verdict arrives later over the same
	// connection, and other ids keep committing. An error fails just this id.
	private async runSessionCommit(
		socket: WebSocket,
		cache: string,
		sessionId: string,
		uploadId: string
	): Promise<void> {
		try {
			// Record the session before the commit can defer, so a verdict reached
			// before this returns still routes here.
			this.uploadState.attachSession(uploadId, sessionId);

			const outcome = await this.metered('commit', () =>
				this.afterHotMutation(() => this.commitPipeline.commit(cache, uploadId))
			);

			if (outcome.kind === 'settled') {
				sendCommitSessionFrame(socket, {
					ev: 'settled',
					uploadId,
					response: outcome.response
				});

				return;
			}

			sendCommitSessionFrame(socket, {
				ev: 'deferred',
				uploadId,
				storePathHash: outcome.storePathHash,
				narHash: outcome.narHash
			});
		} catch (error) {
			// A ServerHttpError carries a client-facing message; anything else is an
			// internal fault whose detail must not leak over the socket, matching the
			// platform 500 the HTTP error handler rethrows to.
			const isKnown = error instanceof ServerHttpError;

			if (!isKnown) {
				// The frame carries no detail, so this log line is the only record
				// of what actually failed.
				console.error('commit failed with an internal fault', {
					uploadId,
					error
				});
			}

			sendCommitSessionFrame(socket, {
				ev: 'error',
				uploadId,
				status: isKnown ? error.status : StatusCodes.INTERNAL_SERVER_ERROR,
				message: isKnown ? error.message : 'internal error'
			});
		}
	}

	// Re-attaches a reconnected session to ids still outstanding and replays each
	// one's current durable state: a still-pending upload re-emits `deferred` so
	// the client re-arms its wait, a terminal row replays its verdict, and a row
	// already cleared was committed (every clear path leaves a servable path), so
	// it replays `servable`.
	private replaySubscribe(
		socket: WebSocket,
		cache: string,
		sessionId: string,
		uploadIds: readonly string[]
	): void {
		for (const uploadId of uploadIds) {
			const row = this.context.db
				.select()
				.from(schema.pendingUploads)
				.where(eq(schema.pendingUploads.id, uploadId))
				.get();

			if (row === undefined) {
				sendCommitSessionFrame(socket, {
					ev: 'verdict',
					uploadId,
					status: 'servable'
				});
				continue;
			}

			if (row.cache !== cache) {
				sendCommitSessionFrame(socket, {
					ev: 'error',
					uploadId,
					status: StatusCodes.NOT_FOUND,
					message: 'unknown upload'
				});
				continue;
			}

			// Re-point the row at this socket so a verdict from here on routes to it.
			this.uploadState.attachSession(uploadId, sessionId);
			const status = uploadStatusOf(row);

			if (status === 'pending') {
				const metadata = parseStoredUploadPathMetadata(
					uploadId,
					row.metadataJson
				);
				sendCommitSessionFrame(socket, {
					ev: 'deferred',
					uploadId,
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash
				});
				continue;
			}

			sendCommitSessionFrame(socket, { ev: 'verdict', uploadId, status });
		}
	}

	// The capabilities the contract procedures reach through the oRPC context:
	// authentication, the post-mutation maintenance hook, and the domain services.
	private rpcServices(): TenantRpcServices {
		return {
			authenticate: (request) => this.authKeys.authenticate(request),
			pendingCache: (id) => this.pendingCache(id),
			afterMutation: (body) => this.afterMutation(body),
			takeNegotiateHints: (request) => {
				const token = request.headers.get(negotiateHintsHeader);

				return token === null
					? undefined
					: this.context.negotiateHints.take(token, Date.now());
			},
			cacheAdmin: this.cacheAdmin,
			signingKeys: this.signingKeys,
			authKeys: this.authKeys,
			retention: this.retention,
			oidcTrust: this.oidcTrust,
			stats: this.stats,
			integrityCheck: this.integrityCheck,
			roots: this.roots,
			deletionQueue: this.deletionQueue,
			garbageCollection: this.garbageCollection,
			uploads: this.uploads,
			attestations: this.attestations,
			verification: this.verification
		};
	}

	// Authorises the commit session, the one write route outside the contract:
	// `upload:commit` against the cache the session is scoped to. Each `commit`
	// frame then commits an id in that cache, and `commit(cache, uploadId)` fails
	// an id whose row belongs to another cache, so the cache check covers every id.
	private commitSessionGuard() {
		return createMiddleware<TenantHonoEnv>(async (context, next) => {
			const claims = await this.authKeys.authenticate(context.req.raw);
			const cache = context.get('cache');

			await authoriseRequest(
				claims,
				{ requires: 'upload:commit', resource: { cache: { pending: true } } },
				{ id: cache },
				() => Promise.resolve(cache)
			);

			await next();
		});
	}

	// The cache a pending upload or attestation row was opened against, for the
	// id-only routes the authoriser cannot read a cache from the path. The
	// durable-SQLite reads are synchronous; the resolver is a promise so the
	// authoriser can stay uniform across resource sources.
	private pendingCache(id: string): Promise<string | undefined> {
		const upload = this.context.db
			.select({ cache: schema.pendingUploads.cache })
			.from(schema.pendingUploads)
			.where(eq(schema.pendingUploads.id, id))
			.get();

		if (upload !== undefined) {
			return Promise.resolve(upload.cache);
		}

		const attestation = this.context.db
			.select({ cache: schema.pendingAttestations.cache })
			.from(schema.pendingAttestations)
			.where(eq(schema.pendingAttestations.id, id))
			.get();

		return Promise.resolve(attestation?.cache);
	}

	// Runs a body and reconciles the maintenance-eligibility projection
	// synchronously after it, invalidating first so a crash anywhere in the body
	// leaves the tenant due (fail-open). The cron sweeps use this: a crash during a
	// maintenance pass must not leave a stale not-due row behind. The mutating
	// request paths skip the invalidate (that would cost a D1 delete on every
	// mutation and defeat the write-coalescing) and accept the eviction window
	// their trailing reconcile leaves: the admin mutations reconcile inline via
	// `afterMutation`, the commit and verdict hot paths coalesce theirs via
	// `afterHotMutation`.
	private async withMaintenanceEligibility<T>(
		body: () => Promise<T>
	): Promise<T> {
		return withMaintenanceEligibility(
			this.maintenanceEligibility,
			() => this.reconcileMaintenanceEligibility(),
			body
		);
	}

	// Runs a mutating request and republishes the tenant's wake time before the
	// request returns. The reconcile is an existence check plus a few index-backed
	// lookups, cheap enough to run on every mutation, so the published wake time
	// trails the source tables only between the committed write and this `finally`.
	// The `finally` covers a body that throws after a partial write; the one case it
	// does not cover is a hard isolate eviction inside that window, which leaves the
	// prior wake time in place. Deferred verify is re-triggered out of band by the
	// `tenant-verify` queue message, so it does not wait; the rest waits for the cron's
	// staleness floor: a now-due queued narinfo deletion, or a
	// deferred deadline (upload or attestation expiry, retention-root TTL, auth-key
	// retirement). The reconcile publishes through a single conditional upsert that
	// writes only when the wake time moves, so a push of many paths costs one write.
	private async afterMutation<T>(body: () => Promise<T>): Promise<T> {
		try {
			return await body();
		} finally {
			await this.reconcileMaintenanceEligibility();
		}
	}

	// The commit hot path's twin of {@link afterMutation}: the reply does not
	// wait on the publish, and concurrent mutations coalesce onto a shared one.
	// A push settling hundreds of paths costs a publish per in-flight window.
	private async afterHotMutation<T>(body: () => Promise<T>): Promise<T> {
		try {
			return await body();
		} finally {
			this.scheduleMaintenanceReconcile();
		}
	}

	// Requests an eligibility publish without waiting for it. While one publish
	// is in flight every further request collapses onto a single follow-up,
	// which runs with the state as it stands then, so the last mutation of a
	// burst is always covered. An eviction can drop a scheduled publish; the
	// sweep's staleness floor bounds how long the stale projection can suppress
	// maintenance, the same backstop the synchronous reconcile's eviction
	// window relies on.
	private scheduleMaintenanceReconcile(): void {
		this.isReconcileDue = true;

		if (this.reconcileDrain !== undefined) {
			return;
		}

		const drain = async (): Promise<void> => {
			try {
				while (this.isReconcileDue) {
					this.isReconcileDue = false;
					await this.reconcileMaintenanceEligibility();
				}
			} finally {
				this.reconcileDrain = undefined;
			}
		};

		this.reconcileDrain = drain();
	}

	private async reconcileMaintenanceEligibility(): Promise<void> {
		// The reconcile publishes through a single conditional upsert, so two concurrent
		// same-tenant reconciles settle atomically without a lock: a stale one cannot
		// overwrite a fresher one. A failed reconcile would leave a stale projection that
		// can suppress maintenance until the staleness floor, so drop the row instead and
		// let the periodic sweep read the tenant as due (fail-open).
		try {
			await this.maintenanceEligibility.reconcile();
		} catch {
			await this.invalidateMaintenanceEligibility();
		}
	}

	// Drops the maintenance-eligibility projection so the periodic sweep reads the
	// tenant as due and reconciles on its next tick. Fail-open: if the delete also
	// fails, the staleness floor still bounds the delay.
	private async invalidateMaintenanceEligibility(): Promise<void> {
		try {
			await this.maintenanceEligibility.invalidate();
		} catch {
			// The staleness floor remains the backstop.
		}
	}

	// Runs a direct RPC entrypoint (one that bypasses `fetch`) inside its own
	// request cost meter, so the Durable Object rows it reads are logged like an
	// HTTP request's, so the row-heavy maintenance sweeps
	// run through here.
	private metered<T>(
		method: MeteredMethod,
		body: () => Promise<T>
	): Promise<T> {
		return withRequestCost(body, (cost) => {
			logMethodFinished(method, cost);
		});
	}

	private initialise(): Promise<void> {
		this.migrationPromise ??= this.migrateAndSeed();

		return this.migrationPromise;
	}

	// Fail loudly at initialisation if the runtime lacks native zstd, before
	// an opaque per-request stream error surfaces at the first verified commit.
	private async assertZstdAvailable(): Promise<void> {
		const frame = new Uint8Array([
			40, 181, 47, 253, 32, 8, 65, 0, 0, 42, 7, 42, 7, 42, 7, 42, 7
		]);
		const expected = new Uint8Array([42, 7, 42, 7, 42, 7, 42, 7]);

		let restored: Uint8Array;

		try {
			const frameResponse = new Response(frame);
			const decompressed = frameResponse.body?.pipeThrough(
				zstdDecompressionStream()
			);
			const decompressedResponse = new Response(decompressed);
			restored = new Uint8Array(await decompressedResponse.arrayBuffer());
		} catch (error) {
			throw new ZstdUnavailableError({ cause: error });
		}

		const isMatch =
			restored.length === expected.length &&
			expected.every((byte, index) => restored[index] === byte);

		if (!isMatch) {
			throw new ZstdUnavailableError();
		}
	}

	private async migrateAndSeed(): Promise<void> {
		// The cumulative meter is never reset, and a purged object can run this again,
		// so measure the cold-start cost as a delta over the migration and seed rather
		// than reading the lifetime totals. The delta is exact only because nothing else
		// issues statements on this object between the readings: the seed is synchronous
		// and the one await here (`assertZstdAvailable`) touches no table.
		this.context.dbCost.settle();
		const rowsReadBefore = this.context.dbCost.rowsRead;
		const rowsWrittenBefore = this.context.dbCost.rowsWritten;

		applyMigrations(this.context.db, migrations);
		await this.assertZstdAvailable();

		const now = new Date();

		// The default cache always exists in the registry so its priority is
		// resolved the same way as a named cache's. Idempotent across restarts.
		this.context.db
			.insert(schema.caches)
			.values({
				name: DEFAULT_CACHE,
				priority: cachePrioritySchema.parse(CacheInfo.default.priority),
				createdAt: now.toISOString()
			})
			.onConflictDoNothing()
			.run();

		this.oidcTrust.seedOwnerRule();

		// Migration and seeding run before the first request opens its meter, so their
		// rows land on no per-request line. Surface them once as the cold-start cost.
		this.context.dbCost.settle();
		logMethodFinished('initialise', {
			rowsRead: this.context.dbCost.rowsRead - rowsReadBefore,
			rowsWritten: this.context.dbCost.rowsWritten - rowsWrittenBefore
		});
	}

	// One bounded sweep. Stopping at the cap means there is likely more to
	// collect, so it records the cap and arms an immediate alarm; the gate is free
	// between firings, so push requests interleave while the backlog drains across
	// chunks. Each chunk holds the gate only for its own deletes. The cap is
	// persisted so the alarm resumes with the bound the run started with.
	private async sweepGarbageOnce(
		sweepLimit: number = maxPathsSweptPerRun
	): Promise<void> {
		const outcome = await this.metered('garbage-collection', () =>
			this.withMaintenanceEligibility(() =>
				this.garbageCollection.collectGarbage(undefined, undefined, sweepLimit)
			)
		);

		await (outcome.pathsSwept >= sweepLimit
			? this.armGarbageContinuation(sweepLimit)
			: this.ctx.storage.delete(gcContinuationKey));
	}

	private async armGarbageContinuation(sweepLimit: number): Promise<void> {
		await this.ctx.storage.put(gcContinuationKey, sweepLimit);
		await this.ctx.storage.setAlarm(Date.now());
	}

	// Resumes a garbage-collection sweep that stopped at its per-run cap. A run
	// that did not stop at the cap left no continuation, so this is a no-op.
	private async resumeGarbageCollection(): Promise<void> {
		const sweepLimit = await this.ctx.storage.get<number>(gcContinuationKey);

		if (typeof sweepLimit !== 'number') {
			return;
		}

		await this.ctx.storage.delete(gcContinuationKey);
		await this.sweepGarbageOnce(sweepLimit);
	}

	// One bounded reconcile of the committed paths a recent negotiate queued. Like
	// the garbage-collection sweep it holds the gate only for the chunk's
	// reconciles and re-arms the alarm while more remain, so a large closure's R2
	// probes drain across firings off the push hot path. A drained queue clears its
	// origin marker so a later push starts fresh.
	private async reconcileNegotiatedOnce(): Promise<void> {
		const queued = await this.reconcileQueue.claimChunk();

		if (queued.size === 0) {
			await this.reconcileQueue.clearOrigin();
			return;
		}

		const origin = await this.reconcileQueue.origin();

		await this.metered('reconcile', () =>
			this.withMaintenanceEligibility(() =>
				this.verification.reconcileTargets(queued.values().toArray(), origin)
			)
		);

		await this.reconcileQueue.clearKeys(queued.keys().toArray());

		if (await this.reconcileQueue.hasPending()) {
			await this.ctx.storage.setAlarm(Date.now());
			return;
		}

		await this.reconcileQueue.clearOrigin();
	}

	// The verify backstop: while deferred uploads may be pending, the alarm
	// re-drives verification if the queue path has gone quiet. Not yet due, it
	// only re-arms (another loop's immediate continuation consumed the alarm,
	// which the runtime deletes once the handler returns). Due, it settles a
	// bounded batch of decode-free reuse rows locally, then re-requests a queue
	// pass; the request's staleness guard makes that a real send exactly when
	// the previous one is presumed lost, and its arming starts the next backstop
	// cycle. NAR decode never runs here: fresh rows wait for the queue consumer.
	private async resumeVerifyBackstop(): Promise<void> {
		const dueAt = await this.ctx.storage.get<number>(verifyBackstopKey);

		if (dueAt === undefined) {
			return;
		}

		if (Date.now() < dueAt) {
			await armAlarmNoLaterThan(this.ctx.storage, dueAt);
			return;
		}

		const pending = this.context.db
			.select({ id: schema.pendingUploads.id })
			.from(schema.pendingUploads)
			.where(
				or(
					eq(schema.pendingUploads.verdict, 'pending'),
					eq(schema.pendingUploads.verdict, 'committing')
				)
			)
			.limit(1)
			.get();

		if (pending === undefined) {
			await this.ctx.storage.delete(verifyBackstopKey);
			return;
		}

		await this.metered('verify-backstop', () =>
			this.withMaintenanceEligibility(() =>
				this.verification.settlePendingReuse(verifyBackstopReuseSettleLimit)
			)
		);
		await this.commitPipeline.requestVerification(this.context.requireTenant());
	}

	async fetch(request: Request): Promise<Response> {
		await this.initialise();

		let status = StatusCodes.INTERNAL_SERVER_ERROR;

		return withRequestCost(
			async () => {
				const response = await this.app.fetch(request, this.env);
				status = response.status;

				return response;
			},
			(cost) => {
				logRequestFinished(request, status, cost);
			}
		);
	}

	// The cron drives maintenance through these RPC methods via service binding,
	// so no token is
	// issued or exchanged. The same cores back `/gc` and `/verify` for manual
	// use. Both sweep every cache and skip the edge-cache purge, exactly as an
	// internal-origin HTTP sweep did, relying on the narinfo TTL and the
	// orphan-blob grace window.
	async runGarbageCollection(sweepLimit?: number): Promise<void> {
		await this.initialise();
		await this.sweepGarbageOnce(sweepLimit);
	}

	// Drives the bounded background loops the single DO alarm carries: resuming
	// a capped garbage-collection sweep, reconciling the committed paths a
	// recent negotiate queued, resuming a cache teardown, and the verify
	// backstop. Each re-arms the alarm while it has work left, so the backlogs
	// converge across firings while the gate stays free between them.
	override async alarm(): Promise<void> {
		await this.initialise();
		await this.resumeGarbageCollection();
		await this.reconcileNegotiatedOnce();
		await this.resumeCacheTeardown();
		await this.resumeVerifyBackstop();
	}

	// Starts a cache teardown directly, the manual/test entry that the `caches`
	// remove route reaches through `removeCache`. The optional limit caps the first
	// drain chunk so a test can force the over-cap, alarm-resumed path without
	// pushing a whole cap's worth of paths, mirroring {@link runGarbageCollection}.
	async runCacheTeardown(
		cache: string,
		origin: string,
		limit?: number
	): Promise<void> {
		await this.initialise();
		await this.metered('cache-teardown', () =>
			this.withMaintenanceEligibility(() =>
				this.cacheAdmin.tearDownCache(cache, origin, limit)
			)
		);
	}

	// Resumes a cache teardown that stopped at its per-run cap. It claims one cache
	// awaiting teardown, retires another bounded chunk, then re-arms the alarm while
	// any cache still has a marker, so several queued teardowns drain across firings
	// with the gate free between them. No marker means nothing to do. The optional
	// limit caps the chunk for tests, mirroring {@link runGarbageCollection}.
	async resumeCacheTeardown(limit?: number): Promise<void> {
		const claimed = await this.cacheAdmin.claimTeardown();

		if (claimed === undefined) {
			return;
		}

		await this.metered('cache-teardown', () =>
			this.withMaintenanceEligibility(() =>
				this.cacheAdmin.resumeTeardownPass(claimed.cache, claimed.origin, limit)
			)
		);

		if (await this.cacheAdmin.hasPendingTeardown()) {
			await this.ctx.storage.setAlarm(Date.now());
		}
	}

	async runVerification(): Promise<void> {
		await this.initialise();
		// This pass will claim the pending rows, so re-arm the prompt-verify
		// single-flight guard: a deferral after this point asks for its own pass.
		this.commitPipeline.onVerificationPassStarted();
		await this.metered('verification', () =>
			this.withMaintenanceEligibility(async () => {
				await this.verification.verifyPendingUploads(verificationBatchSize);
				await this.verification.verifyBatch(undefined, verificationBatchSize);
			})
		);
	}

	// The prompt verify path runs the CPU-bound NAR decode in the queue consumer,
	// off the DO thread. The consumer claims a bounded chunk of pending uploads
	// here (a read), decodes and promotes each staging object itself, then
	// reports the verdicts back so only the state transitions run on the single
	// writer. A truncated claim tells the consumer more rows remain.
	async claimVerificationBatch(
		limit: number,
		maxNarBytes: number
	): Promise<PendingVerificationBatch> {
		await this.initialise();
		// Claiming is the start of a pass: re-arm the prompt-verify guard before
		// taking the snapshot so a deferral after it triggers a fresh request.
		this.commitPipeline.onVerificationPassStarted();
		return this.metered('claim-verifications', () =>
			Promise.resolve(
				this.verification.listPendingForVerify(limit, maxNarBytes)
			)
		);
	}

	// The uncapped claim an older consumer script calls; the DO and the consumer
	// deploy separately, so this stays callable until both run a release that
	// speaks `claimVerificationBatch`.
	async claimPendingVerifications(
		limit: number
	): Promise<PendingVerification[]> {
		const batch = await this.claimVerificationBatch(limit, Infinity);

		return [...batch.claims];
	}

	// Stages Worker-computed negotiate hints, returning the single-use token the
	// dispatch that follows carries; see {@link NegotiateHintStore}. Reachable
	// only over RPC, never HTTP, so a client cannot forge hints. An unrecognised
	// shape (a deploy-skewed Worker) throws, which the Worker treats as staging
	// unavailable and dispatches without hints.
	async stageNegotiateHints(
		hints: NegotiateHints
	): Promise<NegotiateHintsToken> {
		await this.initialise();

		return this.context.negotiateHints.stage(
			negotiateHintsSchema.parse(hints),
			Date.now()
		);
	}

	// Asks for another verification pass, through the same single-flight as a
	// deferring commit, so a continuation from the queue consumer and a fresh
	// deferral collapse onto one message that claims each row once.
	async requestVerificationPass(): Promise<void> {
		await this.initialise();
		await this.commitPipeline.requestVerification(this.context.requireTenant());
	}

	// Settles a whole batch of verdicts in one call, so the queue consumer reports
	// a pass with a single RPC into the DO. Returns how
	// many verdicts actually applied, so the consumer's continuation gates on real
	// progress.
	async recordVerifications(
		results: readonly VerificationResult[]
	): Promise<number> {
		await this.initialise();
		return this.metered('record-verifications', () =>
			this.afterHotMutation(() =>
				this.verification.recordVerifications(results)
			)
		);
	}

	async recordVerification(
		uploadId: string,
		verification: NarVerification
	): Promise<void> {
		await this.initialise();
		await this.metered('record-verification', () =>
			this.afterHotMutation(() =>
				this.verification.recordVerification(uploadId, verification)
			)
		);
	}

	async recordMissingObject(uploadId: string): Promise<void> {
		await this.initialise();
		await this.metered('record-missing-object', () =>
			this.afterHotMutation(() =>
				this.verification.recordMissingObject(uploadId)
			)
		);
	}

	async runAuthKeyRetirement(): Promise<void> {
		await this.initialise();
		await this.metered('auth-key-retirement', () =>
			this.withMaintenanceEligibility(() =>
				this.authKeys.retireScheduledAuthKeys()
			)
		);
	}

	// The global reaper found shared objects gone and routes the de-materialisation
	// of this tenant's narinfos for those hashes through here in one call, the single
	// writer of the tenant's objects. Each target is de-materialised only if its live
	// row still names the hash and the object is still absent, so the call is
	// idempotent and the reaper can re-drive it until the `blob_state` row is cleared.
	async demoteNarInfoObjects(
		demotions: readonly NarInfoDemotion[]
	): Promise<void> {
		await this.initialise();

		await this.metered('demote-narinfo-objects', async () => {
			for (const { narHash, targets } of demotions) {
				for (const target of targets) {
					await this.narInfoObjects.demoteUnbacked(
						target.cache,
						target.storePathHash,
						narHash
					);
				}
			}
		});
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
		// The attestation references live in D1, which the cost meter does not see.
		// The one tenant-identity row this reads through the metered db is folded into
		// the cumulative meter but is not worth its own per-request line, so this
		// entrypoint is not metered.
		return this.attestationCas.reserveReferenceAndCharge(reference, size);
	}

	async removeAttestationReference(
		reference: AttestationReference
	): Promise<void> {
		await this.initialise();
		// D1-bound references, like `reserveAttestationReference`, so not metered.
		await this.attestationCas.removeCapturedReference(reference);
	}

	async demoteAttestationReferences(
		demotions: readonly CasReferenceDemotion[]
	): Promise<void> {
		await this.initialise();
		await this.metered('demote-attestation-references', async () => {
			for (const { digest, fenceStoredAt } of demotions) {
				await this.attestations.removeReferencesForDigest(
					digest,
					fenceStoredAt
				);
			}
		});
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

		return this.metered('offboard', () =>
			this.context.criticalSection(() => this.offboarding.drain(limit))
		);
	}

	// Wipes this Durable Object's own storage once its tenant is drained: the signing
	// and auth keys, the identity, and the narinfo rows. After this the
	// object is unconfigured and serves nothing, so its tenant retains no secret or
	// data.
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
	// them) to issue a temporary credential the way a push does and see whether
	// R2 accepts it. Probing the derived credential, not just the pair, catches
	// a pair that signs plain requests but cannot issue the credential uploads
	// use. The probe touches only the env, never this object's storage, so any
	// instance can answer it.
	async checkR2(): Promise<ParsedR2CredentialCheck> {
		let response: Response;

		try {
			response = await this.context
				.r2Presigner()
				.probeTemporaryCredential(new Date());
		} catch (error) {
			if (error instanceof R2PresignConfigurationMissingError) {
				return { result: 'unconfigured' };
			}

			throw error;
		}

		// R2 refuses the temporary credential with 400 (InvalidArgument); a valid
		// one answers 403 (the write-only grant may not read the probe key) or
		// 404, so only other statuses speak against the pair.
		if (response.ok || response.status === 403 || response.status === 404) {
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

		await this.metered('configure', async () => {
			if (this.tenantIdentity.configure(identity)) {
				this.oidcTrust.seedOwnerRule();
			}

			await this.reconcileMaintenanceEligibility();
		});
	}

	// A client frame on the commit session: a `commit` to settle one id or a
	// `subscribe` to re-attach a reconnected socket to ids still outstanding.
	// Keepalive pings never reach here; the auto-response answers them without
	// waking this object. The cache and session id ride on the socket so they
	// survive a hibernation wake.
	async webSocketMessage(
		socket: WebSocket,
		message: string | ArrayBuffer
	): Promise<void> {
		const attachment = commitSessionAttachmentSchema.safeParse(
			socket.deserializeAttachment()
		);

		if (!attachment.success) {
			socket.close(1011, 'missing session');
			return;
		}

		const text =
			typeof message === 'string' ? message : new TextDecoder().decode(message);
		let request;

		try {
			request = commitSessionRequestSchema.parse(JSON.parse(text));
		} catch {
			socket.close(1002, 'invalid commit request');
			return;
		}

		const { cache, sessionId } = attachment.data;

		if (request.op === 'commit') {
			await this.runSessionCommit(socket, cache, sessionId, request.uploadId);
			return;
		}

		this.replaySubscribe(socket, cache, sessionId, request.uploadIds);
	}

	// A waiter that hangs up needs no bookkeeping (the hibernation API drops it
	// from `getWebSockets`); closing our end completes the handshake.
	webSocketClose(socket: WebSocket): void {
		socket.close();
	}

	webSocketError(socket: WebSocket): void {
		socket.close(1011, 'socket error');
	}
}

// Emits a line when a request finishes, carrying its Durable Object SQLite cost
// among the fields. The DO is billed per row read, so surfacing rows read and
// written per request makes a row-heavy request observable in the logs rather
// than only on the daily bill. One DO backs one tenant, so the emitting object
// already identifies the tenant.
function logRequestFinished(
	request: Request,
	status: number,
	cost: DatabaseCost
): void {
	console.log('request finished', {
		method: request.method,
		path: new URL(request.url).pathname,
		status,
		rowsRead: cost.rowsRead,
		rowsWritten: cost.rowsWritten
	});
}

// The closed set of direct (non-`fetch`) entrypoints the cost meter labels, kept as
// a union so a label cannot drift from its entrypoint or be mistyped.
type MeteredMethod =
	| 'auth-key-retirement'
	| 'cache-teardown'
	| 'claim-verifications'
	| 'commit'
	| 'configure'
	| 'demote-attestation-references'
	| 'demote-narinfo-objects'
	| 'garbage-collection'
	| 'initialise'
	| 'offboard'
	| 'reconcile'
	| 'record-missing-object'
	| 'record-verification'
	| 'record-verifications'
	| 'verification'
	| 'verify-backstop';

// The same line for a direct RPC entrypoint (the maintenance sweeps, configure,
// the cold-start migration) that does not flow through `fetch` but still reads
// Durable Object rows worth surfacing.
function logMethodFinished(method: MeteredMethod, cost: DatabaseCost): void {
	console.log('method finished', {
		method,
		rowsRead: cost.rowsRead,
		rowsWritten: cost.rowsWritten
	});
}
