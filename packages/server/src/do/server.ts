import { type Logger } from '@cupboard/logger';
import { CacheInfo } from '@cupboard/nix-store/cache-info';
import {
	cacheFromSelector,
	cachePrioritySchema,
	cacheSelectorSchema,
	DEFAULT_CACHE,
	type StoredCache,
	storedCacheSchema
} from '@cupboard/nix-store/scalars';
import { zstdDecompressionStream } from '@cupboard/nix-store/zstd';
import {
	type CacheAvailabilityResponse,
	reuseViewAvailabilityRequestSchema
} from '@cupboard/protocol/cache-availability';
import type {
	ParsedR2CredentialCheck,
	VerifyReport
} from '@cupboard/protocol/reports';
import { reuseViewNameSchema } from '@cupboard/protocol/reuse-views';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import {
	commitCapabilitiesHeader,
	commitCapabilitiesValue,
	commitCapabilitiesValueWithCredit,
	commitCreditCapability,
	commitSessionRequestSchema,
	type ParsedCommitBatchEntry,
	type ParsedCommitSessionRequest,
	type SessionId,
	sessionIdSchema,
	uploadCapabilitiesHeader,
	uploadCapabilitiesValue,
	uploadGraceFactsCapability,
	type UploadId,
	uploadIdSchema
} from '@cupboard/protocol/upload';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { DurableObject } from 'cloudflare:workers';
import { eq, or } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';

import migrations from '../../drizzle/migrations.js';
import { type NarVerification } from '../blob/nar-verify.ts';
import * as schema from '../db/schema.ts';
import { isD1Overload } from '../db/transient.ts';
import {
	CommitSessionLimitError,
	CommitUpgradeRequiredError,
	DatabaseOverloadedError,
	R2PresignConfigurationMissingError,
	ServerHttpError,
	TenantNotConfiguredError,
	UploadNotFoundError,
	ZstdUnavailableError
} from '../errors.ts';
import { hasAcceptedCapability } from '../http/capabilities.ts';
import { serverErrorHandler } from '../http/error-response.ts';
import {
	parseNarInfoName,
	type R2ObjectKey,
	type RequestOrigin,
	requestOriginSchema,
	textResponse,
	verificationBatchSize
} from '../http/http.ts';
import { parseRequestBody, parseRequestValue } from '../http/parse.ts';
import {
	loggerMiddleware,
	requestLogger,
	rootLogger
} from '../observability/logging.ts';
import { withSpan } from '../observability/span.ts';
import { authoriseRequest } from '../orpc/authorise.ts';
import { type TenantRpcServices } from '../orpc/context.ts';
import { tenantOrpcHandler } from '../orpc/handler.ts';
import { commitEntryCreditBudget } from '../policy/commit-credit.ts';
import {
	commitSocketCeiling,
	maxUncreditedCommitSessions
} from '../policy/commit-sockets.ts';

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
import { maxOutgoingConnections } from './bulk.ts';
import { CacheAdminService } from './cache-admin-service.ts';
import {
	CommitCreditService,
	commitSocketIdleMs,
	hasPacedSession,
	isSessionClosing,
	readCommitSessionAttachment,
	unpacedSessions
} from './commit-credit-service.ts';
import {
	CommitPipelineService,
	type PrefetchedMaterialisationFacts,
	type TenantAccount,
	verifyBackstopKey
} from './commit-pipeline-service.ts';
import { sendCommitSessionFrame } from './commit-socket.ts';
import {
	type GarbageCollectionOutcome,
	type RuntimeEnv,
	ServerContext
} from './context.ts';
import { type DatabaseCost, withRequestCost } from './database-cost-meter.ts';
import { DeletionQueueService } from './deletion-queue-service.ts';
import {
	GarbageCollectionService,
	maxPathsCollectedPerRun
} from './garbage-collection-service.ts';
import {
	capturedGraceFact,
	parseStoredGraceDecision,
	storedGraceFact
} from './grace-decision.ts';
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
import { ReuseViewAdminService } from './reuse-view-admin-service.ts';
import { ReuseViewLookupService } from './reuse-view-lookup-service.ts';
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

// A reuse-view miss: 404 and no-store, so a shared cache can never pin an
// answer that a later view definition or commit would change.
function reuseNotFound(): Response {
	return new Response('Not found\n', {
		status: StatusCodes.NOT_FOUND,
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'no-store'
		}
	});
}

// A storage key marking that a bounded garbage collection stopped at its
// per-run cap with work left over. The alarm reads it to resume, so a large
// backlog drains across successive alarm firings without holding the gate open.
export const gcContinuationKey = 'maintenance:gc-pending';

const garbageCollectionLimitSchema = z.number().int().positive();

// An earlier build stored the per-run cap as `sweepLimit`. A tenant whose
// collection stopped at the cap keeps its marker until the alarm drains it, so
// a marker written before the rename is read as the current shape.
function adoptStoredLimit(value: unknown): unknown {
	if (typeof value !== 'object' || value === null || !('sweepLimit' in value)) {
		return value;
	}

	const { sweepLimit, ...rest } = value;

	return { ...rest, collectLimit: sweepLimit };
}

// The continuation as this build writes it.
const currentContinuationSchema = z.discriminatedUnion('scope', [
	z.object({
		scope: z.literal('tenant'),
		collectLimit: garbageCollectionLimitSchema
	}),
	z.object({
		scope: z.literal('cache'),
		cache: storedCacheSchema,
		collectLimit: garbageCollectionLimitSchema
	})
]);
const garbageCollectionContinuationSchema = z.preprocess(
	adoptStoredLimit,
	currentContinuationSchema
);
const garbageCollectionContinuationsSchema = z
	.array(garbageCollectionContinuationSchema)
	.min(1);

type GarbageCollectionContinuation = z.infer<
	typeof garbageCollectionContinuationSchema
>;

function parseGarbageCollectionContinuations(
	value: unknown
): GarbageCollectionContinuation[] {
	const legacy = garbageCollectionLimitSchema.safeParse(value);

	if (legacy.success) {
		return [{ scope: 'tenant', collectLimit: legacy.data }];
	}

	const parsed = garbageCollectionContinuationsSchema.safeParse(value);

	if (parsed.success) {
		return parsed.data;
	}

	const single = garbageCollectionContinuationSchema.safeParse(value);

	return single.success ? [single.data] : [];
}

function garbageCollectionContinuation(
	cache: StoredCache | undefined,
	collectLimit: number
): GarbageCollectionContinuation {
	return cache === undefined
		? { scope: 'tenant', collectLimit }
		: { scope: 'cache', cache, collectLimit };
}

function mergeGarbageCollectionContinuation(
	pending: readonly GarbageCollectionContinuation[],
	continuation: GarbageCollectionContinuation
): GarbageCollectionContinuation[] {
	// One entry per cache is enough: repeated runs resume the same backlog. A
	// tenant-wide entry covers every cache and collapses the list to one.
	if (continuation.scope === 'tenant') {
		return [continuation];
	}

	const tenantWide = pending.find((candidate) => candidate.scope === 'tenant');

	if (tenantWide !== undefined) {
		return [tenantWide];
	}

	return [
		...pending.filter(
			(candidate) =>
				candidate.scope !== 'cache' || candidate.cache !== continuation.cache
		),
		continuation
	];
}

// How many decode-free reuse rows one verify-backstop firing settles locally;
// fresh rows always wait for the queue consumer's off-thread decode.
const verifyBackstopReuseSettleLimit = 16;

// The maintenance passes serialised per kind on this instance.
type MaintenanceKind = 'gc' | 'verify';

// Bounds the number of tasks that may run concurrently. Callers `acquire` a
// slot before starting work and `release` it when done; excess callers wait
// until a slot is free.
class CountingSemaphore {
	private slots: number;
	private readonly waiters: ((value: undefined) => void)[] = [];

	constructor(limit: number) {
		this.slots = limit;
	}

	acquire(): Promise<undefined> {
		if (this.slots > 0) {
			this.slots -= 1;
			return Promise.resolve(undefined);
		}

		const { promise, resolve } = Promise.withResolvers<undefined>();
		this.waiters.push(resolve);
		return promise;
	}

	release(): void {
		const next = this.waiters.shift();

		if (next === undefined) {
			this.slots += 1;
			return;
		}

		next(undefined);
	}
}

export class CupboardServer extends DurableObject<RuntimeEnv> {
	private readonly app = new Hono<TenantHonoEnv>();

	// Serialises maintenance passes per kind on this instance. A Durable Object
	// has one active instance, so the alarm, the cron/queue RPCs and the
	// interactive admin path share these chains: a second driver of the same kind
	// links its pass after the one ahead rather than piling both onto the input
	// gate at once. Every pass runs; none is silently skipped.
	private readonly maintenanceChains = new Map<
		MaintenanceKind,
		Promise<undefined>
	>();

	// The maintenance kinds a cron-driven pass is queued or running for. The cron
	// entrypoints coalesce against it: while one is present a further cron tick for
	// that kind returns at once, bounding the backlog to one queued cron pass per
	// kind. The alarm resume and the interactive path do not use it; they always
	// chain.
	private readonly cronMaintenanceQueued = new Set<MaintenanceKind>();
	private migrationPromise: Promise<void> | undefined;

	// Whether a mutation is waiting on the next coalesced eligibility publish,
	// and the drain currently publishing; see
	// {@link CupboardServer.scheduleMaintenanceReconcile}.
	private isReconcileDue = false;
	private reconcileDrain: Promise<void> | undefined;

	// Caps the total number of commits running concurrently across all in-flight
	// session messages, batched entries and per-id ops alike, keeping the sum
	// within one batch message's own bound.
	private readonly commitEntrySemaphore = new CountingSemaphore(
		maxOutgoingConnections
	);

	// Admits commit work against the tenant's entry-credit budget, which is what
	// bounds the parsed backlog; the semaphore above bounds only what executes.
	private readonly commitCredit: CommitCreditService;

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
	private readonly reuseViews: ReuseViewAdminService;
	private readonly reuseLookup: ReuseViewLookupService;
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
			this.attestations,
			this.narInfoObjects
		);
		this.reconcileQueue = new ReconcileQueueService(this.context);
		this.signingKeys = new SigningKeysService(this.context);
		this.stats = new StatsService(this.context);
		this.oidcTrust = new OidcTrustService(this.context, this.tenantIdentity);
		this.retention = new RetentionService(this.context);
		this.reuseViews = new ReuseViewAdminService(this.context);
		this.reuseLookup = new ReuseViewLookupService(this.context);
		this.integrityCheck = new IntegrityCheckService(this.context);
		this.cacheAdmin = new CacheAdminService(this.context, this.deletionQueue);
		this.garbageCollection = new GarbageCollectionService(
			this.context,
			this.deletionQueue,
			this.retention
		);
		this.tokenExchange = new TokenExchangeService(
			this.context,
			this.authKeys,
			this.oidcTrust
		);
		this.roots = new RootsService(
			this.context,
			this.cacheAdmin,
			this.retention,
			this.narInfoObjects
		);
		this.uploads = new UploadsService(
			this.context,
			this.uploadState,
			this.narInfoObjects,
			this.deletionQueue,
			this.reconcileQueue,
			this.retention,
			this.roots
		);
		this.commitPipeline = new CommitPipelineService(
			this.context,
			this.cacheAdmin,
			this.signingKeys,
			this.uploadState,
			this.narInfoObjects,
			this.retention
		);
		this.verification = new VerificationService(
			this.context,
			this.commitPipeline,
			this.deletionQueue,
			this.narInfoObjects,
			this.uploadState,
			this.retention,
			(cache, storePathHash) => {
				this.roots.pruneRetentionTargets(cache, storePathHash);
			}
		);
		this.offboarding = new OffboardingService(this.context);
		this.maintenanceEligibility = new MaintenanceEligibilityService(
			this.context
		);
		this.commitCredit = new CommitCreditService(this.context);

		// Parked commit sockets answer keepalive pings without waking the
		// hibernated object.
		ctx.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair('ping', 'pong')
		);

		this.routes();
	}

	private routes(): void {
		this.app.onError(serverErrorHandler);

		// Seed the request logger before any gate or route runs, so a fault refused
		// before it matches a route is still logged with the request's fields.
		this.app.use(loggerMiddleware);

		// An unconfigured Durable Object has no identity to issue, verify or
		// advertise under, so every request that reaches this app is refused with
		// `TenantNotConfiguredError`. The guard sits on the `fetch` path only: the
		// control plane's `configure` RPC, which assigns the identity, is a method
		// call and does not pass through here.
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
					context: {
						request: context.req.raw,
						services: this.rpcServices(),
						logger: context.get('logger')
					}
				}
			);

			if (isMatched) {
				const pathname = new URL(context.req.url).pathname;
				const isUploadGraceEndpoint =
					context.req.method === 'POST' &&
					(/^\/cache\/[^/]+\/uploads$/.test(pathname) ||
						/^\/cache\/[^/]+\/uploads\/preview$/.test(pathname));

				if (
					isUploadGraceEndpoint &&
					hasAcceptedCapability(context.req.raw, uploadGraceFactsCapability)
				) {
					const headers = new Headers(response.headers);
					headers.set(uploadCapabilitiesHeader, uploadCapabilitiesValue);

					return new Response(response.body, {
						status: response.status,
						statusText: response.statusText,
						headers
					});
				}

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

		// Every answer under /reuse is no-store, the faults included: corrupt
		// stored rows and shared-fact failures surface as thrown errors here,
		// and a cached error would outlive its repair exactly as a cached miss
		// would outlive the next commit. The handlers set the header on their
		// own responses; this renders the thrown ones through the same mapping
		// as the app's error handler and stamps whatever leaves the route.
		const renderError: (
			error: Error,
			context: Context<TenantHonoEnv>
		) => Response | Promise<Response> = serverErrorHandler;

		this.app.use(
			'/reuse/*',
			createMiddleware<TenantHonoEnv>(async (context, next) => {
				try {
					await next();
				} catch (error) {
					context.res = await renderError(
						error instanceof Error ? error : new Error(String(error)),
						context
					);
				}

				context.res.headers.set('cache-control', 'no-store');
			})
		);

		// A reuse view's nix-cache-info is rendered from its own stored priority.
		// Every response is no-store, the misses included: a cached 404 for an
		// unknown or unparseable view name would keep answering after the view
		// is created, and no purge key covers it.
		this.app.get('/reuse/:view/nix-cache-info', (context) => {
			const view = reuseViewNameSchema.safeParse(context.req.param('view'));

			if (!view.success) {
				return reuseNotFound();
			}

			const body = this.reuseViews.cacheInfoBody(view.data);

			if (body === undefined) {
				return reuseNotFound();
			}

			return textResponse(context.req.raw, body, {
				'content-type': 'text/x-nix-cache-info; charset=utf-8',
				'cache-control': 'no-store'
			});
		});

		// A reuse-view narinfo lookup: the one read that enters the gate, because
		// it needs the definition-revision fence and the stored row fields. Both
		// the hit and the miss are `no-store`: the answer changes when the view
		// definition changes, a source cache commits a conflicting candidate, or
		// a candidate is collected, and no purge key covers any of that.
		this.app.get(
			String.raw`/reuse/:view/:name{[0-9a-z]+\.narinfo}`,
			async (context) => {
				const view = reuseViewNameSchema.safeParse(context.req.param('view'));
				const storePathHash = parseNarInfoName(context.req.param('name') ?? '');

				if (storePathHash === undefined || !view.success) {
					return reuseNotFound();
				}

				const narInfo = await this.reuseLookup.lookup(
					context.get('logger'),
					view.data,
					storePathHash
				);

				if (narInfo === undefined) {
					return reuseNotFound();
				}

				return textResponse(context.req.raw, narInfo.render(), {
					'content-type': 'text/x-nix-narinfo; charset=utf-8',
					'cache-control': 'no-store'
				});
			}
		);

		this.app.post('/reuse/:view/api/v1/missing-paths', async (context) => {
			const request = await parseRequestBody(
				reuseViewAvailabilityRequestSchema,
				context.req.raw
			);
			const view = reuseViewNameSchema.safeParse(context.req.param('view'));
			const response: CacheAvailabilityResponse = {
				missingStorePathHashes: view.success
					? await this.reuseLookup.missingStorePathHashes(
							context.get('logger'),
							view.data,
							request.storePathHashes
						)
					: request.storePathHashes
			};

			return context.json(response, StatusCodes.OK, {
				'cache-control': 'no-store'
			});
		});

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
			const origin = requestOriginSchema.parse(new URL(context.req.url).origin);

			return context.json(this.authKeys.authorizationServerMetadata(origin));
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
	private async commitSession(
		request: Request,
		cache: StoredCache
	): Promise<Response> {
		if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
			throw new CommitUpgradeRequiredError();
		}

		// Credit is enforced only against a client that declared it understands
		// credit. A client that predates it paces itself by a fixed window of
		// messages, which the server releases per entry, so a large push of such
		// a client would routinely exceed any grant and be closed for overdrawing.
		// That is a capacity condition surfacing as a fatal error, which is what
		// credit exists to prevent, so those sessions are left unpaced and keep
		// the bound they have always had.
		//
		// This gate is transitional. Remove it, and admit every session under
		// credit, once no deployed client without the `commit-credit` capability
		// remains.
		const hasNegotiatedCredit = hasAcceptedCapability(
			request,
			commitCreditCapability
		);
		this.refuseCommitSessionPastBound(hasNegotiatedCredit);

		if (hasNegotiatedCredit) {
			// Read the tenant's budget before accepting anything. A misconfigured
			// value throws, and the socket an accept adds to `getWebSockets()`
			// outlives the upgrade that failed, so a deployment configured this way
			// would spend one socket of its ceiling on every dial. A session that
			// negotiates no credit never reads the budget.
			commitEntryCreditBudget(this.context.env);
		}

		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		const sessionId = sessionIdSchema.parse(crypto.randomUUID());

		this.ctx.acceptWebSocket(server, [sessionId]);
		const openingGrant = this.commitCredit.openSession(
			server,
			{ cache, sessionId },
			hasNegotiatedCredit,
			Date.now()
		);
		await this.armCommitSocketIdleClose();

		// Advertise the optional ops on the 101 so a capable client batches only
		// against a server that offered it; a server that does not list an op never
		// receives it. The credit token carries this session's opening grant, so a
		// credited client commits at once without asking for credit first.
		return new Response(undefined, {
			status: 101,
			webSocket: client,
			headers: {
				[commitCapabilitiesHeader]: hasNegotiatedCredit
					? commitCapabilitiesValueWithCredit(openingGrant)
					: commitCapabilitiesValue
			}
		});
	}

	// Refuses an upgrade the tenant has no room for. Counted before the accept,
	// while the refusal is still plain HTTP, so it reaches the client with the
	// retryable status, Retry-After and no-store through the ordinary error
	// handler. Parked hibernating sockets are live and count; a closed socket
	// leaves the set once its close event is handled.
	private refuseCommitSessionPastBound(hasNegotiatedCredit: boolean): void {
		const sockets = this.ctx.getWebSockets();
		const ceiling = commitSocketCeiling(this.context.env);

		if (sockets.length >= ceiling) {
			throw new CommitSessionLimitError(ceiling);
		}

		if (hasNegotiatedCredit) {
			return;
		}

		if (unpacedSessions(sockets) >= maxUncreditedCommitSessions) {
			throw new CommitSessionLimitError(maxUncreditedCommitSessions);
		}
	}

	// Keeps the idle close armed while the tenant holds a commit socket the close
	// can act on. The wake closes the sockets whose push has finished, rebuilds
	// the credit scheduler from the socket attachments and grants what the tenant
	// has free, so a tenant whose sessions all hold unspent credit always has
	// an event that resumes granting.
	//
	// Only a session the close could still act on earns that alarm. The close
	// leaves a session that never negotiated credit alone, and only a credited
	// session can be in the rotation waiting for a grant, so a tenant holding
	// nothing else would wake every idle period for a pass that can do nothing,
	// and a Durable Object is billed for the wake.
	private async armCommitSocketIdleClose(): Promise<void> {
		if (!hasPacedSession(this.ctx.getWebSockets())) {
			return;
		}

		await armAlarmNoLaterThan(
			this.ctx.storage,
			Date.now() + commitSocketIdleMs
		);
	}

	// Commits one upload over the session and replies with a per-id frame. The
	// socket stays open: a deferred upload's verdict arrives later over the same
	// connection, and other ids keep committing. An error fails just this id. A
	// batched entry carries the path identity from negotiation, so a row already
	// gone (a re-sent entry whose reply was lost on a drop) resolves against the
	// path's narinfo row; the lost reply is not an error.
	private async runSessionCommit(
		sessionLogger: Logger,
		socket: WebSocket,
		cache: StoredCache,
		sessionId: SessionId,
		uploadId: UploadId,
		identity?: Pick<
			ParsedCommitBatchEntry,
			'storePathHash' | 'narHash' | 'retention'
		>,
		advisory?: {
			readonly prefetched?: PrefetchedMaterialisationFacts;
			readonly account?: TenantAccount;
		}
	): Promise<void> {
		try {
			// Record the session before the commit can defer, so a verdict reached
			// before this returns still routes here.
			this.uploadState.attachSession(uploadId, sessionId);

			const outcome = await this.metered('commit', (logger) =>
				this.afterHotMutation(() =>
					this.commitPipeline.commit(logger, cache, uploadId, advisory)
				)
			);

			if (outcome.kind === 'settled') {
				sendCommitSessionFrame(socket, {
					ev: 'settled',
					uploadId,
					response: outcome.response,
					...(outcome.grace !== undefined && { grace: outcome.grace })
				});

				return;
			}

			sendCommitSessionFrame(socket, {
				ev: 'deferred',
				uploadId,
				storePathHash: outcome.storePathHash,
				narHash: outcome.narHash,
				...(outcome.grace !== undefined && { grace: outcome.grace })
			});
		} catch (error) {
			if (identity !== undefined && error instanceof UploadNotFoundError) {
				await this.resolveGoneCommit(socket, cache, uploadId, identity);
				return;
			}

			if (isD1Overload(error)) {
				const overload = new DatabaseOverloadedError(error);
				sendCommitSessionFrame(socket, {
					ev: 'error',
					uploadId,
					status: overload.status,
					message: overload.message
				});
				return;
			}

			// A ServerHttpError carries a client-facing message; anything else is an
			// internal fault whose detail must not leak over the socket, matching the
			// platform 500 the HTTP error handler rethrows to.
			const isKnown = error instanceof ServerHttpError;

			if (!isKnown) {
				// The frame carries no detail, so this log line is the only record
				// of what actually failed.
				sessionLogger
					.with({ uploadId })
					.error('commit failed with an internal fault', { error });
			}

			sendCommitSessionFrame(socket, {
				ev: 'error',
				uploadId,
				status: isKnown ? error.status : StatusCodes.INTERNAL_SERVER_ERROR,
				message: isKnown ? error.message : 'internal error'
			});
		}
	}

	// Answers a batched commit whose pending row is gone. The pending row may be
	// absent because verification committed the upload (the expected case on a
	// reconnect re-send), or because the reaper deleted an unanswered expired row
	// before the client ever received a reply. The path's narinfo row holding the
	// same narHash, carrying a committed reference edge and passing the shared
	// servability predicate confirms the upload reached a servable state; anything
	// else re-drives the client with `absent`.
	// The pending row's captured grace decision is gone along with the row, and
	// with it every durable proof that this session negotiated the upload, so a
	// `retention`-marked entry (a client that accepted grace facts for this
	// upload) is answered with the path's stored fact and nothing is extended:
	// extending retention on a path the session did not push is upload:confirm
	// authority, which a commit socket must not exercise on an uploadId it
	// merely names. An unmarked entry gets the legacy shape, matching a legacy
	// publication.
	private async resolveGoneCommit(
		socket: WebSocket,
		cache: StoredCache,
		uploadId: UploadId,
		identity: Pick<
			ParsedCommitBatchEntry,
			'storePathHash' | 'narHash' | 'retention'
		>
	): Promise<void> {
		const servable = await this.narInfoObjects.servableNarInfoVersions(cache, [
			identity.storePathHash
		]);
		const proven = servable.get(identity.storePathHash);

		if (proven?.narHash === identity.narHash) {
			const committed = await this.narInfoObjects.committedNarInfoRow(
				cache,
				identity.storePathHash
			);

			if (
				committed?.generation !== proven.generation ||
				committed.narHash !== proven.narHash
			) {
				sendCommitSessionFrame(socket, {
					ev: 'verdict',
					uploadId,
					status: 'absent'
				});

				return;
			}
			sendCommitSessionFrame(socket, {
				ev: 'settled',
				uploadId,
				response: {
					storePathHash: identity.storePathHash,
					narHash: identity.narHash,
					status: 'already-present'
				},
				...(identity.retention === true && {
					grace: storedGraceFact(
						this.context.db,
						cache,
						committed.storePathHash
					)
				})
			});

			return;
		}

		sendCommitSessionFrame(socket, {
			ev: 'verdict',
			uploadId,
			status: 'absent'
		});
	}

	// Replays one still-present pending row to a reconnected session: reject a
	// row from another cache, re-point the row at this socket so a verdict from
	// here on routes to it, then re-emit `deferred` for a row still awaiting its
	// verdict or replay the terminal verdict. Shared by both subscribe ops, which
	// differ only in how they answer a row that is gone.
	private replaySubscribedRow(
		socket: WebSocket,
		cache: StoredCache,
		sessionId: SessionId,
		uploadId: UploadId,
		row: typeof schema.pendingUploads.$inferSelect
	): void {
		if (row.cache !== cache) {
			sendCommitSessionFrame(socket, {
				ev: 'error',
				uploadId,
				status: StatusCodes.NOT_FOUND,
				message: 'unknown upload'
			});
			return;
		}

		this.uploadState.attachSession(uploadId, sessionId);
		const status = uploadStatusOf(row);
		// The grace fact replays only for an upload that accepted grace facts,
		// keeping a legacy upload's frames on the legacy shape.
		const graceDecision = parseStoredGraceDecision(row.graceDecisionJson);

		if (status === 'pending') {
			const metadata = parseStoredUploadPathMetadata(
				uploadId,
				row.metadataJson
			);
			sendCommitSessionFrame(socket, {
				ev: 'deferred',
				uploadId,
				storePathHash: metadata.storePathHash,
				narHash: metadata.narHash,
				...(graceDecision?.reportsGrace === true && {
					grace: capturedGraceFact(graceDecision)
				})
			});
			return;
		}

		sendCommitSessionFrame(socket, {
			ev: 'verdict',
			uploadId,
			status,
			...(graceDecision?.reportsGrace === true && {
				grace:
					status === 'servable'
						? storedGraceFact(
								this.context.db,
								row.cache,
								parseStoredUploadPathMetadata(uploadId, row.metadataJson)
									.storePathHash
							)
						: {}
			})
		});
	}

	// Re-attaches a reconnected session to ids still outstanding and replays each
	// one's current durable state. A gone row answers `servable`: with only a bare
	// id the settle's outcome cannot be told apart, and a committed path is the
	// common clear. A client that holds the path identity resolves a gone row
	// precisely through the `subscribe-identity` op instead.
	private replaySubscribe(
		socket: WebSocket,
		cache: StoredCache,
		sessionId: SessionId,
		uploadIds: readonly UploadId[]
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

			this.replaySubscribedRow(socket, cache, sessionId, uploadId, row);
		}
	}

	// Re-attaches a reconnected session to identity-carrying entries. An entry
	// whose pending row still exists replays exactly as `subscribe` does; one
	// whose row is gone resolves through the same committed-reference check as
	// `resolveGoneCommit`, so a row that cleared because verification committed
	// the path answers `already-present` and any other absence (a reaped row, a
	// path now holding other bytes) answers `absent`.
	private async replaySubscribeIdentity(
		socket: WebSocket,
		cache: StoredCache,
		sessionId: SessionId,
		entries: readonly ParsedCommitBatchEntry[]
	): Promise<void> {
		for (const entry of entries) {
			const { uploadId } = entry;
			const row = this.context.db
				.select()
				.from(schema.pendingUploads)
				.where(eq(schema.pendingUploads.id, uploadId))
				.get();

			if (row === undefined) {
				await this.resolveGoneCommit(socket, cache, uploadId, entry);
				continue;
			}

			this.replaySubscribedRow(socket, cache, sessionId, uploadId, row);
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
			reuseViews: this.reuseViews,
			oidcTrust: this.oidcTrust,
			stats: this.stats,
			integrityCheck: this.integrityCheck,
			roots: this.roots,
			deletionQueue: this.deletionQueue,
			runGarbageCollection: (logger, cache, purgeOrigin) =>
				this.collectGarbageInteractive(logger, cache, purgeOrigin),
			uploads: this.uploads,
			attestations: this.attestations,
			runVerification: (logger, purgeOrigin, limit) =>
				this.verifyInteractive(logger, purgeOrigin, limit)
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
	private pendingCache(id: string): Promise<StoredCache | undefined> {
		const uploadId = uploadIdSchema.parse(id);
		const upload = this.context.db
			.select({ cache: schema.pendingUploads.cache })
			.from(schema.pendingUploads)
			.where(eq(schema.pendingUploads.id, uploadId))
			.get();

		if (upload !== undefined) {
			return Promise.resolve(upload.cache);
		}

		const attestation = this.context.db
			.select({ cache: schema.pendingAttestations.cache })
			.from(schema.pendingAttestations)
			.where(eq(schema.pendingAttestations.id, uploadId))
			.get();

		return Promise.resolve(attestation?.cache);
	}

	// Runs a body and reconciles the maintenance-eligibility projection
	// synchronously after it, invalidating first so a crash anywhere in the body
	// leaves the tenant due (fail-open). The cron maintenance passes use this: a
	// crash during a pass must not leave a stale not-due row behind. The mutating
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
	// `tenant-verify` queue message, so it does not wait for the cron pass. The
	// other kinds of work do wait for it: a queued narinfo deletion that is now
	// due, or a deferred deadline (upload or attestation expiry, retention-root
	// TTL, auth-key retirement). They run on the first cron tick that reads the
	// published wake time as due. The reconcile publishes through a single
	// conditional upsert that writes only when the wake time moves, so a push of
	// many paths costs one write.
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
	// maintenance batch's staleness limit bounds how long the stale projection can
	// suppress maintenance, the same backstop the synchronous reconcile's eviction
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
		// overwrite a fresher one. A failed reconcile would leave a stale
		// projection that can suppress maintenance until the staleness limit, so
		// drop the row instead and let the periodic maintenance batch read the
		// tenant as due (fail-open).
		try {
			await this.maintenanceEligibility.reconcile();
		} catch {
			await this.invalidateMaintenanceEligibility();
		}
	}

	// Drops the maintenance-eligibility projection so the periodic maintenance batch
	// reads the tenant as due and reconciles on its next tick. Fail-open: if the
	// delete also fails, the batch's staleness limit still bounds the delay.
	private async invalidateMaintenanceEligibility(): Promise<void> {
		try {
			await this.maintenanceEligibility.invalidate();
		} catch {
			// The maintenance batch's staleness limit is the backstop.
		}
	}

	// Runs a direct RPC entrypoint (one that bypasses `fetch`) inside its own
	// request cost meter, so the Durable Object rows it reads are logged like an
	// HTTP request's. The row-heavy maintenance passes arrive as direct RPCs, so
	// they all run through here.
	private metered<T>(
		method: MeteredMethod,
		body: (logger: Logger) => Promise<T>
	): Promise<T> {
		const logger = rootLogger().with({ method });

		return withSpan('tenant-rpc', { method }, () =>
			withRequestCost(
				() => body(logger),
				(cost) => {
					logMethodFinished(logger, cost);
				}
			)
		);
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

		// The default cache always exists in the registry so its priority is
		// resolved the same way as a named cache's. Idempotent across restarts.
		this.context.db
			.insert(schema.caches)
			.values({
				name: DEFAULT_CACHE,
				priority: cachePrioritySchema.parse(CacheInfo.default.priority),
				createdAt: isoTimestamp(new Date())
			})
			.onConflictDoNothing()
			.run();

		this.oidcTrust.seedOwnerRule();

		// Migration and seeding run before the first request opens its meter, so their
		// rows land on no per-request line. Surface them once as the cold-start cost.
		this.context.dbCost.settle();
		logMethodFinished(rootLogger().with({ method: 'initialise' }), {
			rowsRead: this.context.dbCost.rowsRead - rowsReadBefore,
			rowsWritten: this.context.dbCost.rowsWritten - rowsWrittenBefore
		});
	}

	// Serialises maintenance passes of one kind: a caller registers its own
	// completion marker as the kind's tail before awaiting the previous tail, then
	// runs its body and returns or throws its result. The chain never rejects,
	// because each link resolves its marker in the `finally`, so a failing body
	// surfaces only to its own caller and the next link still runs.
	private async runExclusiveMaintenance<T>(
		kind: MaintenanceKind,
		body: () => Promise<T>
	): Promise<T> {
		const previous = this.maintenanceChains.get(kind);
		const { promise, resolve } = Promise.withResolvers<undefined>();
		this.maintenanceChains.set(kind, promise);

		if (previous !== undefined) {
			await previous;
		}

		try {
			return await body();
		} finally {
			resolve(undefined);

			if (this.maintenanceChains.get(kind) === promise) {
				this.maintenanceChains.delete(kind);
			}
		}
	}

	// The cron entrypoints coalesce through this: while a cron-driven pass of a
	// kind is queued or running, a further cron tick for that kind returns at once
	// rather than queuing a second. Dropping a tick is safe, since each pass arms
	// its own continuation for leftover work and the next tick picks the tenant up
	// again.
	private async runCoalescedCronMaintenance(
		kind: MaintenanceKind,
		body: () => Promise<void>
	): Promise<void> {
		if (this.cronMaintenanceQueued.has(kind)) {
			return;
		}

		this.cronMaintenanceQueued.add(kind);

		try {
			await this.runExclusiveMaintenance(kind, body);
		} finally {
			this.cronMaintenanceQueued.delete(kind);
		}
	}

	// One bounded collection pass. It records a continuation and arms an immediate
	// alarm when either there is likely more to collect (the pass stopped at the
	// cap) or a capped narinfo-deletion backlog is still queued, so the remaining
	// paths and deletions drain across firings. The gate is free between firings, so
	// push requests interleave while the backlog drains across chunks, and each
	// chunk holds the gate only for its own deletes. The scope and cap are
	// persisted so the alarm resumes the same work with the bound it started with.
	private async collectGarbageOnce(
		collectLimit: number = maxPathsCollectedPerRun,
		cache?: StoredCache
	): Promise<void> {
		const continuation = garbageCollectionContinuation(cache, collectLimit);

		await this.runGarbagePass(
			() =>
				this.metered('garbage-collection', (logger) =>
					this.withMaintenanceEligibility(() =>
						this.garbageCollection.collectGarbage(
							logger,
							cache,
							undefined,
							collectLimit
						)
					)
				),
			continuation
		);
	}

	// Collection can commit a bounded expiry batch before later R2 or deletion
	// work fails. Every driver therefore re-arms the continuation on failure; a
	// successful pass settles it from the returned backlog facts.
	private async runGarbagePass(
		collect: () => Promise<GarbageCollectionOutcome>,
		continuation: GarbageCollectionContinuation
	): Promise<GarbageCollectionOutcome> {
		try {
			const outcome = await collect();
			await this.settleGarbageContinuation(outcome, continuation);

			return outcome;
		} catch (error) {
			await this.armGarbageContinuation(continuation);

			throw error;
		}
	}

	// Records or clears the garbage-collection continuation after a pass. It arms
	// an immediate alarm when the pass stopped at its cap or a capped
	// narinfo-deletion backlog is still queued, so the leftover paths and deletions
	// drain across firings; otherwise it clears the marker. Shared by the cron
	// pass and the interactive path.
	private async settleGarbageContinuation(
		outcome: GarbageCollectionOutcome,
		continuation: GarbageCollectionContinuation
	): Promise<void> {
		const hasMoreToDrain =
			outcome.hasMoreWork || this.deletionQueue.hasQueuedNarInfoDeletions();

		await (hasMoreToDrain
			? this.armGarbageContinuation(continuation)
			: this.clearGarbageContinuation(continuation));
	}

	// The interactive garbage-collection pass the admin oRPC procedure reaches. It
	// serialises against the cron pass and the alarm resume through the same 'gc'
	// chain and arms the continuation the same way, so a manual run that hits the
	// per-run cap drains its remainder across alarm firings too. The metering and
	// eligibility reconcile the cron pass runs inline are supplied instead by the
	// request meter and the oRPC maintenance hook the interactive request carries.
	private collectGarbageInteractive(
		logger: Logger,
		cache: StoredCache | undefined,
		purgeOrigin: RequestOrigin | undefined
	): Promise<GarbageCollectionOutcome> {
		return this.runExclusiveMaintenance('gc', () =>
			this.runGarbagePass(
				() => this.garbageCollection.collectGarbage(logger, cache, purgeOrigin),
				garbageCollectionContinuation(cache, maxPathsCollectedPerRun)
			)
		);
	}

	// The interactive verification pass the admin oRPC procedure reaches. It
	// serialises against the cron verify pass through the same 'verify' chain and
	// shares the deferred-verify guard reset: the pass claims the pending rows, so
	// a deferral after it starts must request its own pass.
	private verifyInteractive(
		logger: Logger,
		purgeOrigin: RequestOrigin | undefined,
		limit: number
	): Promise<VerifyReport> {
		return this.runExclusiveMaintenance('verify', () => {
			this.commitPipeline.onVerificationPassStarted();

			return this.verification.verify(logger, purgeOrigin, limit);
		});
	}

	private async armGarbageContinuation(
		continuation: GarbageCollectionContinuation
	): Promise<void> {
		const pending = parseGarbageCollectionContinuations(
			await this.ctx.storage.get(gcContinuationKey)
		);
		await this.ctx.storage.put(
			gcContinuationKey,
			mergeGarbageCollectionContinuation(pending, continuation)
		);
		await this.ctx.storage.setAlarm(Date.now());
	}

	private async clearGarbageContinuation(
		continuation: GarbageCollectionContinuation
	): Promise<void> {
		const pending = parseGarbageCollectionContinuations(
			await this.ctx.storage.get(gcContinuationKey)
		);
		const remaining =
			continuation.scope === 'tenant'
				? []
				: pending.filter(
						(candidate) =>
							candidate.scope !== 'cache' ||
							candidate.cache !== continuation.cache
					);

		if (remaining.length === 0) {
			await this.ctx.storage.delete(gcContinuationKey);
			return;
		}

		await this.ctx.storage.put(gcContinuationKey, remaining);
		await this.ctx.storage.setAlarm(Date.now());
	}

	// Resumes a garbage-collection pass that stopped at its per-run cap. A run
	// that did not stop at the cap left no continuation, so this is a no-op.
	private async resumeGarbageCollection(): Promise<void> {
		const pending = parseGarbageCollectionContinuations(
			await this.ctx.storage.get(gcContinuationKey)
		);

		// No continuation means no work: return without touching the chain, so an
		// idle alarm costs nothing and never queues behind a concurrent pass.
		if (pending.length === 0) {
			return;
		}

		await this.runExclusiveMaintenance('gc', async () => {
			// Re-read under the chain: a collection that ran while this pass waited
			// may have drained the marker, in which case there is nothing left to
			// resume.
			const continuation = parseGarbageCollectionContinuations(
				await this.ctx.storage.get(gcContinuationKey)
			)[0];

			if (continuation === undefined) {
				return;
			}

			await this.collectGarbageOnce(
				continuation.collectLimit,
				continuation.scope === 'cache' ? continuation.cache : undefined
			);
		});
	}

	// One bounded reconcile of the committed paths a recent negotiate queued. Like
	// the garbage-collection pass it holds the gate only for the chunk's
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

		await this.metered('reconcile', (logger) =>
			this.withMaintenanceEligibility(() =>
				this.verification.reconcileTargets(
					logger,
					queued.values().toArray(),
					origin
				)
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
	private async resumeVerifyBackstop(backstopLogger: Logger): Promise<void> {
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

		await this.metered('verify-backstop', (logger) =>
			this.withMaintenanceEligibility(() =>
				this.verification.settlePendingReuse(
					logger,
					verifyBackstopReuseSettleLimit
				)
			)
		);
		await this.commitPipeline.requestVerification(
			backstopLogger,
			this.context.requireTenant()
		);
	}

	async fetch(request: Request): Promise<Response> {
		await this.initialise();

		let status = StatusCodes.INTERNAL_SERVER_ERROR;
		const { pathname } = new URL(request.url);
		// Built once here, at the request boundary, for the cost line; the app's
		// middleware seeds an equivalent logger onto the Hono context for the routes.
		const logger = requestLogger(request);

		return withSpan(
			'tenant-request',
			{ 'http.request.method': request.method, 'url.path': pathname },
			() =>
				withRequestCost(
					async () => {
						// The context's env carries the bounded R2/D1/Cache bindings, so
						// every subrequest a route handler issues through `c.env` is bounded
						// structurally, for any handler, not by convention.
						const response = await this.app.fetch(request, this.context.env);
						status = response.status;

						return response;
					},
					(cost) => {
						logRequestFinished(logger, status, cost);
					}
				)
		);
	}

	// The cron reaches maintenance through these Durable Object RPC methods
	// rather than over HTTP, so no token is issued or exchanged. The `/gc` and
	// `/verify` routes run the same passes for manual use. Called this way they
	// cover every cache and skip the edge-cache purge, leaving stale edge
	// entries to the narinfo TTL and the orphan-blob grace window.
	async runGarbageCollection(collectLimit?: number): Promise<void> {
		await this.initialise();
		await this.runCoalescedCronMaintenance('gc', () =>
			this.collectGarbageOnce(collectLimit)
		);
	}

	// Drives the bounded background loops the single DO alarm carries: closing
	// idle commit sockets, reconciling the committed paths a recent negotiate
	// queued, resuming a cache teardown, the verify backstop, and finally
	// resuming a capped garbage collection. Each re-arms the alarm while it has
	// work left, so the backlogs converge across firings while the gate stays
	// free between them. Garbage collection resumes last so a queued gc pass,
	// which may wait behind an interactive or cron collection on the chain,
	// cannot stall the other resume loops. The idle close runs first: it is
	// cheap, and its wake is what a session waiting on credit depends on.
	override async alarm(): Promise<void> {
		await this.initialise();
		// The alarm is a top-level entrypoint, so it seeds the logger the resume
		// paths that log outside a metered block are threaded.
		const logger = rootLogger().with({ trigger: 'alarm' });
		this.commitCredit.closeIdleSessions(Date.now(), () =>
			this.uploadState.sessionsAwaitingVerdict()
		);
		await this.armCommitSocketIdleClose();
		await this.reconcileNegotiatedOnce();
		await this.resumeCacheTeardown();
		await this.resumeVerifyBackstop(logger);
		await this.resumeGarbageCollection();
	}

	// Starts a cache teardown directly, the manual/test entry that the `caches`
	// remove route reaches through `removeCache`. The optional limit caps the first
	// drain chunk so a test can force the over-cap, alarm-resumed path without
	// pushing a whole cap's worth of paths, mirroring {@link runGarbageCollection}.
	async runCacheTeardown(
		cache: StoredCache,
		origin: RequestOrigin,
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
		await this.runCoalescedCronMaintenance('verify', async () => {
			// This pass will claim the pending rows, so re-arm the prompt-verify
			// single-flight guard: a deferral after this point asks for its own pass.
			this.commitPipeline.onVerificationPassStarted();
			await this.metered('verification', (logger) =>
				this.withMaintenanceEligibility(async () => {
					await this.verification.verifyPendingUploads(
						logger,
						verificationBatchSize
					);
					await this.verification.verifyBatch(
						logger,
						undefined,
						verificationBatchSize
					);
				})
			);
		});
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
		const logger = rootLogger().with({ rpc: 'request-verification-pass' });
		await this.commitPipeline.requestVerification(
			logger,
			this.context.requireTenant()
		);
	}

	// Settles a whole batch of verdicts in one call, so the queue consumer reports
	// a pass with a single RPC into the DO. Returns how
	// many verdicts actually applied, so the consumer's continuation gates on real
	// progress.
	async recordVerifications(
		results: readonly VerificationResult[]
	): Promise<number> {
		await this.initialise();
		return this.metered('record-verifications', (logger) =>
			this.afterHotMutation(() =>
				this.verification.recordVerifications(logger, results)
			)
		);
	}

	async recordVerification(
		uploadId: UploadId,
		verification: NarVerification
	): Promise<void> {
		await this.initialise();
		await this.metered('record-verification', (logger) =>
			this.afterHotMutation(() =>
				this.verification.recordVerification(logger, uploadId, verification)
			)
		);
	}

	async recordMissingObject(uploadId: UploadId): Promise<void> {
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
		stagingKey: R2ObjectKey
	): Promise<MeasuredAttestationBundle> {
		await this.initialise();
		return this.attestationCas.measureStagedBundle(stagingKey);
	}

	async promoteAttestationBundle(
		stagingKey: R2ObjectKey,
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
		const attachment = readCommitSessionAttachment(socket);

		if (attachment === undefined) {
			socket.close(1011, 'missing session');
			return;
		}

		if (isSessionClosing(attachment)) {
			// The server closed this session and took its credit back. The socket
			// stays listed until the peer answers the close, so a message the client
			// sent before it read the close still arrives here; the server repeats
			// the close and runs nothing. Serving the message would commit
			// entries for a session that is gone, with every frame it answers
			// unsendable, and credit granted to the session again would never return
			// to the tenant: the idle close skips a session it has finished with,
			// and a peer that never answers its close fires no close event. The code
			// is 1001 rather than 1002 because this close is the server's own doing,
			// so the client may reconnect at once.
			socket.close(1001, 'closed');
			return;
		}

		const text =
			typeof message === 'string' ? message : new TextDecoder().decode(message);
		const parsed = commitSessionRequestSchema.safeParse(safeJsonParse(text));

		if (!parsed.success) {
			// A well-formed op this server does not know gets a per-message reply
			// naming it, so a newer client degrades gracefully; garbage (unparseable
			// JSON, or a known op with a broken shape) still closes the socket, since
			// it speaks for a client this session cannot trust.
			const unknown = unknownSessionOp(text);

			if (unknown !== undefined) {
				sendCommitSessionFrame(socket, { ev: 'unsupported', op: unknown });
				return;
			}

			socket.close(1002, 'invalid commit request');
			return;
		}

		const request = parsed.data;
		const { cache, sessionId } = attachment;

		if (request.op === 'request-credit') {
			const hasNegotiated = this.commitCredit.declareDemand(
				socket,
				attachment,
				request.entries,
				Date.now()
			);

			if (!hasNegotiated) {
				// This session was accepted without credit, so either the declaration
				// the client believes it made did not reach the upgrade, or the client
				// is speaking a protocol this session never agreed to. The answer is
				// the one an op this server does not know gets, which is a reply the
				// client already falls back from: it drops to its own window and
				// commits unpaced, which is what this session was accepted as.
				sendCommitSessionFrame(socket, {
					ev: 'unsupported',
					op: request.op
				});
			}

			return;
		}

		const decision = this.commitCredit.admitMessage(
			socket,
			attachment,
			commitEntryCount(request),
			Date.now()
		);

		// Both closes below reclaim first, in this same event. A socket the server
		// has closed stays listed until the client completes the handshake, so
		// waiting for the close event would leave the session's credit and its
		// rotation entry standing, and a grant could land on a socket that is on
		// its way out.
		if (decision === 'overdrawn') {
			// Credit is bound to the connection and the server hands out every unit
			// of it. This session has asked for credit and been answered, so it
			// knows what it holds, and a message naming more entries than that can
			// only be a client bug. 1002 is the close a client treats as final
			// rather than retrying.
			this.commitCredit.closeSession(sessionId, Date.now());
			socket.close(1002, 'commit credit exceeded');
			return;
		}

		if (decision === 'refused') {
			// Serving this message would take the session out of the credit
			// accounting, and the tenant already holds every unpaced session it
			// allows. 1013 tells the client to come back, which is what an upgrade
			// refused at the same bound tells it, so a client whose grant was lost
			// reconnects and negotiates again.
			this.commitCredit.closeSession(sessionId, Date.now());
			socket.close(1013, 'too many unpaced commit sessions');
			return;
		}

		// Each accounted entry returns its credit to the tenant as its first frame
		// is sent, which is the instant it stops occupying this object.
		const isAccounted = decision === 'accounted';

		if (request.op === 'commit') {
			// The socket message is a top-level entrypoint, so it seeds the logger the
			// commit path is threaded. The per-id op shares the batch entries' bound:
			// a client that speaks only this op fans one message per path, so without
			// a slot per commit a large push's burst of messages runs unbounded and
			// queues enough control-plane reads to make the database shed.
			const logger = rootLogger().with({ sessionId, cache, op: request.op });
			await this.commitEntrySemaphore.acquire();

			try {
				await this.runSessionCommit(
					logger,
					socket,
					cache,
					sessionId,
					request.uploadId
				);
			} finally {
				this.commitEntrySemaphore.release();

				if (isAccounted) {
					this.commitCredit.release(sessionId, Date.now());
				}
			}

			return;
		}

		if (request.op === 'commit-batch') {
			// Every entry answers its own frame: a failing commit answers that id
			// while its chunk-mates proceed, and the bounded concurrency keeps an
			// entry parked on the materialise flush from head-of-line-blocking the
			// rest. Concurrent settles share the flush gate, so a chunk lands in a
			// handful of combined charge batches.
			const logger = rootLogger().with({ sessionId, cache, op: request.op });

			// Prefetch the D1 probe facts and the tenant account once for the whole
			// message, so each entry's commit pays only its per-path R2 head and the
			// message's D1 reads stay bounded whatever its size. Both reads are
			// advisory: the charge batch remains the authoritative fence for status
			// and quota. A fault in either read degrades to per-entry fresh reads.
			const narHashes = request.commits.map((entry) => entry.narHash);
			let batchPrefetched:
				Map<string, PrefetchedMaterialisationFacts> | undefined;
			let batchAccount: TenantAccount | undefined;

			try {
				const [prefetched, account] = await Promise.all([
					this.commitPipeline.prefetchMaterialisationFacts(narHashes),
					this.commitPipeline.readTenantAccount()
				]);
				batchPrefetched = prefetched;
				batchAccount = account;
			} catch {
				// D1 fault: degrade to per-entry reads.
			}

			// The message was debited for every entry at once, and an entry returns
			// its own credit only if it runs: `mapWithConcurrency` starts none of
			// the entries behind one that rejects. Count what the entries returned
			// and return the rest here, so the tenant gets the whole message's
			// credit back however the message ends.
			let released = 0;
			const answered = new Set<UploadId>();

			try {
				await mapWithConcurrency(
					request.commits,
					maxOutgoingConnections,
					async (entry) => {
						await this.commitEntrySemaphore.acquire();

						try {
							await this.runSessionCommit(
								logger,
								socket,
								cache,
								sessionId,
								entry.uploadId,
								{
									storePathHash: entry.storePathHash,
									narHash: entry.narHash,
									retention: entry.retention
								},
								{
									prefetched: batchPrefetched?.get(entry.narHash),
									account: batchAccount
								}
							);
							answered.add(entry.uploadId);
						} finally {
							this.commitEntrySemaphore.release();

							if (isAccounted) {
								released += 1;
								this.commitCredit.release(sessionId, Date.now());
							}
						}
					}
				);
			} catch (error) {
				// A commit answers its own entry whatever the outcome, so a fault that
				// reaches here escaped one entry and stopped the entries behind it
				// from starting. Every entry the client is still waiting on is
				// answered retryably, so it re-sends them as soon as it reads the
				// frame instead of holding them until its own deadline expires. The
				// frames carry no detail of the fault, so this line is the only record
				// of what failed.
				logger.error('a commit batch failed outside an entry frame', { error });

				for (const entry of request.commits) {
					if (answered.has(entry.uploadId)) {
						continue;
					}

					sendCommitSessionFrame(socket, {
						ev: 'error',
						uploadId: entry.uploadId,
						status: StatusCodes.SERVICE_UNAVAILABLE,
						message: 'the commit batch stopped before this entry was answered'
					});
				}
			} finally {
				const abandoned = request.commits.length - released;

				if (isAccounted && abandoned > 0) {
					this.commitCredit.release(sessionId, Date.now(), abandoned);
				}
			}

			return;
		}

		if (request.op === 'subscribe-identity') {
			await this.replaySubscribeIdentity(
				socket,
				cache,
				sessionId,
				request.entries
			);
			return;
		}

		this.replaySubscribe(socket, cache, sessionId, request.uploadIds);
	}

	// A waiter that hangs up needs no bookkeeping of its own (the hibernation API
	// drops it from `getWebSockets`); closing our end completes the handshake.
	// Its credit is another matter, and goes back to the tenant here.
	webSocketClose(socket: WebSocket): void {
		reclaimCommitCredit(this.commitCredit, socket);
		socket.close();
	}

	webSocketError(socket: WebSocket): void {
		reclaimCommitCredit(this.commitCredit, socket);
		socket.close(1011, 'socket error');
	}
}

// A session's unspent credit goes back to the tenant as soon as its socket is
// gone, so the server never has to expire a grant or ask for one back.
function reclaimCommitCredit(
	credit: CommitCreditService,
	socket: WebSocket
): void {
	const attachment = readCommitSessionAttachment(socket);

	if (attachment === undefined) {
		return;
	}

	credit.closeSession(attachment.sessionId, Date.now());
}

// The entries one client message commits, which is what the session's credit is
// debited by. The subscribe ops re-attach to durable rows rather than commit
// anything, so they cost no credit and keep their own bounds.
function commitEntryCount(request: ParsedCommitSessionRequest): number {
	if (request.op === 'commit') {
		return 1;
	}

	if (request.op === 'commit-batch') {
		return request.commits.length;
	}

	return 0;
}

function safeJsonParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

// The ops this build's session schema knows, derived from the schema so the
// set cannot drift from it.
const knownSessionOps = new Set<string>(
	commitSessionRequestSchema.options.map((option) => option.shape.op.value)
);

// Distinguishes an op from a later protocol from a broken message: a JSON
// object naming an op outside this build's schema is the former and earns a
// per-message `unsupported` reply; anything else is the latter and closes the
// socket. Returns the unknown op's name, or undefined for garbage.
function unknownSessionOp(text: string): string | undefined {
	const body = safeJsonParse(text);

	if (typeof body !== 'object' || body === null || !('op' in body)) {
		return undefined;
	}

	const op = body.op;

	if (typeof op !== 'string' || knownSessionOps.has(op)) {
		return undefined;
	}

	return op;
}

// Emits a line when a request finishes, carrying its Durable Object SQLite cost
// among the fields. The DO is billed per row read, so surfacing rows read and
// written per request makes a row-heavy request observable in the logs rather
// than only on the daily bill. One DO backs one tenant, so the emitting object
// already identifies the tenant. The request logger already carries the method
// and path, so only the status and cost are added here. It is per-request
// telemetry, so it logs at `debug`.
function logRequestFinished(
	logger: Logger,
	status: number,
	cost: DatabaseCost
): void {
	logger.debug('request finished', {
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

// The same cost line for a direct RPC entrypoint (the maintenance passes,
// configure, the cold-start migration): no `fetch` runs, but the rows it reads
// are still worth surfacing. These fire far more often than HTTP requests, on
// every cron tick and every queue message, so this is the noisiest telemetry
// and logs at `trace`, off by default and enabled only when investigating cost.
function logMethodFinished(logger: Logger, cost: DatabaseCost): void {
	logger.trace('method finished', {
		rowsRead: cost.rowsRead,
		rowsWritten: cost.rowsWritten
	});
}
