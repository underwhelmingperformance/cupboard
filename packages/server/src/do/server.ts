import { CacheInfo } from '@cupboard/nix/cache-info';
import { cacheNameSchema, DEFAULT_CACHE } from '@cupboard/nix/scalars';
import { zstdDecompressionStream } from '@cupboard/nix/zstd';
import type { ParsedR2CredentialCheck } from '@cupboard/protocol/reports';
import { DurableObject } from 'cloudflare:workers';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { Hono } from 'hono';
import { StatusCodes } from 'http-status-codes';

import migrations from '../../drizzle/migrations.js';
import * as schema from '../db/schema.ts';
import {
	CommitUpgradeRequiredError,
	R2PresignConfigurationMissingError,
	ServerHttpError,
	TenantNotConfiguredError,
	ZstdUnavailableError
} from '../errors.ts';
import { serverErrorResponse } from '../http/error-response.ts';
import { textResponse, verificationBatchSize } from '../http/http.ts';
import { parseRequestValue } from '../http/parse.ts';
import { OidcDiscoveryStore } from '../oidc/oidc.ts';

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
import { VerificationService } from './verification-service.ts';

export class CupboardServer extends DurableObject<RuntimeEnv> {
	private readonly app = new Hono<{ Bindings: RuntimeEnv }>();
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
			this.authKeys,
			this.attestationCas,
			this.narInfoObjects
		);
		this.uploadState = new UploadStateService(this.context);
		this.deletionQueue = new DeletionQueueService(
			this.context,
			this.authKeys,
			this.attestationCas,
			this.attestations
		);
		this.signingKeys = new SigningKeysService(this.context, this.authKeys);
		this.stats = new StatsService(this.context, this.authKeys);
		this.oidcTrust = new OidcTrustService(
			this.context,
			this.authKeys,
			this.tenantIdentity
		);
		this.retention = new RetentionService(this.context, this.authKeys);
		this.integrityCheck = new IntegrityCheckService(
			this.context,
			this.authKeys
		);
		this.cacheAdmin = new CacheAdminService(
			this.context,
			this.authKeys,
			this.deletionQueue
		);
		this.garbageCollection = new GarbageCollectionService(
			this.context,
			this.authKeys,
			this.deletionQueue
		);
		this.tokenExchange = new TokenExchangeService(
			this.context,
			this.authKeys,
			this.oidcTrust
		);
		this.uploads = new UploadsService(
			this.context,
			this.authKeys,
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
			this.authKeys,
			this.commitPipeline,
			this.deletionQueue,
			this.narInfoObjects,
			this.uploadState
		);
		this.roots = new RootsService(
			this.context,
			this.authKeys,
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

		// An unconfigured Durable Object has no identity to mint, verify or advertise
		// under, so it serves nothing rather than falling back to a default. This is
		// input-gated: the control plane's `configure` RPC, which assigns the
		// identity, is a method and so is not gated here.
		if (this.tenantIdentity.current() === undefined) {
			return serverErrorResponse(
				Promise.reject(new TenantNotConfiguredError())
			);
		}

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
		this.app.on(['GET', 'HEAD'], '/pubkey', async (context) =>
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
		this.app.on(
			['GET', 'HEAD'],
			'/cache/:cacheName/nix-cache-info',
			(context) =>
				serverErrorResponse(
					this.cacheAdmin.handleCacheInfo(
						context.req.raw,
						context.req.param('cacheName')
					)
				)
		);

		// The OAuth 2.0 token-exchange endpoint and the auth key set that verifies
		// the tokens it mints. `/token` is unauthenticated: the subject token is
		// itself the credential. The Worker proxies `/.well-known/jwks.json` here.
		this.app.post('/token', (context) =>
			serverErrorResponse(this.tokenExchange.handleToken(context.req.raw))
		);
		this.app.on(['GET', 'HEAD'], '/.well-known/jwks.json', (context) =>
			serverErrorResponse(this.authKeys.handleJwks(context.req.raw))
		);
		this.app.on(
			['GET', 'HEAD'],
			'/.well-known/oauth-authorization-server',
			(context) =>
				serverErrorResponse(
					this.authKeys.handleAuthorizationServerMetadata(context.req.raw)
				)
		);
		this.app.get('/keys', (context) =>
			serverErrorResponse(this.signingKeys.handleKeyList(context.req.raw))
		);
		this.app.post('/keys/rotate', (context) =>
			serverErrorResponse(this.signingKeys.handleKeyRotate(context.req.raw))
		);
		this.app.post('/keys/retire/:id', (context) =>
			serverErrorResponse(
				this.signingKeys.handleKeyRetire(
					context.req.raw,
					context.req.param('id')
				)
			)
		);

		// The auth-token signing key set, rotated independently of the narinfo
		// keys above; tokens carry the active key's `kid` and verify against any
		// key still in the set.
		this.app.get('/keys/auth', (context) =>
			serverErrorResponse(this.authKeys.handleAuthKeyList(context.req.raw))
		);
		this.app.post('/keys/auth/rotate', (context) =>
			serverErrorResponse(
				this.withMaintenanceEligibility(() =>
					this.authKeys.handleAuthKeyRotate(context.req.raw)
				)
			)
		);
		this.app.post('/keys/auth/retire/:kid', (context) =>
			serverErrorResponse(
				this.withMaintenanceEligibility(() =>
					this.authKeys.handleAuthKeyRetire(
						context.req.raw,
						context.req.param('kid')
					)
				)
			)
		);

		// The cache registry is deployment-wide, so it lives at `/caches` rather
		// than under a per-cache prefix.
		this.app.get('/caches', (context) =>
			serverErrorResponse(this.cacheAdmin.handleListCaches(context.req.raw))
		);
		this.app.put('/caches/:cacheName', (context) =>
			serverErrorResponse(
				this.cacheAdmin.handlePutCache(
					context.req.raw,
					context.req.param('cacheName')
				)
			)
		);
		this.app.delete('/caches/:cacheName', (context) =>
			serverErrorResponse(
				this.withMaintenanceEligibility(() =>
					this.cacheAdmin.handleRemoveCache(
						context.req.raw,
						context.req.param('cacheName')
					)
				)
			)
		);
		this.app.get('/policies', (context) =>
			serverErrorResponse(this.retention.handleListPolicies(context.req.raw))
		);
		this.app.post('/policies', (context) =>
			serverErrorResponse(this.retention.handleAddPolicy(context.req.raw))
		);
		this.app.delete('/policies/:id', (context) =>
			serverErrorResponse(
				this.retention.handleRemovePolicy(
					context.req.raw,
					context.req.param('id')
				)
			)
		);

		// The owner manages CI write-trust rules here; the owner's own admin rule
		// is seeded from deploy config and is not editable through this API.
		this.app.get('/oidc-trust', (context) =>
			serverErrorResponse(this.oidcTrust.handleListOidcTrust(context.req.raw))
		);
		this.app.post('/oidc-trust', (context) =>
			serverErrorResponse(this.oidcTrust.handleAddOidcTrust(context.req.raw))
		);
		this.app.delete('/oidc-trust/:id', (context) =>
			serverErrorResponse(
				this.oidcTrust.handleRemoveOidcTrust(
					context.req.raw,
					context.req.param('id')
				)
			)
		);

		// A read-only storage check across every cache. Blobs are shared, so it is
		// deployment-wide: one bare `/check` covering all caches.
		this.app.get('/check', (context) =>
			serverErrorResponse(this.integrityCheck.handleCheck(context.req.raw))
		);

		// A bounded reconciling pass driven by the cron tick. Its own route, kept
		// separate from `/gc`, so each can run and be asserted independently.
		this.app.post('/verify', (context) =>
			serverErrorResponse(
				this.withMaintenanceEligibility(() =>
					this.verification.handleVerify(context.req.raw)
				)
			)
		);

		// Each path-scoped route has a bare form (the default cache) and a
		// `/cache/:cacheName/` form. The per-route scope is identical between the
		// two; the cache-scoped form validates the name inside the error boundary.
		this.app.get('/stats', (context) =>
			serverErrorResponse(
				this.stats.handleStats(context.req.raw, DEFAULT_CACHE)
			)
		);
		this.app.get('/usage', (context) =>
			serverErrorResponse(this.stats.handleUsage(context.req.raw))
		);
		this.app.get('/cache/:cacheName/stats', (context) =>
			this.withCache(context.req.param('cacheName'), (cache) =>
				this.stats.handleStats(context.req.raw, cache)
			)
		);
		this.app.delete('/paths/:hash', (context) =>
			serverErrorResponse(
				this.withMaintenanceEligibility(() =>
					this.deletionQueue.handleDeletePath(
						context.req.raw,
						DEFAULT_CACHE,
						context.req.param('hash')
					)
				)
			)
		);
		this.app.delete('/cache/:cacheName/paths/:hash', (context) =>
			this.withCache(context.req.param('cacheName'), (cache) =>
				this.withMaintenanceEligibility(() =>
					this.deletionQueue.handleDeletePath(
						context.req.raw,
						cache,
						context.req.param('hash')
					)
				)
			)
		);
		this.app.get('/roots', (context) =>
			serverErrorResponse(
				this.roots.handleListRoots(context.req.raw, DEFAULT_CACHE)
			)
		);
		this.app.get('/cache/:cacheName/roots', (context) =>
			this.withCache(context.req.param('cacheName'), (cache) =>
				this.roots.handleListRoots(context.req.raw, cache)
			)
		);
		this.app.put('/roots/:name', (context) =>
			serverErrorResponse(
				this.withMaintenanceEligibility(() =>
					this.roots.handleSetRoot(
						context.req.raw,
						DEFAULT_CACHE,
						context.req.param('name')
					)
				)
			)
		);
		this.app.put('/cache/:cacheName/roots/:name', (context) =>
			this.withCache(context.req.param('cacheName'), (cache) =>
				this.withMaintenanceEligibility(() =>
					this.roots.handleSetRoot(
						context.req.raw,
						cache,
						context.req.param('name')
					)
				)
			)
		);
		this.app.delete('/roots/:name', (context) =>
			serverErrorResponse(
				this.withMaintenanceEligibility(() =>
					this.roots.handleRemoveRoot(
						context.req.raw,
						DEFAULT_CACHE,
						context.req.param('name')
					)
				)
			)
		);
		this.app.delete('/cache/:cacheName/roots/:name', (context) =>
			this.withCache(context.req.param('cacheName'), (cache) =>
				this.withMaintenanceEligibility(() =>
					this.roots.handleRemoveRoot(
						context.req.raw,
						cache,
						context.req.param('name')
					)
				)
			)
		);
		this.app.post('/uploads', (context) =>
			serverErrorResponse(
				this.withMaintenanceEligibility(() =>
					this.uploads.handleNegotiate(context.req.raw, DEFAULT_CACHE)
				)
			)
		);
		this.app.post('/cache/:cacheName/uploads', (context) =>
			this.withCache(context.req.param('cacheName'), (cache) =>
				this.withMaintenanceEligibility(() =>
					this.uploads.handleNegotiate(context.req.raw, cache)
				)
			)
		);
		this.app.put('/uploads/:id', (context) =>
			serverErrorResponse(
				this.withMaintenanceEligibility(() =>
					this.uploads.handlePrepareUpload(
						context.req.raw,
						DEFAULT_CACHE,
						context.req.param('id')
					)
				)
			)
		);
		this.app.put('/cache/:cacheName/uploads/:id', (context) =>
			this.withCache(context.req.param('cacheName'), (cache) =>
				this.withMaintenanceEligibility(() =>
					this.uploads.handlePrepareUpload(
						context.req.raw,
						cache,
						context.req.param('id')
					)
				)
			)
		);
		// The commit endpoint is a WebSocket: the upgrade request carries the
		// write token, the first frame settles or defers the path, and a
		// deferred upload's socket parks (hibernating) until verification
		// answers with the terminal verdict.
		this.app.get('/uploads/:id/commit', (context) =>
			serverErrorResponse(
				this.commitSocket(
					context.req.raw,
					DEFAULT_CACHE,
					context.req.param('id')
				)
			)
		);
		this.app.get('/cache/:cacheName/uploads/:id/commit', (context) =>
			this.withCache(context.req.param('cacheName'), (cache) =>
				this.commitSocket(context.req.raw, cache, context.req.param('id'))
			)
		);
		// `push --wait` polls a deferred upload's status by its uploadId, which is
		// unique across caches, so a single route serves it regardless of cache.
		this.app.get('/uploads/:id/status', (context) =>
			serverErrorResponse(
				this.uploads.handleUploadStatus(
					context.req.raw,
					context.req.param('id')
				)
			)
		);
		this.app.on(['GET', 'HEAD'], '/attestations/:hash', (context) =>
			serverErrorResponse(
				this.attestations.handleServeList(
					context.req.raw,
					DEFAULT_CACHE,
					context.req.param('hash')
				)
			)
		);
		this.app.on(
			['GET', 'HEAD'],
			'/cache/:cacheName/attestations/:hash',
			(context) =>
				this.withCache(context.req.param('cacheName'), (cache) =>
					this.attestations.handleServeList(
						context.req.raw,
						cache,
						context.req.param('hash')
					)
				)
		);
		this.app.on(['GET', 'HEAD'], '/attestation-bundles/:digest', (context) =>
			serverErrorResponse(
				this.attestations.handleServeBundle(
					context.req.raw,
					DEFAULT_CACHE,
					context.req.param('digest')
				)
			)
		);
		this.app.on(
			['GET', 'HEAD'],
			'/cache/:cacheName/attestation-bundles/:digest',
			(context) =>
				this.withCache(context.req.param('cacheName'), (cache) =>
					this.attestations.handleServeBundle(
						context.req.raw,
						cache,
						context.req.param('digest')
					)
				)
		);
		this.app.post('/attestations', (context) =>
			serverErrorResponse(
				this.withMaintenanceEligibility(() =>
					this.attestations.handleNegotiate(context.req.raw, DEFAULT_CACHE)
				)
			)
		);
		this.app.post('/cache/:cacheName/attestations', (context) =>
			this.withCache(context.req.param('cacheName'), (cache) =>
				this.withMaintenanceEligibility(() =>
					this.attestations.handleNegotiate(context.req.raw, cache)
				)
			)
		);
		this.app.put('/attestations/:id', (context) =>
			serverErrorResponse(
				this.withMaintenanceEligibility(() =>
					this.attestations.handlePrepare(
						context.req.raw,
						DEFAULT_CACHE,
						context.req.param('id')
					)
				)
			)
		);
		this.app.put('/cache/:cacheName/attestations/:id', (context) =>
			this.withCache(context.req.param('cacheName'), (cache) =>
				this.withMaintenanceEligibility(() =>
					this.attestations.handlePrepare(
						context.req.raw,
						cache,
						context.req.param('id')
					)
				)
			)
		);
		this.app.post('/attestations/:id/attach', (context) =>
			serverErrorResponse(
				this.withMaintenanceEligibility(() =>
					this.attestations.handleAttach(
						context.req.raw,
						DEFAULT_CACHE,
						context.req.param('id')
					)
				)
			)
		);
		this.app.post('/cache/:cacheName/attestations/:id/attach', (context) =>
			this.withCache(context.req.param('cacheName'), (cache) =>
				this.withMaintenanceEligibility(() =>
					this.attestations.handleAttach(
						context.req.raw,
						cache,
						context.req.param('id')
					)
				)
			)
		);
		this.app.post('/gc', (context) =>
			serverErrorResponse(
				this.withMaintenanceEligibility(() =>
					this.garbageCollection.handleGarbageCollection(context.req.raw)
				)
			)
		);
		this.app.post('/cache/:cacheName/gc', (context) =>
			this.withCache(context.req.param('cacheName'), (cache) =>
				this.withMaintenanceEligibility(() =>
					this.garbageCollection.handleGarbageCollection(context.req.raw, cache)
				)
			)
		);
	}

	// Authenticates and upgrades a commit request, parks the socket through the
	// hibernation API (tagged by upload id, so verification can find every
	// waiter even after this object was evicted), and runs the commit
	// transition once the 101 is on its way. Auth failures answer as plain
	// HTTP before any socket exists.
	private async commitSocket(
		request: Request,
		cache: string,
		uploadId: string
	): Promise<Response> {
		await this.authKeys.requireScope(request, 'write');

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

	private withCache(
		cacheName: string | undefined,
		handler: (cache: string) => Promise<Response>
	): Promise<Response> {
		return serverErrorResponse(
			(async () => handler(parseRequestValue(cacheNameSchema, cacheName)))()
		);
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
