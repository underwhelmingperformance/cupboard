import { type Logger } from '@cupboard/logger';
import {
	cacheNameSchema,
	type CacheScope,
	cacheScopeSchema,
	isSameCacheScope,
	type StorePathHash,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { zstdDecompressionStream } from '@cupboard/nix-store/zstd';
import {
	type CacheAvailabilityResponse,
	reuseViewAvailabilityRequestSchema
} from '@cupboard/protocol/cache-availability';
import {
	cachePredecessorLocalMigrationCeiling,
	cacheWriterEpoch
} from '@cupboard/protocol/cache-deployment-manifest';
import type {
	DataMigrationBudget,
	WriterEpoch
} from '@cupboard/protocol/deployment-manifest';
import type {
	R2CredentialCheck,
	VerifyReportInput
} from '@cupboard/protocol/reports';
import { reuseViewNameSchema } from '@cupboard/protocol/reuse-views';
import {
	type CommitBatchEntry,
	commitCapabilitiesHeader,
	commitCapabilitiesValue,
	commitCapabilitiesValueWithCredit,
	commitCreditCapability,
	type CommitSessionRequest,
	commitSessionRequestSchema,
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
import { and, asc, eq, gt, isNull, ne, or } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';

import migrations from '../../drizzle/migrations.js';
import { type NarVerification } from '../blob/nar-verify.ts';
import { readTenantReadVerifier } from '../control/tenant-membership.ts';
import {
	type CacheId,
	cacheScopeFromRow,
	type ResolvedCache
} from '../db/cache.ts';
import * as schema from '../db/schema.ts';
import { isD1Overload } from '../db/transient.ts';
import { deploymentManifest } from '../deployment-manifest.generated.ts';
import {
	CommitSessionLimitError,
	CommitUpgradeRequiredError,
	DatabaseOverloadedError,
	R2PresignConfigurationMissingError,
	ServerHttpError,
	SubrequestTimeoutError,
	TenantNotConfiguredError,
	UploadNotFoundError,
	ZstdUnavailableError
} from '../errors.ts';
import { hasAcceptedCapability } from '../http/capabilities.ts';
import { serverErrorHandler } from '../http/error-response.ts';
import {
	maxVerificationRpcRows,
	parseNarInfoName,
	parseNarName,
	type R2ObjectKey,
	type RequestOrigin,
	textResponse,
	verificationBatchSize
} from '../http/http.ts';
import { parseRequestBody, parseRequestValue } from '../http/parse.ts';
import {
	isCacheCatalogueComplete,
	isLocalCacheCatalogueComplete,
	markCacheCatalogueComplete,
	reconcileCacheCatalogue as reconcileStoredCacheCatalogue
} from '../migration/cache-access.ts';
import { reconcileLocalCacheIncarnations } from '../migration/cache-incarnation.ts';
import { advanceCacheRetentionMigration } from '../migration/cache-retention.ts';
import { runTenantLocalContractMigration } from '../migration/local-contract.ts';
import {
	loggerMiddleware,
	requestLogger,
	rootLogger
} from '../observability/logging.ts';
import { withSpan } from '../observability/span.ts';
import { authoriseRequest, noPendingCache } from '../orpc/authorise.ts';
import { type TenantRpcServices } from '../orpc/context.ts';
import { tenantOrpcHandler } from '../orpc/handler.ts';
import { commitEntryCreditBudget } from '../policy/commit-credit.ts';
import {
	commitSocketCeiling,
	maxUncreditedCommitSessions
} from '../policy/commit-sockets.ts';
import {
	guardPrivateViewRead,
	narAuthorityForView,
	serveNar
} from '../read/read.ts';

import {
	armAlarmNoLaterThan,
	type MaintenanceProgress,
	MaintenanceRetrySchedule,
	noProgressRetryMs
} from './alarm.ts';
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
import { CachePurgeQueueService } from './cache-purge-queue-service.ts';
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
	type GarbageCollectionTarget,
	ownerRuleId,
	type RuntimeEnv,
	ServerContext
} from './context.ts';
import {
	type DatabaseCost,
	withDataMigrationBudget,
	withRequestCost
} from './database-cost-meter.ts';
import { currentDeadlineSignal, withDeadlineBudget } from './deadline.ts';
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
	maintenancePassStatements,
	withMaintenanceEligibility
} from './maintenance-eligibility-service.ts';
import { ManagedCacheService } from './managed-cache-service.ts';
import {
	admitMigrationSource,
	applyMigrations,
	hasAppliedMigrationAfter,
	migrationsThrough,
	migrationsThroughTag
} from './migrate.ts';
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
import {
	type ResolvedReuseView,
	ReuseViewAdminService
} from './reuse-view-admin-service.ts';
import { ReuseViewLookupService } from './reuse-view-lookup-service.ts';
import { RootsService } from './roots-service.ts';
import {
	additiveLocalMigrationCeiling,
	configuredRuntimeStage,
	localMigrationCeiling
} from './runtime-stage.ts';
import { SigningKeysService } from './signing-keys-service.ts';
import { enterStatementAllowanceOnDispatch } from './statement-scope.ts';
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
	pendingSettlePrefetchStatements,
	type PendingVerification,
	type PendingVerificationBatch,
	statementsPerPendingSettleRow,
	type VerificationResult,
	VerificationService
} from './verification-service.ts';

const durableObjectMigrationDigests = new Map(
	deploymentManifest.durableObjectMigrations.map((migration) => [
		migration.id,
		migration.sha256
	])
);

const verificationClaimBoundSchema = z
	.number()
	.int()
	.positive()
	.max(maxVerificationRpcRows);

const verificationByteBoundSchema = z
	.number()
	.int()
	.positive()
	.max(Number.MAX_SAFE_INTEGER);

const verificationBudgetSchema = z
	.number()
	.int()
	.positive()
	.max(Number.MAX_SAFE_INTEGER);

const verificationRpcControlMarginMs = 10;

/**
 * The internal result of a budgeted verification claim RPC.
 */
export type VerificationClaimRpcResult =
	| {
			readonly kind: 'claimed';
			readonly batch: PendingVerificationBatch;
	  }
	| { readonly kind: 'timed-out' };

/**
 * The internal result of a budgeted verification record RPC.
 */
export type VerificationRecordRpcResult =
	| { readonly kind: 'recorded'; readonly applied: number }
	| { readonly kind: 'timed-out' };

const uploadGracePathPattern = /^(?:\/cache\/[^/]+)?\/uploads(?:\/preview)?$/u;

// Reuse misses must be `no-store`. A view update or commit can make the same
// lookup succeed, and no purge key covers the cached 404.
function reuseNotFound(): Response {
	return new Response('Not found\n', {
		status: StatusCodes.NOT_FOUND,
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'no-store'
		}
	});
}

// Persist incomplete garbage collection so alarms can drain a large backlog
// across bounded passes without holding the input gate continuously.
export const gcContinuationKey = 'maintenance:gc-pending';

// The maintenance pass run by the previous alarm. The next alarm resumes after
// it, which prevents a permanent backlog from starving other passes. The key
// sits outside every queue prefix.
export const maintenancePassCursorKey = 'maintenance:alarm-pass';

type MaintenancePassKey =
	| 'garbage-collection'
	| 'managed-cache-retirement'
	| 'reconcile'
	| 'signing-key-backfill'
	| 'teardown'
	| 'verdict-drain'
	| 'verify-backstop';

/**
 * One bounded background task an alarm can run.
 *
 * `hasWork` reads durable storage or local SQLite. The alarm therefore leaves
 * the complete D1 allowance for the selected pass. A pass is due after its retry
 * deadline and while work remains.
 *
 * The result from `run` determines the next retry deadline.
 */
interface MaintenancePass {
	readonly key: MaintenancePassKey;
	readonly hasWork: () => Promise<boolean>;
	readonly run: () => Promise<MaintenanceProgress>;
}

const garbageCollectionLimitSchema = z.number().int().positive();

const garbageCollectionContinuationSchema = z.discriminatedUnion('scope', [
	z.object({
		scope: z.literal('tenant'),
		collectLimit: garbageCollectionLimitSchema
	}),
	z.object({
		scope: z.literal('cache'),
		cache: cacheScopeSchema,
		collectLimit: garbageCollectionLimitSchema
	})
]);
const garbageCollectionContinuationsSchema = z
	.array(garbageCollectionContinuationSchema)
	.min(1);

type GarbageCollectionContinuation = z.infer<
	typeof garbageCollectionContinuationSchema
>;
type GarbageCollectionScope =
	| { readonly scope: 'tenant' }
	| { readonly scope: 'cache'; readonly cache: CacheScope };
const tenantGarbageCollectionScope: GarbageCollectionScope = {
	scope: 'tenant'
};

// Discard an unreadable continuation. The next collection pass will rediscover
// its backlog.
function parseGarbageCollectionContinuations(
	value: unknown
): GarbageCollectionContinuation[] {
	const parsed = garbageCollectionContinuationsSchema.safeParse(value);

	if (parsed.success) {
		return parsed.data;
	}

	const single = garbageCollectionContinuationSchema.safeParse(value);

	return single.success ? [single.data] : [];
}

function garbageCollectionContinuation(
	target: GarbageCollectionTarget,
	collectLimit: number
): GarbageCollectionContinuation {
	if (target.scope === 'tenant') {
		return { scope: 'tenant', collectLimit };
	}

	return { scope: 'cache', cache: target.cache.scope, collectLimit };
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
				candidate.scope !== 'cache' ||
				!isSameCacheScope(candidate.cache, continuation.cache)
		),
		continuation
	];
}

/**
 * How many deferred rows one backstop pass reads.
 *
 * The page reserves the same maximum cost for every row after subtracting the
 * page prefetch from the invocation's D1 allowance. This value is a page limit;
 * the D1 binding enforces the allowance during settlement. Unprocessed rows
 * remain pending, and the pass requests another verification run.
 */
export const verifyBackstopReuseSettleLimit = Math.floor(
	(maintenancePassStatements - pendingSettlePrefetchStatements) /
		statementsPerPendingSettleRow
);

type MaintenanceKind = 'gc' | 'verify';

class R2MetadataMigrationEmptyBatchError extends Error {
	constructor() {
		super('The R2 metadata migration produced an empty batch');
		this.name = 'R2MetadataMigrationEmptyBatchError';
	}
}

class UnsupportedProjectionRepairOperationError extends Error {
	constructor(public readonly operation: string) {
		super(`Unsupported projection repair operation: ${operation}`);
		this.name = 'UnsupportedProjectionRepairOperationError';
	}
}

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
	// Put the invocation's D1 allowance on every method the runtime can dispatch
	// to: a request, an alarm, an RPC, and any method added later. No dispatched
	// method can run without an allowance, and none has to remember to open the
	// allowance itself.
	static {
		enterStatementAllowanceOnDispatch(this.prototype);
	}

	private readonly app = new Hono<TenantHonoEnv>();

	private readonly maintenanceChains = new Map<
		MaintenanceKind,
		Promise<undefined>
	>();

	private readonly cronMaintenanceQueued = new Set<MaintenanceKind>();
	private migrationPromise: Promise<void> | undefined;

	private isReconcileDue = false;
	private reconcileDrain: Promise<void> | undefined;

	// Apply one concurrency bound across messages and entries within a batch.
	// Otherwise several simultaneous batches can exceed the intended tenant cap.
	private readonly commitEntrySemaphore = new CountingSemaphore(
		maxOutgoingConnections
	);

	// Credit limits parsed but unfinished entries. The semaphore separately
	// limits entries that are executing.
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
	private readonly managedCaches: ManagedCacheService;
	private readonly garbageCollection: GarbageCollectionService;
	private readonly tokenExchange: TokenExchangeService;
	private readonly uploads: UploadsService;
	private readonly commitPipeline: CommitPipelineService;
	private readonly verification: VerificationService;
	private readonly roots: RootsService;
	private readonly offboarding: OffboardingService;
	private readonly maintenanceEligibility: MaintenanceEligibilityService;
	private readonly maintenanceRetry: MaintenanceRetrySchedule;
	readonly context: ServerContext;

	constructor(ctx: DurableObjectState, env: RuntimeEnv) {
		super(ctx, env);
		this.context = new ServerContext(ctx, env);
		this.maintenanceRetry = new MaintenanceRetrySchedule(ctx.storage);

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
		this.signingKeys = new SigningKeysService(
			this.context,
			this.narInfoObjects
		);
		this.stats = new StatsService(this.context);
		this.oidcTrust = new OidcTrustService(this.context, this.tenantIdentity);
		this.retention = new RetentionService(this.context);
		this.reuseViews = new ReuseViewAdminService(this.context);
		this.reuseLookup = new ReuseViewLookupService(this.context);
		this.integrityCheck = new IntegrityCheckService(this.context);
		this.cacheAdmin = new CacheAdminService(this.context, this.deletionQueue);
		this.managedCaches = new ManagedCacheService(
			this.context,
			this.cacheAdmin,
			this.reuseViews
		);
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

		// Create the request logger before any guard runs so early failures retain
		// the request fields.
		this.app.use(loggerMiddleware);

		// Refuse HTTP access until the Durable Object has a tenant identity. The
		// control plane assigns that identity through RPC, which bypasses this guard.
		this.app.use(async (_context, next) => {
			if (this.tenantIdentity.current() === undefined) {
				throw new TenantNotConfiguredError();
			}

			await next();
		});

		// Resolve the cache from the path before any handler uses it. A bare path
		// addresses the default cache.
		this.app.use(async (context, next) => {
			context.set('cache', { kind: 'default' });
			await next();
		});
		this.app.use('/cache/:cacheName/*', async (context, next) => {
			context.set('cache', {
				kind: 'named',
				name: parseRequestValue(cacheNameSchema, context.req.param('cacheName'))
			});
			await next();
		});

		// Contract routes must run before the routes that handle raw
		// Request/Response, because the oRPC handler signals an unmatched request
		// by falling through.
		this.app.use(async (context, next) => {
			const { matched: isMatched, response } = await tenantOrpcHandler.handle(
				context.req.raw,
				{
					context: {
						request: context.req.raw,
						services: this.rpcServices(),
						cache: context.get('cache'),
						logger: context.get('logger')
					}
				}
			);

			if (isMatched) {
				response.headers.set('cache-control', 'no-store');
				const pathname = new URL(context.req.url).pathname;
				const isUploadGraceEndpoint =
					context.req.method === 'POST' &&
					uploadGracePathPattern.test(pathname);

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

		this.app.on(
			'GET',
			['/nix-cache-info', '/cache/:cacheName/nix-cache-info'],
			(context) =>
				textResponse(
					context.req.raw,
					this.cacheAdmin.cacheInfoBody(context.get('cache')),
					{
						'content-type': 'text/x-nix-cache-info; charset=utf-8'
					}
				)
		);

		// Apply `no-store` to thrown reuse errors as well as ordinary responses.
		// A shared cache must not retain a failure after its stored data is repaired.
		const renderError: (
			error: Error,
			context: Context<TenantHonoEnv>
		) => Response | Promise<Response> = serverErrorHandler;

		const uncachedReuseErrors = createMiddleware<TenantHonoEnv>(
			async (context, next) => {
				try {
					await next();
				} catch (error) {
					context.res = await renderError(
						error instanceof Error ? error : new Error(String(error)),
						context
					);
				}

				context.res.headers.set('cache-control', 'no-store');
			}
		);

		this.app.use('/reuse/*', uncachedReuseErrors);
		this.registerReuseViewRoutes();

		// `/token` uses the subject token as its credential. The Worker proxies the
		// JWKS route to this Durable Object.
		this.app.post('/token', (context) =>
			this.tokenExchange.handleToken(context.get('logger'), context.req.raw)
		);
		// Both key documents are served uncached so a rotation is visible across
		// colos at once.
		this.app.get('/.well-known/jwks.json', async (context) =>
			context.json({ keys: await this.authKeys.authPublicJwks() }, 200, {
				'cache-control': 'no-cache'
			})
		);
		this.app.get('/.well-known/oauth-authorization-server', (context) => {
			return context.json(
				this.authKeys.authorizationServerMetadata(),
				StatusCodes.OK,
				{
					'cache-control': 'public, max-age=3600'
				}
			);
		});

		// The upgrade authenticates a commit session. Its frames can request credit,
		// commit individual entries or batches, and subscribe to deferred verdicts.
		this.app.on(
			'GET',
			['/commit', '/cache/:cacheName/commit'],
			this.commitSessionGuard(),
			(context) =>
				this.commitSession(
					context.req.raw,
					context.get('cache'),
					context.get('claims').expiresAt
				)
		);
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

	// Every response is `no-store`: a view update, a source commit, or collection
	// can change both a hit and a miss, and no purge key covers those changes.
	private registerReuseViewRoutes(): void {
		const requestedView = (context: Context<TenantHonoEnv>) => {
			const name = reuseViewNameSchema.safeParse(context.req.param('view'));

			return name.success ? this.reuseViews.resolve(name.data) : undefined;
		};

		this.app.get('/reuse/:view/nix-cache-info', async (context) => {
			const view = requestedView(context);

			if (view === undefined) {
				return reuseNotFound();
			}

			const denied = await this.guardReuseViewRead(context.req.raw, view);

			if (denied !== undefined) {
				return denied;
			}

			return textResponse(
				context.req.raw,
				this.reuseViews.cacheInfoBody(view),
				{
					'content-type': 'text/x-nix-cache-info; charset=utf-8',
					'cache-control': 'no-store'
				}
			);
		});

		this.app.get(
			String.raw`/reuse/:view/:name{[0-9a-z]+\.narinfo}`,
			async (context) => {
				const view = requestedView(context);
				const storePathHash = parseNarInfoName(context.req.param('name') ?? '');

				if (view === undefined || storePathHash === undefined) {
					return reuseNotFound();
				}

				const denied = await this.guardReuseViewRead(context.req.raw, view);

				if (denied !== undefined) {
					return denied;
				}

				const narInfo = await this.reuseLookup.lookup(
					context.get('logger'),
					view.name,
					view.access,
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

		this.app.get('/reuse/:view/nar/:name', async (context) => {
			const view = requestedView(context);
			const nar = parseNarName(context.req.param('name'));

			if (view === undefined || nar === undefined) {
				return reuseNotFound();
			}

			const denied = await this.guardReuseViewRead(context.req.raw, view);

			if (denied !== undefined) {
				return denied;
			}

			const response = await serveNar(
				context.req.raw,
				context.env,
				this.context.requireTenant(),
				nar,
				narAuthorityForView(view.access, view.selectors),
				true
			);
			const current = requestedView(context);

			if (
				current?.revision !== view.revision ||
				current.access !== view.access
			) {
				return reuseNotFound();
			}

			return response;
		});

		this.app.post('/reuse/:view/api/v1/missing-paths', async (context) => {
			const request = await parseRequestBody(
				reuseViewAvailabilityRequestSchema,
				context.req.raw
			);
			const view = requestedView(context);

			if (view !== undefined) {
				const denied = await this.guardReuseViewRead(context.req.raw, view);

				if (denied !== undefined) {
					return denied;
				}
			}

			const response: CacheAvailabilityResponse = {
				missingStorePathHashes:
					view === undefined
						? request.storePathHashes
						: await this.reuseLookup.missingStorePathHashes(
								context.get('logger'),
								view.name,
								view.access,
								request.storePathHashes
							)
			};

			return context.json(response, StatusCodes.OK, {
				'cache-control': 'no-store'
			});
		});
	}

	private async guardReuseViewRead(
		request: Request,
		view: ResolvedReuseView
	): Promise<Response | undefined> {
		if (view.access === 'public') {
			return undefined;
		}

		const verifier = await readTenantReadVerifier(
			this.context.d1,
			this.context.requireTenant()
		);

		return guardPrivateViewRead(request, verifier);
	}

	// Authenticate the HTTP upgrade before creating a socket. Store the session
	// ID and cache on the accepted socket so verdict routing and cache scope
	// survive hibernation.
	private async commitSession(
		request: Request,
		cache: CacheScope,
		authenticatedUntil: Date
	): Promise<Response> {
		if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
			throw new CommitUpgradeRequiredError();
		}

		// Enforce credit only when the client negotiated it. Older clients pace
		// themselves with a fixed message window and would otherwise be closed for
		// exceeding a grant they do not understand.
		//
		// Remove this compatibility branch once every deployed client advertises
		// `commit-credit`.
		const hasNegotiatedCredit = hasAcceptedCapability(
			request,
			commitCreditCapability
		);
		this.refuseCommitSessionPastBound(hasNegotiatedCredit);

		if (hasNegotiatedCredit) {
			// Validate the credit budget before accepting the socket. A failed
			// upgrade after acceptance would leave the socket counted against the
			// tenant's connection limit.
			commitEntryCreditBudget(this.context.env);
		}

		this.context.cacheRepository.require(cache);

		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		const sessionId = sessionIdSchema.parse(crypto.randomUUID());

		this.ctx.acceptWebSocket(server, [sessionId]);
		const openingGrant = this.commitCredit.openSession(
			server,
			{ cache, sessionId, authenticatedUntil: authenticatedUntil.getTime() },
			hasNegotiatedCredit,
			Date.now()
		);
		await this.armCommitSocketClose();

		// Advertise optional operations on the upgrade response. The credit token
		// includes the opening grant so a negotiated client can commit immediately.
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

	// Check the connection limit before accepting the socket so refusal remains
	// a retryable HTTP response. Hibernating sockets count until their close event.
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

	// Arms the shared Durable Object alarm for the earliest access-token or idle
	// deadline. Every authenticated session has a token deadline. A paced session
	// also has an idle deadline so the alarm can reclaim its unused credit.
	private async armCommitSocketClose(): Promise<void> {
		const sockets = this.ctx.getWebSockets();
		const authenticationExpiry = this.commitCredit.nextAuthenticationExpiry();
		const idleExpiry = hasPacedSession(sockets)
			? Date.now() + commitSocketIdleMs
			: undefined;
		let nextClose = authenticationExpiry;

		if (
			idleExpiry !== undefined &&
			(nextClose === undefined || idleExpiry < nextClose)
		) {
			nextClose = idleExpiry;
		}

		if (nextClose === undefined) {
			return;
		}

		await armAlarmNoLaterThan(this.ctx.storage, nextClose);
	}

	// Fail only the affected upload and keep the session open for other entries.
	// An identity-bearing retry can resolve a missing pending row against the
	// current committed narinfo generation.
	private async runSessionCommit(
		sessionLogger: Logger,
		socket: WebSocket,
		cache: ResolvedCache,
		sessionId: SessionId,
		uploadId: UploadId,
		identity?: Pick<
			CommitBatchEntry,
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

			// Preserve client-facing errors, but never expose an internal exception
			// over the socket.
			const isKnown = error instanceof ServerHttpError;

			if (!isKnown) {
				sessionLogger
					.with({ uploadId })
					.error('commit failed with an internal error', { error });
			}

			sendCommitSessionFrame(socket, {
				ev: 'error',
				uploadId,
				status: isKnown ? error.status : StatusCodes.INTERNAL_SERVER_ERROR,
				message: isKnown ? error.message : 'internal error'
			});
		}
	}

	// A missing pending row can mean that verification published the upload or
	// that expiry removed it before the client received a reply. Report
	// `already-present` only when the supplied path and hash match the current
	// servable generation; otherwise report `absent`.
	//
	// The pending row also held the negotiated grace decision. If the entry uses
	// the retention-capable frame, report the path's stored grace without
	// extending it. Extending an arbitrary path would exercise `upload:confirm`
	// authority that a commit socket does not have. Keep the legacy frame shape
	// for an entry without the retention marker.
	private async resolveGoneCommit(
		socket: WebSocket,
		cache: ResolvedCache,
		uploadId: UploadId,
		identity: Pick<CommitBatchEntry, 'storePathHash' | 'narHash' | 'retention'>
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

	// Enforce cache isolation and attach the current session before replaying the
	// row's durable state. Both subscription forms use this path while the row
	// still exists.
	private replaySubscribedRow(
		socket: WebSocket,
		cache: ResolvedCache,
		sessionId: SessionId,
		uploadId: UploadId,
		row: typeof schema.pendingUploads.$inferSelect
	): void {
		if (row.cacheId !== cache.id) {
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
		// Include grace only when this upload negotiated grace reporting. Legacy
		// clients cannot parse the extended frame.
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
								cache,
								parseStoredUploadPathMetadata(uploadId, row.metadataJson)
									.storePathHash
							)
						: {}
			})
		});
	}

	// A missing row maps to `servable` for the legacy ID-only subscription because
	// no path identity remains to distinguish a committed upload from a reaped
	// one. Identity-aware clients use `subscribe-identity`.
	private replaySubscribe(
		socket: WebSocket,
		cache: ResolvedCache,
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

	// For a missing row, require the supplied identity to match the current
	// committed generation. This distinguishes a completed upload from expiry or
	// a later version of the same path.
	private async replaySubscribeIdentity(
		socket: WebSocket,
		cache: ResolvedCache,
		sessionId: SessionId,
		entries: readonly CommitBatchEntry[]
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
			managedCaches: this.managedCaches,
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

	// Authorise the session for `upload:commit` in its selected cache. Each upload
	// row is checked against the same cache before it can commit.
	private commitSessionGuard() {
		return createMiddleware<TenantHonoEnv>(async (context, next) => {
			const claims = await this.authKeys.authenticate(context.req.raw);
			const cache = context.get('cache');

			await authoriseRequest(
				claims,
				{ requires: 'upload:commit', resource: { cache: { fromPath: true } } },
				{},
				cache,
				noPendingCache
			);
			context.set('claims', claims);

			await next();
		});
	}

	private pendingCache(id: string): Promise<CacheScope | undefined> {
		const uploadId = uploadIdSchema.parse(id);
		const upload = this.context.db
			.select({ cacheId: schema.pendingUploads.cacheId })
			.from(schema.pendingUploads)
			.where(eq(schema.pendingUploads.id, uploadId))
			.get();

		if (upload !== undefined) {
			return Promise.resolve(
				this.context.cacheRepository.scopeForId(upload.cacheId)
			);
		}

		const attestation = this.context.db
			.select({ cacheId: schema.pendingAttestations.cacheId })
			.from(schema.pendingAttestations)
			.where(eq(schema.pendingAttestations.id, uploadId))
			.get();

		return Promise.resolve(
			attestation === undefined
				? undefined
				: this.context.cacheRepository.scopeForId(attestation.cacheId)
		);
	}

	// Invalidate eligibility before cron maintenance and reconcile it afterwards.
	// The leading invalidation keeps the tenant due if the pass is interrupted.
	// Mutating request paths reconcile only after the mutation.
	private async withMaintenanceEligibility<T>(
		body: () => Promise<T>
	): Promise<T> {
		return withMaintenanceEligibility(
			this.maintenanceEligibility,
			() => this.reconcileMaintenanceEligibility(),
			body
		);
	}

	// Reconcile in `finally` so a partial mutation cannot leave the old wake time
	// published. A hard isolate eviction can still interrupt this window. Deferred
	// verification has its queue request; deletion and time-based maintenance rely
	// on the projection's staleness backstop until the next scheduler tick.
	private async afterMutation<T>(body: () => Promise<T>): Promise<T> {
		try {
			return await body();
		} finally {
			await this.reconcileMaintenanceEligibility();
		}
	}

	// Do not delay a commit reply for eligibility publication. Concurrent hot-path
	// mutations share the same scheduled publication.
	private async afterHotMutation<T>(body: () => Promise<T>): Promise<T> {
		try {
			return await body();
		} finally {
			this.scheduleMaintenanceReconcile();
		}
	}

	// While a publication is in flight, collapse new requests onto one follow-up
	// that reads the final state of the burst. Instance eviction can drop this
	// work, so the scheduler's staleness limit remains the recovery path.
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
		// The conditional upsert prevents an older concurrent result from replacing
		// a newer wake time. On failure, delete the projection so maintenance remains
		// due.
		try {
			await this.maintenanceEligibility.reconcile();
		} catch {
			await this.invalidateMaintenanceEligibility();
		}
	}

	// Delete the projection to make the tenant due on the next scheduler tick. If
	// deletion also fails, the scheduler's staleness limit still bounds the delay.
	private async invalidateMaintenanceEligibility(): Promise<void> {
		try {
			await this.maintenanceEligibility.invalidate();
		} catch {
			// The scheduler's staleness limit bounds the delay if invalidation fails.
		}
	}

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

	private initialise(tenant?: TenantId): Promise<void> {
		this.migrationPromise ??= this.runInitialisation(tenant);

		return this.migrationPromise;
	}

	private async runInitialisation(tenant?: TenantId): Promise<void> {
		try {
			await this.migrateAndSeed(tenant);
		} catch (error: unknown) {
			this.migrationPromise = undefined;
			throw error;
		}
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

	private async migrateAndSeed(explicitTenant?: TenantId): Promise<void> {
		// The meter is cumulative and a purged object can initialise again. Measure
		// only this migration interval; its sole await does not access the database.
		this.context.dbCost.recordOutstanding();
		const rowsReadBefore = this.context.dbCost.rowsRead;
		const rowsWrittenBefore = this.context.dbCost.rowsWritten;

		const runtimeStage = configuredRuntimeStage(this.context.env);
		admitMigrationSource(
			this.context.db,
			migrationsThroughTag(migrations, cachePredecessorLocalMigrationCeiling),
			migrationsThrough(migrations, localMigrationCeiling(runtimeStage)),
			durableObjectMigrationDigests,
			cacheWriterEpoch
		);
		applyMigrations(
			this.context.db,
			migrationsThrough(migrations, additiveLocalMigrationCeiling),
			durableObjectMigrationDigests,
			{ enforceCeiling: false }
		);
		await this.assertZstdAvailable();

		const tenant = explicitTenant ?? this.tenantIdentity.current()?.tenant;

		if (tenant === undefined) {
			throw new TenantNotConfiguredError();
		}

		const isCatalogueComplete = await isCacheCatalogueComplete(
			this.context,
			tenant
		);

		if (!isCatalogueComplete || !isLocalCacheCatalogueComplete(this.context)) {
			await reconcileStoredCacheCatalogue(this.context, tenant);
		}

		await reconcileLocalCacheIncarnations(this.context, tenant);

		if (!isCatalogueComplete) {
			await markCacheCatalogueComplete(this.context, tenant);
		}

		await runTenantLocalContractMigration(
			this.context,
			tenant,
			() =>
				!hasAppliedMigrationAfter(
					this.context.db,
					migrations,
					additiveLocalMigrationCeiling
				),
			() => {
				applyMigrations(
					this.context.db,
					migrationsThrough(migrations, localMigrationCeiling(runtimeStage)),
					durableObjectMigrationDigests
				);
			}
		);

		this.oidcTrust.seedOwnerRule();

		this.context.dbCost.recordOutstanding();
		logMethodFinished(rootLogger().with({ method: 'initialise' }), {
			rowsRead: this.context.dbCost.rowsRead - rowsReadBefore,
			rowsWritten: this.context.dbCost.rowsWritten - rowsWrittenBefore
		});
	}

	// Resolve the chain marker even when a pass fails. The failure reaches its own
	// caller without preventing the next pass of the same kind from running.
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

	// Coalesce cron ticks while a pass of the same kind is queued or running. The
	// active pass republishes any remaining maintenance as due, and a later
	// scheduler tick returns. Garbage collection also persists its own continuation.
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

	// Persist the scope and cap while collection or narinfo deletion has more work.
	// The alarm resumes with the same bounds, leaving the input gate free for
	// requests between passes.
	private async collectGarbageOnce(
		collectLimit: number = maxPathsCollectedPerRun,
		scope: GarbageCollectionScope = tenantGarbageCollectionScope
	): Promise<void> {
		const target: GarbageCollectionTarget =
			scope.scope === 'tenant'
				? { scope: 'tenant' }
				: {
						scope: 'cache',
						cache: this.context.cacheRepository.require(scope.cache)
					};
		const continuation = garbageCollectionContinuation(target, collectLimit);

		await this.runGarbagePass(
			() =>
				this.metered('garbage-collection', (logger) =>
					this.withMaintenanceEligibility(() =>
						this.garbageCollection.collectGarbage(
							logger,
							target,
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
	// successful pass updates or clears it from the returned backlog state.
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

	// Use the same serial chain and durable continuation as cron and alarm-driven
	// collection. A bounded interactive pass must also resume through alarms.
	private collectGarbageInteractive(
		logger: Logger,
		target: GarbageCollectionTarget,
		purgeOrigin: RequestOrigin | undefined
	): Promise<GarbageCollectionOutcome> {
		return this.runExclusiveMaintenance('gc', () =>
			this.runGarbagePass(
				() =>
					this.garbageCollection.collectGarbage(logger, target, purgeOrigin),
				garbageCollectionContinuation(target, maxPathsCollectedPerRun)
			)
		);
	}

	// Share the cron verification chain and reset the queue-request guard before
	// this pass claims rows. A later deferral then requests another pass.
	//
	// Settlement and scanning share the invocation's D1 allowance. The requested
	// limit caps the page, and the remaining allowance determines the work
	// completed by this invocation.
	private verifyInteractive(
		logger: Logger,
		purgeOrigin: RequestOrigin | undefined,
		limit: number
	): Promise<VerifyReportInput> {
		return this.runExclusiveMaintenance('verify', () =>
			(async () => {
				this.commitPipeline.onVerificationPassStarted();
				await this.verification.processPendingWithoutDecode(logger, limit);

				if (this.verification.hasPendingUploads()) {
					await this.commitPipeline.requestVerification(
						logger,
						this.context.requireTenant()
					);
				}

				return this.verification.verifyBatch(logger, purgeOrigin, limit);
			})()
		);
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
							!isSameCacheScope(candidate.cache, continuation.cache)
					);

		if (remaining.length === 0) {
			await this.ctx.storage.delete(gcContinuationKey);
			return;
		}

		await this.ctx.storage.put(gcContinuationKey, remaining);
		await this.ctx.storage.setAlarm(Date.now());
	}

	private async resumeGarbageCollection(): Promise<void> {
		const stored = await this.ctx.storage.get(gcContinuationKey);
		const pending = parseGarbageCollectionContinuations(stored);

		// Do not enter the serial chain without a continuation. Delete a malformed
		// marker; the next collection pass will rediscover its backlog.
		if (pending.length === 0) {
			if (stored !== undefined) {
				await this.ctx.storage.delete(gcContinuationKey);
			}

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
				continuation.scope === 'cache'
					? { scope: 'cache', cache: continuation.cache }
					: { scope: 'tenant' }
			);
		});
	}

	// The alarm drains negotiated paths in bounded passes. That keeps the R2
	// probes off the push path and releases the input gate between passes. Clear
	// the keys of the targets the pass reconciled, leave the deferred ones
	// queued, and clear the origin only after the queue drains.
	//
	// Report a stall when every attempted target remains queued. The retry delay
	// then prevents a persistent probe or repair fault from running alarms back to
	// back.
	private async reconcileNegotiatedOnce(): Promise<MaintenanceProgress> {
		const queued = await this.reconcileQueue.claimChunk();

		if (queued.size === 0) {
			await this.reconcileQueue.clearOrigin();

			return 'progressed';
		}

		const origin = await this.reconcileQueue.origin();

		const deferred = await this.metered('reconcile', (logger) =>
			this.withMaintenanceEligibility(() =>
				this.verification.reconcileTargets(
					logger,
					queued.values().toArray(),
					origin
				)
			)
		);
		const deferredKeys = new Set(
			deferred.map((target) => this.reconcileQueue.entryKey(target))
		);
		const cleared = queued
			.keys()
			.filter((key) => !deferredKeys.has(key))
			.toArray();

		await this.reconcileQueue.clearKeys(cleared);

		if (!(await this.reconcileQueue.hasPending())) {
			await this.reconcileQueue.clearOrigin();

			return 'progressed';
		}

		if (cleared.length === 0) {
			return 'stalled';
		}

		await this.ctx.storage.setAlarm(Date.now());

		return 'progressed';
	}

	// Use this alarm when a verification queue request is lost. At the deadline,
	// resolve a bounded set of reuse rows that need no decoding, then request the
	// queue again. Fresh NAR decoding must stay off the Durable Object.
	// {@link armVerifyBackstopAlarm} handles a deadline that has not arrived.
	private async resumeVerifyBackstop(backstopLogger: Logger): Promise<void> {
		// The verdict drain owns rows with a recorded verdict. Exclude them from the
		// pending check used to maintain the verification backstop deadline.
		const awaitingVerdict = or(
			eq(schema.pendingUploads.verdict, 'pending'),
			eq(schema.pendingUploads.verdict, 'committing')
		);
		const pending = this.context.db
			.select({ id: schema.pendingUploads.id })
			.from(schema.pendingUploads)
			.where(
				and(awaitingVerdict, isNull(schema.pendingUploads.recordedVerdictJson))
			)
			.limit(1)
			.get();

		if (pending === undefined) {
			await this.ctx.storage.delete(verifyBackstopKey);
			return;
		}

		await this.metered('verify-backstop', (logger) =>
			this.withMaintenanceEligibility(() =>
				this.verification.processPendingWithoutDecode(
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

	// Settle decode-free rows within the invocation's D1 allowance, then build the
	// claim snapshot from the Durable Object's local SQLite database.
	//
	// Request another queue pass after settlement makes progress and claimable
	// rows remain. This continues decode-free reuse rows that were outside the
	// current allowance. The request also arms the backstop in case the queue
	// message is lost.
	private async claimVerificationBatchOperation(
		limit: number,
		maxNarBytes: number,
		onClaimed?: (batch: PendingVerificationBatch) => void
	): Promise<PendingVerificationBatch> {
		await this.initialise();
		// Claiming is the start of a pass: re-arm the prompt-verify guard before
		// taking the snapshot so a deferral after it triggers a fresh request.
		this.commitPipeline.onVerificationPassStarted();

		return this.metered('claim-verifications', (logger) =>
			(async () => {
				const signal = currentDeadlineSignal();
				signal?.throwIfAborted();
				const settled = await this.withMaintenanceEligibility(() =>
					this.verification.processPendingWithoutDecode(logger, limit, signal)
				);
				signal?.throwIfAborted();

				const batch = this.verification.listPendingForVerify(
					limit,
					maxNarBytes,
					signal
				);
				onClaimed?.(batch);

				if (settled > 0 && this.verification.hasPendingUploads()) {
					await this.commitPipeline.requestVerification(
						logger,
						this.context.requireTenant()
					);
				}

				return batch;
			})()
		);
	}

	private validateVerificationResults(
		results: readonly VerificationResult[]
	): void {
		if (results.length > maxVerificationRpcRows) {
			throw new RangeError(
				`A verification result batch may contain at most ${String(maxVerificationRpcRows)} entries.`
			);
		}
	}

	// The RPC stores every non-abandoned verdict on its upload row; an abandoned
	// verdict releases the lease locally. It then applies as many stored verdicts
	// as the allowance covers and arms the alarm when recorded verdicts remain.
	private recordVerificationsOperation(
		owner: string,
		results: readonly VerificationResult[]
	): Promise<number> {
		return this.metered('record-verifications', (logger) =>
			(async () => {
				const signal = currentDeadlineSignal();
				signal?.throwIfAborted();
				const applied = await this.withMaintenanceEligibility(() =>
					this.verification.recordVerifications(logger, owner, results, signal)
				);
				signal?.throwIfAborted();

				if (this.verification.hasRecordedVerdicts()) {
					await this.ctx.storage.setAlarm(Date.now());
				}

				return applied;
			})()
		);
	}

	// Apply the verdicts the upload rows are still holding. A pass that left the
	// queue no shorter failed on every verdict it tried, so it reports a stall
	// and waits before the next attempt.
	private async drainRecordedVerdicts(): Promise<MaintenanceProgress> {
		const before = this.verification.recordedVerdictCount();
		await this.metered('verdict-drain', (logger) =>
			this.withMaintenanceEligibility(() =>
				this.verification.applyRecordedVerdicts(logger)
			)
		);
		const remaining = this.verification.recordedVerdictCount();

		if (remaining === 0) {
			return 'progressed';
		}

		if (remaining >= before) {
			return 'stalled';
		}

		await this.ctx.storage.setAlarm(Date.now());

		return 'progressed';
	}

	/**
	 * The maintenance passes an alarm chooses between, in the order they take
	 * turns.
	 *
	 * Every `hasWork` callback reads durable storage or the local SQLite database.
	 * The selected pass receives the complete D1 allowance.
	 */
	private maintenancePasses(logger: Logger): readonly MaintenancePass[] {
		return [
			{
				key: 'reconcile',
				hasWork: () => this.reconcileQueue.hasPending(),
				run: () => this.reconcileNegotiatedOnce()
			},
			{
				key: 'teardown',
				hasWork: () => this.cacheAdmin.hasPendingTeardown(),
				run: async () => {
					await this.resumeCacheTeardown();

					return 'progressed';
				}
			},
			{
				key: 'verdict-drain',
				hasWork: () => Promise.resolve(this.verification.hasRecordedVerdicts()),
				run: () => this.drainRecordedVerdicts()
			},
			{
				key: 'verify-backstop',
				hasWork: () => this.isVerifyBackstopDue(),
				run: async () => {
					await this.resumeVerifyBackstop(logger);

					return 'progressed';
				}
			},
			{
				key: 'signing-key-backfill',
				hasWork: () => Promise.resolve(this.signingKeys.hasBackfillWork()),
				run: async () => {
					await this.signingKeys.runBackfillOnce();

					return 'progressed';
				}
			},
			{
				key: 'garbage-collection',
				hasWork: () => this.hasGarbageCollectionContinuation(),
				run: async () => {
					await this.resumeGarbageCollection();

					return 'progressed';
				}
			},
			{
				key: 'managed-cache-retirement',
				hasWork: () => this.managedCaches.hasLifecycleWork(),
				run: async () => {
					await this.withMaintenanceEligibility(() =>
						this.managedCaches.retireEligibleCaches(1)
					);

					return 'progressed';
				}
			}
		];
	}

	/**
	 * Runs the first due pass, starting after the pass in the alarm cursor,
	 * then arms the alarm for the next pass that will be due.
	 *
	 * Record the turn before running the pass. If the pass throws, the next alarm
	 * continues with another pass instead of leaving the cursor on the failure.
	 * Cloudflare retries a failed alarm handler.
	 */
	private async runOneMaintenancePass(logger: Logger): Promise<void> {
		const passes = this.maintenancePasses(logger);
		const start = await this.maintenancePassStart(passes);

		for (const pass of [...passes.slice(start), ...passes.slice(0, start)]) {
			const now = Date.now();
			const dueAt = await this.maintenancePassDueAt(pass, now);

			if (dueAt === undefined || dueAt > now) {
				continue;
			}

			await this.ctx.storage.put(maintenancePassCursorKey, pass.key);
			const progress = await pass.run();
			await this.recordMaintenanceProgress(pass.key, progress);
			break;
		}

		await this.armForMaintenancePasses(passes);
	}

	// A pass that stalled waits out its retry deadline and arms the alarm for it,
	// so the work it left behind is not stranded. A pass that progressed clears
	// its deadline and is due again at once.
	private async recordMaintenanceProgress(
		key: MaintenancePassKey,
		progress: MaintenanceProgress
	): Promise<void> {
		const now = Date.now();
		await this.maintenanceRetry.record(key, progress, now);

		if (progress === 'stalled') {
			await armAlarmNoLaterThan(this.ctx.storage, now + noProgressRetryMs);
		}
	}

	// Resume after the pass the previous alarm ran. An unrecognised or absent
	// cursor starts at the first pass.
	private async maintenancePassStart(
		passes: readonly MaintenancePass[]
	): Promise<number> {
		const previous = await this.ctx.storage.get<string>(
			maintenancePassCursorKey
		);
		const index = passes.findIndex((pass) => pass.key === previous);

		return index === -1 ? 0 : (index + 1) % passes.length;
	}

	// Returns when a pass with work may run. A pass without a retry deadline may
	// run now, while a stalled pass retains its recorded deadline.
	private async maintenancePassDueAt(
		pass: MaintenancePass,
		now: number
	): Promise<number | undefined> {
		if (!(await pass.hasWork())) {
			return undefined;
		}

		const notBefore = await this.maintenanceRetry.notBefore(pass.key);

		return notBefore === undefined || now >= notBefore ? now : notBefore;
	}

	/**
	 * Arms the shared alarm for the earliest maintenance pass that has work.
	 *
	 * Durable Object storage holds one alarm. Delivery clears that deadline, so
	 * a later deadline is not retained when an earlier alarm fires. Recompute the
	 * next wake from the durable retry records after every handler. A pass that
	 * is ready now takes precedence over every future deadline.
	 */
	private async armForMaintenancePasses(
		passes: readonly MaintenancePass[]
	): Promise<void> {
		const now = Date.now();
		let earliest: number | undefined;

		for (const pass of passes) {
			const dueAt = await this.maintenancePassDueAt(pass, now);

			if (dueAt === undefined) {
				continue;
			}

			earliest = earliest === undefined ? dueAt : Math.min(earliest, dueAt);

			if (earliest === now) {
				break;
			}
		}

		if (earliest !== undefined) {
			await armAlarmNoLaterThan(this.ctx.storage, earliest);
		}
	}

	// Preserve a future backstop deadline on every alarm. This uses durable
	// storage and does not consume a maintenance pass turn.
	private async armVerifyBackstopAlarm(): Promise<void> {
		const dueAt = await this.ctx.storage.get<number>(verifyBackstopKey);

		if (dueAt === undefined || Date.now() >= dueAt) {
			return;
		}

		await armAlarmNoLaterThan(this.ctx.storage, dueAt);
	}

	private async isVerifyBackstopDue(): Promise<boolean> {
		const dueAt = await this.ctx.storage.get<number>(verifyBackstopKey);

		return dueAt !== undefined && Date.now() >= dueAt;
	}

	private async hasGarbageCollectionContinuation(): Promise<boolean> {
		return (await this.ctx.storage.get(gcContinuationKey)) !== undefined;
	}

	private async advanceR2GenerationMetadataMigration(): Promise<{
		readonly outcome: 'complete' | 'pending';
	}> {
		const cursorKey = 'deployment-migration/cache-r2-generation-metadata';
		const cursor = await this.ctx.storage.get<{
			readonly cacheId: CacheId;
			readonly storePathHash: StorePathHash;
		}>(cursorKey);
		const afterCursor =
			cursor === undefined
				? undefined
				: or(
						gt(schema.narInfos.cacheId, cursor.cacheId),
						and(
							eq(schema.narInfos.cacheId, cursor.cacheId),
							gt(schema.narInfos.storePathHash, cursor.storePathHash)
						)
					);
		const rows = this.context.db
			.select({
				cacheId: schema.caches.id,
				kind: schema.caches.kind,
				name: schema.caches.name,
				access: schema.caches.access,
				generation: schema.caches.generation,
				readRevision: schema.caches.readRevision,
				storePathHash: schema.narInfos.storePathHash
			})
			.from(schema.narInfos)
			.innerJoin(schema.caches, eq(schema.caches.id, schema.narInfos.cacheId))
			.where(afterCursor)
			.orderBy(asc(schema.narInfos.cacheId), asc(schema.narInfos.storePathHash))
			.limit(32)
			.all();

		if (rows.length === 0) {
			await this.ctx.storage.delete(cursorKey);

			return { outcome: 'complete' };
		}

		for (const row of rows) {
			const cache: ResolvedCache = {
				id: row.cacheId,
				scope: cacheScopeFromRow({ kind: row.kind, name: row.name }),
				access: row.access,
				generation: row.generation,
				readRevision: row.readRevision
			};

			await this.narInfoObjects.ensureNarInfoObject(cache, row.storePathHash);
			await this.attestations.materialiseList(cache, row.storePathHash);
		}

		const last = rows.at(-1);

		if (last === undefined) {
			throw new R2MetadataMigrationEmptyBatchError();
		}

		await this.ctx.storage.put(cursorKey, {
			cacheId: last.cacheId,
			storePathHash: last.storePathHash
		});

		return { outcome: 'pending' };
	}

	async fetch(request: Request): Promise<Response> {
		await this.initialise();

		let status = StatusCodes.INTERNAL_SERVER_ERROR;
		const { pathname } = new URL(request.url);
		const logger = requestLogger(request);

		return withSpan(
			'tenant-request',
			{ 'http.request.method': request.method, 'url.path': pathname },
			() =>
				withRequestCost(
					async () => {
						// Route handlers receive only bounded storage bindings, so a new
						// handler cannot accidentally bypass the input-gate deadline.
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

	// Cron invokes these Durable Object RPC methods directly. The `/gc` and
	// `/verify` routes run the same passes for manual use. RPC passes cover every
	// cache and leave stale edge-cache entries to expire under the narinfo TTL and
	// orphan-blob grace window.
	async runGarbageCollection(collectLimit?: number): Promise<void> {
		await this.initialise();
		await this.runCoalescedCronMaintenance('gc', () =>
			this.collectGarbageOnce(collectLimit)
		);
	}

	/**
	 * One alarm drives every bounded background task.
	 *
	 * Close commit sessions first so their credit is returned, then arm owned
	 * deadlines and run queued cache purges. These operations use local or
	 * durable storage.
	 *
	 * The maintenance passes do reach D1. Workers Free permits 50 D1 statements
	 * per invocation, and a Durable Object alarm is one invocation, so the alarm
	 * runs one maintenance pass under that allowance and arms the alarm again
	 * for whichever pass is due next.
	 */
	override async alarm(): Promise<void> {
		await this.initialise();
		const logger = rootLogger().with({ trigger: 'alarm' });
		const now = Date.now();
		this.commitCredit.closeExpiredSessions(now);
		this.commitCredit.closeIdleSessions(now, () =>
			this.uploadState.sessionsAwaitingVerdict()
		);
		await this.armCommitSocketClose();
		await this.armVerifyBackstopAlarm();
		await new CachePurgeQueueService(this.context).runOnce();
		await this.runOneMaintenancePass(logger);
	}

	async runCacheTeardown(
		cache: CacheScope,
		origin: RequestOrigin
	): Promise<void> {
		await this.initialise();
		const resolved = this.context.cacheRepository.require(cache);
		await this.metered('cache-teardown', () =>
			this.withMaintenanceEligibility(() =>
				this.cacheAdmin.tearDownCache(resolved, origin)
			)
		);
	}

	// Drain one cache teardown marker per bounded pass. Rearm the alarm while any
	// marker remains so queued teardowns release the input gate between chunks.
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

	// One cron invocation settles pending rows and scans a page of committed
	// narinfos under the same D1 allowance. The claim and scan cursors preserve
	// unfinished work for the next cron run.
	async runVerification(): Promise<void> {
		await this.initialise();
		await this.runCoalescedCronMaintenance('verify', async () => {
			// This pass will claim the pending rows, so re-arm the prompt-verify
			// single-flight guard: a deferral after this point asks for its own pass.
			this.commitPipeline.onVerificationPassStarted();
			await this.metered('verification', (logger) =>
				this.withMaintenanceEligibility(async () => {
					await this.verification.processPendingWithoutDecode(
						logger,
						verificationBatchSize
					);

					if (this.verification.hasPendingUploads()) {
						await this.commitPipeline.requestVerification(
							logger,
							this.context.requireTenant()
						);
					}
					await this.verification.verifyBatch(
						logger,
						undefined,
						verificationBatchSize
					);
				})
			);
		});
	}

	// Keep CPU-bound NAR decoding in the queue consumer, off the Durable Object
	// thread. This RPC returns a bounded snapshot. The consumer promotes staging
	// objects and reports verdicts, leaving only state transitions to the single
	// writer. A truncated result tells the consumer that more rows remain.
	async claimVerificationBatch(
		limit: number,
		maxNarBytes: number,
		budgetMs?: number
	): Promise<PendingVerificationBatch> {
		if (budgetMs !== undefined) {
			const result = await this.claimVerificationBatchWithinBudget(
				limit,
				maxNarBytes,
				budgetMs
			);

			if (result.kind === 'timed-out') {
				throw new SubrequestTimeoutError('verification.claim');
			}

			return result.batch;
		}

		const parsedLimit = verificationClaimBoundSchema.parse(limit);
		const parsedMaxNarBytes = verificationByteBoundSchema.parse(maxNarBytes);

		return this.claimVerificationBatchOperation(parsedLimit, parsedMaxNarBytes);
	}

	/**
	 * Claims a verification batch within the supplied consumer budget.
	 */
	async claimVerificationBatchWithinBudget(
		limit: number,
		maxNarBytes: number,
		budgetMs: number
	): Promise<VerificationClaimRpcResult> {
		const parsedLimit = verificationClaimBoundSchema.parse(limit);
		const parsedMaxNarBytes = verificationByteBoundSchema.parse(maxNarBytes);
		const parsedBudget = verificationBudgetSchema.parse(budgetMs);
		let claimed: PendingVerificationBatch | undefined;

		try {
			const batch = await withDeadlineBudget(
				Math.max(0, parsedBudget - verificationRpcControlMarginMs),
				() =>
					this.claimVerificationBatchOperation(
						parsedLimit,
						parsedMaxNarBytes,
						(batch) => {
							claimed = batch;
						}
					),
				'verification.claim'
			);

			return { kind: 'claimed', batch };
		} catch (error) {
			if (!(error instanceof SubrequestTimeoutError)) {
				throw error;
			}

			if (claimed !== undefined) {
				this.verification.releaseClaimLeases(
					claimed.owner,
					claimed.claims.map((claim) => claim.uploadId)
				);
			}

			return { kind: 'timed-out' };
		}
	}

	// A legacy consumer cannot send a claim owner. This compatibility method
	// schedules a current pass and returns an empty claim set.
	async claimPendingVerifications(
		limit: number
	): Promise<PendingVerification[]> {
		verificationClaimBoundSchema.parse(limit);
		await this.requestVerificationPass();

		return [];
	}

	async renewVerificationClaims(
		owner: string,
		uploadIds: readonly UploadId[]
	): Promise<boolean> {
		if (uploadIds.length > maxVerificationRpcRows) {
			throw new RangeError(
				`A verification renewal may contain at most ${String(maxVerificationRpcRows)} upload IDs.`
			);
		}

		await this.initialise();
		return this.verification.renewClaimLeases(owner, uploadIds);
	}

	// Only RPC callers can stage negotiate hints. The Worker puts the returned
	// single-use token on the forwarded request. During deploy skew, invalid hint
	// data is rejected and the Worker forwards the request without hints.
	async stageNegotiateHints(
		hints: NegotiateHints
	): Promise<NegotiateHintsToken> {
		await this.initialise();

		return this.context.negotiateHints.stage(
			negotiateHintsSchema.parse(hints),
			Date.now()
		);
	}

	// Queue continuations and new commit deferrals share one single-flight request,
	// so a row is claimed only once per pass.
	async requestVerificationPass(): Promise<void> {
		await this.initialise();
		const logger = rootLogger().with({ rpc: 'request-verification-pass' });
		await this.commitPipeline.requestVerification(
			logger,
			this.context.requireTenant()
		);
	}

	// Return the number of results that changed a row. The queue consumer requests
	// another pass only when at least one result was applied.
	async recordVerifications(
		ownerOrResults: string | readonly VerificationResult[],
		results?: readonly VerificationResult[],
		budgetMs?: number
	): Promise<number> {
		if (typeof ownerOrResults !== 'string') {
			this.validateVerificationResults(ownerOrResults);
			await this.requestVerificationPass();

			return 0;
		}

		if (results === undefined) {
			throw new TypeError('Verification results are required.');
		}

		if (budgetMs !== undefined) {
			const result = await this.recordVerificationsWithinBudget(
				ownerOrResults,
				results,
				budgetMs
			);

			if (result.kind === 'timed-out') {
				throw new SubrequestTimeoutError('verification.record');
			}

			return result.applied;
		}

		this.validateVerificationResults(results);
		await this.initialise();

		return this.recordVerificationsOperation(ownerOrResults, results);
	}

	/**
	 * Records verification results within the supplied consumer budget.
	 */
	async recordVerificationsWithinBudget(
		owner: string,
		results: readonly VerificationResult[],
		budgetMs: number
	): Promise<VerificationRecordRpcResult> {
		this.validateVerificationResults(results);
		const parsedBudget = verificationBudgetSchema.parse(budgetMs);

		try {
			const applied = await withDeadlineBudget(
				Math.max(0, parsedBudget - verificationRpcControlMarginMs),
				async () => {
					await this.initialise();

					return this.recordVerificationsOperation(owner, results);
				},
				'verification.record'
			);

			return { kind: 'recorded', applied };
		} catch (error) {
			if (error instanceof SubrequestTimeoutError) {
				return { kind: 'timed-out' };
			}

			throw error;
		}
	}

	async recordVerification(
		_uploadId: UploadId,
		_verification: NarVerification
	): Promise<void> {
		await this.requestVerificationPass();
	}

	async recordMissingObject(_uploadId: UploadId): Promise<void> {
		await this.requestVerificationPass();
	}

	async runAuthKeyRetirement(): Promise<void> {
		await this.initialise();
		await this.metered('auth-key-retirement', () =>
			this.withMaintenanceEligibility(() =>
				this.authKeys.retireScheduledAuthKeys()
			)
		);
	}

	// Route demotions through the tenant's single writer. A target can be
	// dematerialised only while its live row still references the missing object;
	// checking both facts makes reaper retries safe.
	async demoteNarInfoObjects(
		demotions: readonly NarInfoDemotion[]
	): Promise<void> {
		await this.initialise();

		await this.metered('demote-narinfo-objects', async () => {
			for (const { narHash, targets } of demotions) {
				for (const target of targets) {
					await this.narInfoObjects.demoteUnbacked(
						this.context.cacheRepository.require(target.cache),
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
		return this.attestationCas.reserveReferenceAndCharge(reference, size);
	}

	async removeAttestationReference(
		reference: AttestationReference
	): Promise<void> {
		await this.initialise();
		await this.attestationCas.removeCapturedReference(reference);
	}

	async demoteAttestationReferences(
		demotions: readonly CasReferenceDemotion[]
	): Promise<void> {
		await this.initialise();
		await this.metered('demote-attestation-references', async () => {
			for (const { digest, fenceIncarnation } of demotions) {
				await this.attestations.removeReferencesForDigest(
					digest,
					fenceIncarnation
				);
			}
		});
	}

	// Set the warm-instance fence before the drain starts so an in-flight commit
	// cannot restore a narinfo object behind the drain.
	async beginOffboard(): Promise<void> {
		await this.initialise();
		this.offboarding.begin();
	}

	// Drain only the reference and ownership rows assigned to this tenant writer.
	// The Worker repeats bounded passes; the global reaper collects shared blobs.
	async runOffboard(limit: number): Promise<{ drained: boolean }> {
		await this.initialise();

		return this.metered('offboard', () =>
			this.context.criticalSection(() => this.offboarding.drain(limit))
		);
	}

	// Call only after the tenant's external references have drained. This removes
	// all tenant-local data and returns the Durable Object to its unconfigured state.
	purgeStorage(): Promise<void> {
		return this.ctx.blockConcurrencyWhile(async () => {
			await this.ctx.storage.deleteAll();
			this.migrationPromise = undefined;
			this.authKeys.resetAuthKeyCache();
			this.signingKeys.resetKeyCaches();
		});
	}

	// Derive a temporary upload credential from the stored R2 credentials and
	// probe R2 with it. This verifies the credential form used by uploads without
	// exposing the stored credentials or accessing tenant state.
	async checkR2(): Promise<R2CredentialCheck> {
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

		// A 2xx response, 403, or 404 proves that R2 accepted the derived
		// credential far enough to evaluate the probe. Other statuses reject it;
		// 400 is R2's `InvalidArgument` response for an invalid credential.
		if (response.ok || response.status === 403 || response.status === 404) {
			return { result: 'ok' };
		}

		return { result: 'rejected', status: response.status };
	}

	// Ignore a stale or replayed configuration version. The synchronous SQLite
	// read and write cannot interleave. An accepted identity revokes sessions for
	// the previous owner and reseeds the owner rule.
	async configure(identity: TenantIdentity): Promise<void> {
		await this.initialise(identity.tenant);

		await this.metered('configure', async () => {
			this.context.db.transaction((transaction) => {
				if (!this.tenantIdentity.configure(identity, transaction)) {
					return;
				}

				this.tokenExchange.revokeRuleFamilies(ownerRuleId, transaction);
				this.oidcTrust.seedOwnerRule(transaction);
			});

			await this.reconcileMaintenanceEligibility();
		});
	}

	async migrateCacheCatalogue(tenant: TenantId): Promise<void> {
		await this.initialise(tenant);
	}

	async advanceDeploymentMigration(
		tenant: TenantId,
		migration:
			| 'cache-catalogue-reconciliation'
			| 'cache-r2-generation-metadata'
			| 'cache-retention-properties'
			| 'cache-local-storage-contract',
		budget: DataMigrationBudget
	): Promise<{ readonly outcome: 'complete' | 'pending' }> {
		await this.initialise(tenant);

		return withDataMigrationBudget(budget, async () => {
			if (migration === 'cache-catalogue-reconciliation') {
				return { outcome: 'complete' };
			}

			if (migration === 'cache-retention-properties') {
				const outcome = await advanceCacheRetentionMigration(this.context.db);

				return { outcome: outcome.status };
			}

			if (migration === 'cache-local-storage-contract') {
				return { outcome: 'complete' };
			}

			return this.advanceR2GenerationMetadataMigration();
		});
	}

	async resolveProjectionRepair(
		tenant: TenantId,
		id: string,
		operation: string,
		payloadJson: string
	): Promise<{ readonly outcome: 'complete' | 'rolled-back' }> {
		await this.initialise(tenant);

		if (operation !== 'managed-cache-activation') {
			throw new UnsupportedProjectionRepairOperationError(operation);
		}

		const outcome = await this.managedCaches.resolveManagedActivationRepair(
			id,
			payloadJson
		);

		return { outcome };
	}

	async drainWriterEpoch(
		tenant: TenantId,
		target: WriterEpoch
	): Promise<{ readonly outcome: 'complete' }> {
		await this.initialise(tenant);

		for (const socket of this.ctx.getWebSockets()) {
			const attachment = readCommitSessionAttachment(socket);

			if (attachment?.writerEpoch === target) {
				continue;
			}

			socket.close(1012, 'deployment writer cutover');
		}

		this.context.db.transaction((transaction) => {
			transaction
				.update(schema.pendingUploads)
				.set({ writerEpoch: target })
				.where(ne(schema.pendingUploads.writerEpoch, target))
				.run();
			transaction
				.update(schema.pendingAttestations)
				.set({ writerEpoch: target })
				.where(ne(schema.pendingAttestations.writerEpoch, target))
				.run();
			transaction
				.update(schema.narInfoDeletions)
				.set({ writerEpoch: target })
				.where(ne(schema.narInfoDeletions.writerEpoch, target))
				.run();
			transaction
				.update(schema.cachePurgeContinuations)
				.set({ writerEpoch: target })
				.where(ne(schema.cachePurgeContinuations.writerEpoch, target))
				.run();
			transaction
				.update(schema.garbageCollectionScans)
				.set({ writerEpoch: target })
				.where(ne(schema.garbageCollectionScans.writerEpoch, target))
				.run();
		});

		return { outcome: 'complete' };
	}

	// The socket attachment preserves cache and session identity across
	// hibernation. Keepalive pings use the automatic response and never wake the
	// Durable Object.
	async webSocketMessage(
		socket: WebSocket,
		message: string | ArrayBuffer
	): Promise<void> {
		await this.initialise();

		const attachment = readCommitSessionAttachment(socket);

		if (attachment === undefined) {
			socket.close(1011, 'missing session');
			return;
		}

		if (attachment.writerEpoch !== cacheWriterEpoch) {
			socket.close(1012, 'deployment writer cutover');
			return;
		}

		if (
			this.commitCredit.closeIfAuthenticationExpired(
				socket,
				attachment,
				Date.now()
			)
		) {
			return;
		}

		if (isSessionClosing(attachment)) {
			// A peer can send a late frame before acknowledging the server's close.
			// Do not run it or grant credit again: this session has already returned
			// its credit and may never produce another close event. Use 1001 so the
			// client can reconnect.
			socket.close(1001, 'commit session closed');
			return;
		}

		const text =
			typeof message === 'string' ? message : new TextDecoder().decode(message);
		const parsed = commitSessionRequestSchema.safeParse(safeJsonParse(text));

		if (!parsed.success) {
			// Reply `unsupported` for a well-formed future operation. Malformed JSON
			// or an invalid shape for a known operation closes the socket.
			const unknown = unknownSessionOp(text);

			if (unknown !== undefined) {
				sendCommitSessionFrame(socket, { ev: 'unsupported', op: unknown });
				return;
			}

			socket.close(1002, 'invalid commit request');
			return;
		}

		const request = parsed.data;
		const { cache: cacheScope, sessionId } = attachment;

		if (request.op === 'request-credit') {
			const hasNegotiated = this.commitCredit.declareDemand(
				socket,
				attachment,
				request.entries,
				Date.now()
			);

			if (!hasNegotiated) {
				// This session did not negotiate credit. Reply `unsupported` so the
				// client falls back to the fixed window used by legacy sessions.
				sendCommitSessionFrame(socket, {
					ev: 'unsupported',
					op: request.op
				});
			}

			return;
		}

		const cache = this.context.cacheRepository.require(cacheScope);

		const decision = this.commitCredit.admitMessage(
			socket,
			attachment,
			commitEntryCount(request),
			Date.now()
		);

		// Reclaim before initiating either close. The socket remains listed until
		// the peer acknowledges it, and another grant could otherwise reach a
		// closing session.
		if (decision === 'overdrawn') {
			// A negotiated client knows its exact grant. Exceeding it is a terminal
			// protocol error, so close with 1002.
			this.commitCredit.closeSession(sessionId, Date.now());
			socket.close(1002, 'commit credit exceeded');
			return;
		}

		if (decision === 'refused') {
			// The tenant has no capacity for another unpaced session. Use retryable
			// close code 1013 so the client reconnects and negotiates again.
			this.commitCredit.closeSession(sessionId, Date.now());
			socket.close(1013, 'too many unpaced commit sessions');
			return;
		}

		// Release an accounted entry after its processing and result-send attempt
		// finish. The `finally` also returns credit when sending the frame fails.
		const isAccounted = decision === 'accounted';

		if (request.op === 'commit') {
			// Apply the same tenant-wide semaphore to individual commit messages and
			// batch entries so neither form can bypass the concurrency limit.
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
			// Each entry reports its own result, so one failure does not stop its
			// batch peers. Bounded concurrency also prevents one materialisation wait
			// from blocking the rest of the batch.
			const logger = rootLogger().with({ sessionId, cache, op: request.op });

			// Prefetch D1 facts once for the batch. They remain advisory; the charge
			// batch decides status and quota. On failure, each entry reads fresh facts.
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
				// Each entry falls back to fresh reads.
			}

			// `mapWithConcurrency` may leave later entries unstarted after a rejection.
			// Return their reserved credit here; entries that ran return their own.
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
				// An escaped entry failure can prevent later entries from starting.
				// Return a retryable result for every entry without a frame and keep the
				// internal exception in server logs.
				logger.error(
					'commit batch stopped after an error escaped per-entry handling',
					{ error }
				);

				for (const entry of request.commits) {
					if (answered.has(entry.uploadId)) {
						continue;
					}

					sendCommitSessionFrame(socket, {
						ev: 'error',
						uploadId: entry.uploadId,
						status: StatusCodes.SERVICE_UNAVAILABLE,
						message:
							'The server stopped processing the commit batch before it produced a result for this entry.'
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

	// Return the session's remaining credit when the peer closes the socket.
	webSocketClose(socket: WebSocket): void {
		reclaimCommitCredit(this.commitCredit, socket);
		socket.close();
	}

	webSocketError(socket: WebSocket): void {
		reclaimCommitCredit(this.commitCredit, socket);
		socket.close(1011, 'socket error');
	}
}

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

// Debit credit only for entries that start commits. Subscription operations
// retain their separate request-size bounds and consume no commit credit.
function commitEntryCount(request: CommitSessionRequest): number {
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

const knownSessionOps = new Set<string>(
	commitSessionRequestSchema.options.map((option) => option.shape.op.value)
);

// Only a well-formed operation from a later protocol version receives an
// `unsupported` reply. Invalid JSON and malformed known operations remain
// protocol errors.
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

// Durable Object storage is billed per row. Include row counts at `debug`; the
// request logger and object identity already provide method, path, and tenant.
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
	| 'verdict-drain'
	| 'verification'
	| 'verify-backstop';

// Direct RPCs have no HTTP request log. Record their storage cost at `trace`
// because cron and queue traffic makes this the noisiest cost telemetry.
function logMethodFinished(logger: Logger, cost: DatabaseCost): void {
	logger.trace('method finished', {
		rowsRead: cost.rowsRead,
		rowsWritten: cost.rowsWritten
	});
}
