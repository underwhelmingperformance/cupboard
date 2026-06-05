import {
	type AuthKeyListResponse,
	type AuthKeyRetireResponse,
	type AuthKeyRotateResponse,
	type AuthKeySummary,
	CacheInfo,
	type CacheListResponse,
	cacheNameSchema,
	cachePutBodySchema,
	type CacheRemoveResponse,
	type CacheSummary,
	type CheckDiscrepancy,
	type CheckReport,
	type CommitResponse,
	DEFAULT_CACHE,
	defaultAuthAudience,
	defaultAuthIssuer,
	type DeletePathResponse,
	issuedAccessTokenType,
	IssuerUrl,
	type KeyListResponse,
	type KeyRetireResponse,
	type KeyRotateResponse,
	NarInfo,
	NixSha256Hash,
	oidcTrustAddBodySchema,
	type OidcTrustListResponse,
	type OidcTrustRemoveResponse,
	type OidcTrustSummary,
	referencesSchema,
	type ResolvedRootTarget,
	resolveRootTargets,
	retentionPolicyAddBodySchema,
	type RetentionPolicyListResponse,
	type RetentionPolicyRemoveResponse,
	type RetentionPolicySummary,
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
	subjectTokenTypeIdToken,
	subjectTokenTypeJwt,
	tokenExchangeGrantType,
	tokenExchangeRequestSchema,
	type TokenResponse,
	type UsageResponse,
	type UploadBlobMetadataFields,
	type UploadDecision,
	uploadNegotiateRequestSchema,
	type UploadNegotiateResponse,
	type UploadPathMetadataFields,
	uploadPathMetadataSchema,
	type UploadPathNegotiationFields,
	uploadPathNegotiationSchema,
	uploadPrepareRequestSchema,
	type UploadPrepareResponse,
	type VerifyReport,
	zstdDecompressionStream
} from '@cupboard/shared';
import { DurableObject } from 'cloudflare:workers';
import {
	and,
	asc,
	count,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	lt,
	lte,
	notInArray,
	or,
	sql
} from 'drizzle-orm';
import { drizzle as drizzleD1, type DrizzleD1Database } from 'drizzle-orm/d1';
import {
	drizzle,
	type DrizzleSqliteDODatabase
} from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { Hono } from 'hono';
import type { JWTPayload } from 'jose';
import { z } from 'zod';

import migrations from '../drizzle/migrations.js';

import {
	type AccessClaims,
	type AccessScope,
	adminJwtTtlSeconds,
	authJwtAlgorithm,
	type AuthPublicKey,
	generateAuthKeyPair,
	mintAccessJwt,
	verifyAccessJwt,
	writeJwtTtlSeconds
} from './auth.ts';
import { coldPathTtlSeconds, resolveRootExpiry } from './cold-path.ts';
import { generateSigningKey, signNixFingerprint } from './crypto.ts';
import * as d1Schema from './db/d1-schema.ts';
import * as schema from './db/schema.ts';
import { serverErrorResponse } from './error-response.ts';
import {
	CacheNotEmptyError,
	InsufficientScopeError,
	InvalidGrantError,
	InvalidRequestError,
	IssuerUnavailableError,
	LastAuthKeyError,
	LastSigningKeyError,
	NarTooLargeError,
	NarVerificationFailedError,
	OwnerConfigurationInvalidError,
	OwnerRuleImmutableError,
	type R2PresignBindingName,
	R2PresignConfigurationMissingError,
	ReusableUploadNotPreparableError,
	RootNotPermittedError,
	StoredOidcTrustInvalidError,
	StoredReferencesInvalidError,
	StoredSignaturesInvalidError,
	StoredUploadMetadataInvalidError,
	UnauthenticatedError,
	UnsupportedGrantTypeError,
	UploadCacheMismatchError,
	UploadedObjectChecksumMismatchError,
	UploadedObjectChecksumMissingError,
	UploadedObjectNotFoundError,
	UploadedObjectSizeMismatchError,
	UploadExpiredError,
	UploadNotFoundError,
	UploadNotPreparedError,
	ZstdUnavailableError
} from './errors.ts';
import {
	blobReaperBatchSize,
	blobReaperGraceMs,
	checkBatchSize,
	inlineVerifyMaxBytes,
	internalOrigin,
	narInfoCacheControl,
	narInfoCachePath,
	narInfoObjectKey,
	narObjectKey,
	stagingObjectKey,
	TextBody,
	textResponse,
	verifiableMaxBytes,
	verificationBatchSize
} from './http.ts';
import { type NarVerification, verifyDecompressedNar } from './nar-verify.ts';
import {
	decodeInboundClaims,
	OidcDiscoveryStore,
	OidcKeysUnreachableError,
	verifyInboundOidcToken
} from './oidc.ts';
import {
	matchOidcTrust,
	type OidcClaims,
	type OidcTrustRule
} from './oidc-trust.ts';
import {
	parseFormBody,
	parseRequestBody,
	parseRequestValue,
	parseStored,
	parseStoredJson
} from './parse.ts';
import { mostSpecificPolicy } from './policy-match.ts';
import { R2Presigner } from './presign.ts';
import {
	verifyStoredBlob,
	verifyUploadedObject
} from './upload-verification.ts';

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

const storedSignaturesSchema = z.array(z.string());

// An optional `?limit` on `POST /verify`: a positive integer, clamped to
// `verificationBatchSize` so a manual run cannot scan an unbounded batch in one
// critical section.
const verificationLimitSchema = z.coerce.number().int().min(1);

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

// The tenant this DO's D1 reference edges belong to. Single-tenant for now; step 5
// replaces this constant with the slug the Worker supplies via the configure RPC.
const singleTenant = 'v1';

// The owner's admin trust rule is seeded under a fixed id from deploy config;
// the admin CRUD uses generated ids, so it never collides with this one.
const ownerRuleId = 'owner';

const storedClaimsSchema = z.record(z.string(), z.string());
const storedAllowedRootsSchema = z.array(z.string());

interface OwnerConfig {
	readonly issuer: string;
	readonly subject: string;
	readonly audience: string;
}

interface GarbageCollectionOutcome {
	readonly pendingUploadsDeleted: number;
	readonly rootsExpired: number;
	readonly pathsSwept: number;
	readonly narInfosDeleted: number;
	readonly blobsDeleted: number;
}

// A key in the auth signing set. The newest non-retired key mints; every
// non-retired key verifies and is published in the JWKS. Retiring sets
// `retired`, dropping the key from minting, verification and the JWKS at once.
interface AuthKey {
	readonly kid: string;
	readonly privateJwk: JsonWebKey;
	readonly publicJwk: JsonWebKey;
	readonly createdAt: string;
	readonly retired: boolean;
}

interface RootSetCommand {
	readonly name: string;
	readonly targets: readonly ResolvedRootTarget[];
	readonly ttlSeconds: number | undefined;
}

// A `cb_roots` entry permits a root by exact name, or — when the entry ends with
// `/` — any root beneath that prefix. The trailing slash is the boundary, so
// `github:owner/` permits `github:owner/repo` while `github:owner` permits only
// itself, never the sibling `github:owner-evil/repo`.
function rootWithinConstraint(rootName: string, entry: string): boolean {
	if (rootName === entry) {
		return true;
	}

	return entry.endsWith('/') && rootName.startsWith(entry);
}

export class CupboardServer extends DurableObject<RuntimeEnv> {
	private readonly app = new Hono<{ Bindings: RuntimeEnv }>();
	private readonly db: DrizzleSqliteDODatabase<typeof schema>;
	// The global shared-blob facts live in D1, readable and writable by every
	// tenant DO and the Worker, rather than in this DO's own SQLite.
	private readonly d1: DrizzleD1Database<typeof d1Schema>;
	private migrationPromise: Promise<void> | undefined;
	private keysPromise: Promise<readonly SigningKey[]> | undefined;
	private authKeysPromise: Promise<readonly AuthKey[]> | undefined;
	private presigner: R2Presigner | undefined;
	private publicKeyBody: TextBody | undefined;
	private readonly discovery = new OidcDiscoveryStore();

	constructor(ctx: DurableObjectState, env: RuntimeEnv) {
		super(ctx, env);
		this.db = drizzle(ctx.storage, {
			schema
		});
		this.d1 = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
		this.routes();
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
		await this.collectGarbage();
	}

	async runVerification(): Promise<void> {
		await this.initialise();
		await this.verifyPendingUploads(verificationBatchSize);
		await this.verifyBatch(undefined, verificationBatchSize);
	}

	private routes(): void {
		this.app.on(['GET', 'HEAD'], '/pubkey', async (context) => {
			this.publicKeyBody ??= new TextBody(
				`${await this.publishedKeysText()}\n`
			);

			// Served uncached so a rotation is visible across colos at once; the
			// strong ETag still lets Nix revalidate conditionally.
			return textResponse(context.req.raw, this.publicKeyBody, {
				'content-type': 'text/plain; charset=utf-8',
				'cache-control': 'no-cache'
			});
		});

		// A named cache's nix-cache-info is rendered from its registry priority;
		// the Worker forwards it here (the default cache's is rendered at the edge).
		this.app.on(
			['GET', 'HEAD'],
			'/cache/:cacheName/nix-cache-info',
			(context) =>
				serverErrorResponse(
					this.handleCacheInfo(context.req.raw, context.req.param('cacheName'))
				)
		);

		// The OAuth 2.0 token-exchange endpoint and the auth key set that verifies
		// the tokens it mints. `/token` is unauthenticated: the subject token is
		// itself the credential. The Worker proxies `/.well-known/jwks.json` here.
		this.app.post('/token', (context) =>
			serverErrorResponse(this.handleToken(context.req.raw))
		);
		this.app.on(['GET', 'HEAD'], '/.well-known/jwks.json', (context) =>
			serverErrorResponse(this.handleJwks(context.req.raw))
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

		// The auth-token signing key set, rotated independently of the narinfo
		// keys above; tokens carry the active key's `kid` and verify against any
		// key still in the set.
		this.app.get('/keys/auth', (context) =>
			serverErrorResponse(this.handleAuthKeyList(context.req.raw))
		);
		this.app.post('/keys/auth/rotate', (context) =>
			serverErrorResponse(this.handleAuthKeyRotate(context.req.raw))
		);
		this.app.post('/keys/auth/retire/:kid', (context) =>
			serverErrorResponse(
				this.handleAuthKeyRetire(context.req.raw, context.req.param('kid'))
			)
		);

		// The cache registry is deployment-wide, so it lives at `/caches` rather
		// than under a per-cache prefix.
		this.app.get('/caches', (context) =>
			serverErrorResponse(this.handleListCaches(context.req.raw))
		);
		this.app.put('/caches/:cacheName', (context) =>
			serverErrorResponse(
				this.handlePutCache(context.req.raw, context.req.param('cacheName'))
			)
		);
		this.app.delete('/caches/:cacheName', (context) =>
			serverErrorResponse(
				this.handleRemoveCache(context.req.raw, context.req.param('cacheName'))
			)
		);
		this.app.get('/policies', (context) =>
			serverErrorResponse(this.handleListPolicies(context.req.raw))
		);
		this.app.post('/policies', (context) =>
			serverErrorResponse(this.handleAddPolicy(context.req.raw))
		);
		this.app.delete('/policies/:id', (context) =>
			serverErrorResponse(
				this.handleRemovePolicy(context.req.raw, context.req.param('id'))
			)
		);

		// The owner manages CI write-trust rules here; the owner's own admin rule
		// is seeded from deploy config and is not editable through this API.
		this.app.get('/oidc-trust', (context) =>
			serverErrorResponse(this.handleListOidcTrust(context.req.raw))
		);
		this.app.post('/oidc-trust', (context) =>
			serverErrorResponse(this.handleAddOidcTrust(context.req.raw))
		);
		this.app.delete('/oidc-trust/:id', (context) =>
			serverErrorResponse(
				this.handleRemoveOidcTrust(context.req.raw, context.req.param('id'))
			)
		);

		// A read-only storage check across every cache. Blobs are shared, so it is
		// deployment-wide: one bare `/check` covering all caches.
		this.app.get('/check', (context) =>
			serverErrorResponse(this.handleCheck(context.req.raw))
		);

		// A bounded reconciling pass driven by the cron tick. Its own route, kept
		// separate from `/gc`, so each can run and be asserted independently.
		this.app.post('/verify', (context) =>
			serverErrorResponse(this.handleVerify(context.req.raw))
		);

		// Each path-scoped route has a bare form (the default cache) and a
		// `/cache/:cacheName/` form. The per-route scope is identical between the
		// two; the cache-scoped form validates the name inside the error boundary.
		this.app.get('/stats', (context) =>
			serverErrorResponse(this.handleStats(context.req.raw, DEFAULT_CACHE))
		);
		this.app.get('/usage', (context) =>
			serverErrorResponse(this.handleUsage(context.req.raw))
		);
		this.app.get('/cache/:cacheName/stats', (context) =>
			this.withCache(context.req.param('cacheName'), (cache) =>
				this.handleStats(context.req.raw, cache)
			)
		);
		this.app.delete('/paths/:hash', (context) =>
			serverErrorResponse(
				this.handleDeletePath(
					context.req.raw,
					DEFAULT_CACHE,
					context.req.param('hash')
				)
			)
		);
		this.app.delete('/cache/:cacheName/paths/:hash', (context) =>
			this.withCache(context.req.param('cacheName'), (cache) =>
				this.handleDeletePath(context.req.raw, cache, context.req.param('hash'))
			)
		);
		this.app.get('/roots', (context) =>
			serverErrorResponse(this.handleListRoots(context.req.raw, DEFAULT_CACHE))
		);
		this.app.get('/cache/:cacheName/roots', (context) =>
			this.withCache(context.req.param('cacheName'), (cache) =>
				this.handleListRoots(context.req.raw, cache)
			)
		);
		this.app.put('/roots/:name', (context) =>
			serverErrorResponse(
				this.handleSetRoot(
					context.req.raw,
					DEFAULT_CACHE,
					context.req.param('name')
				)
			)
		);
		this.app.put('/cache/:cacheName/roots/:name', (context) =>
			this.withCache(context.req.param('cacheName'), (cache) =>
				this.handleSetRoot(context.req.raw, cache, context.req.param('name'))
			)
		);
		this.app.delete('/roots/:name', (context) =>
			serverErrorResponse(
				this.handleRemoveRoot(
					context.req.raw,
					DEFAULT_CACHE,
					context.req.param('name')
				)
			)
		);
		this.app.delete('/cache/:cacheName/roots/:name', (context) =>
			this.withCache(context.req.param('cacheName'), (cache) =>
				this.handleRemoveRoot(context.req.raw, cache, context.req.param('name'))
			)
		);
		this.app.post('/uploads', (context) =>
			serverErrorResponse(this.handleNegotiate(context.req.raw, DEFAULT_CACHE))
		);
		this.app.post('/cache/:cacheName/uploads', (context) =>
			this.withCache(context.req.param('cacheName'), (cache) =>
				this.handleNegotiate(context.req.raw, cache)
			)
		);
		this.app.put('/uploads/:id', (context) =>
			serverErrorResponse(
				this.handlePrepareUpload(
					context.req.raw,
					DEFAULT_CACHE,
					context.req.param('id')
				)
			)
		);
		this.app.put('/cache/:cacheName/uploads/:id', (context) =>
			this.withCache(context.req.param('cacheName'), (cache) =>
				this.handlePrepareUpload(
					context.req.raw,
					cache,
					context.req.param('id')
				)
			)
		);
		this.app.post('/uploads/:id/commit', (context) =>
			serverErrorResponse(
				this.handleCommit(
					context.req.raw,
					DEFAULT_CACHE,
					context.req.param('id')
				)
			)
		);
		this.app.post('/cache/:cacheName/uploads/:id/commit', (context) =>
			this.withCache(context.req.param('cacheName'), (cache) =>
				this.handleCommit(context.req.raw, cache, context.req.param('id'))
			)
		);
		this.app.post('/gc', (context) =>
			serverErrorResponse(this.handleGarbageCollection(context.req.raw))
		);
		this.app.post('/cache/:cacheName/gc', (context) =>
			this.withCache(context.req.param('cacheName'), (cache) =>
				this.handleGarbageCollection(context.req.raw, cache)
			)
		);
	}

	private withCache(
		cacheName: string | undefined,
		handler: (cache: string) => Promise<Response>
	): Promise<Response> {
		return serverErrorResponse(
			(async () => handler(parseRequestValue(cacheNameSchema, cacheName)))()
		);
	}

	private async handleToken(request: Request): Promise<Response> {
		const body = await parseFormBody(tokenExchangeRequestSchema, request);

		if (body.grant_type !== tokenExchangeGrantType) {
			throw new UnsupportedGrantTypeError(body.grant_type);
		}

		if (
			body.subject_token_type !== subjectTokenTypeIdToken &&
			body.subject_token_type !== subjectTokenTypeJwt
		) {
			throw new InvalidRequestError(
				`Unsupported subject_token_type: ${body.subject_token_type}`
			);
		}

		// Matching routes the token to a rule on its unverified claims; the
		// signature is then checked against that rule's issuer JWKS before any
		// cupboard token is minted, so a forged claim cannot earn a scope.
		const claims = this.decodeInbound(body.subject_token);
		const rule = matchOidcTrust(this.enabledOidcTrustRules(), claims);

		if (rule === undefined) {
			throw new InvalidGrantError('No trust rule matches the subject token');
		}

		const verified = await this.verifyInbound(rule, body.subject_token);
		const subject =
			typeof verified.sub === 'string' && verified.sub !== ''
				? verified.sub
				: rule.id;
		const ttlSeconds =
			rule.scope === 'admin' ? adminJwtTtlSeconds : writeJwtTtlSeconds;
		const accessToken = await this.mintRuleToken(rule, subject, ttlSeconds);

		return Response.json(
			{
				access_token: accessToken,
				token_type: 'Bearer',
				expires_in: ttlSeconds,
				scope: rule.scope,
				issued_token_type: issuedAccessTokenType
			} satisfies TokenResponse,
			{ headers: { 'cache-control': 'no-store' } }
		);
	}

	private async handleJwks(_request: Request): Promise<Response> {
		const keys = await this.authPublicJwks();

		// Served uncached so a key rotation is visible across colos at once.
		return Response.json(
			{ keys },
			{ headers: { 'cache-control': 'no-cache' } }
		);
	}

	private async handleStats(
		request: Request,
		cache: string
	): Promise<Response> {
		await this.requireScope(request, 'admin');

		return Response.json((await this.stats(cache)) satisfies StatsResponse);
	}

	private async handleUsage(request: Request): Promise<Response> {
		await this.requireScope(request, 'admin');

		return Response.json((await this.usage()) satisfies UsageResponse);
	}

	private async handleCacheInfo(
		request: Request,
		cacheName: string
	): Promise<Response> {
		const cache = parseRequestValue(cacheNameSchema, cacheName);
		const row = this.db
			.select({ priority: schema.caches.priority })
			.from(schema.caches)
			.where(eq(schema.caches.name, cache))
			.get();
		const info = new CacheInfo(
			CacheInfo.default.storeDirectory,
			CacheInfo.default.wantMassQuery,
			row?.priority ?? CacheInfo.default.priority
		);

		return textResponse(request, info.render(), {
			'content-type': 'text/x-nix-cache-info; charset=utf-8'
		});
	}

	private async handleListCaches(request: Request): Promise<Response> {
		await this.requireScope(request, 'admin');

		const registered = this.db.select().from(schema.caches).all();
		const caches = registered
			.map((row) => this.cacheSummary(row.name, row.priority))
			.toSorted((left, right) => (left.name > right.name ? 1 : -1));

		return Response.json({ caches } satisfies CacheListResponse);
	}

	private async handlePutCache(
		request: Request,
		cacheName: string
	): Promise<Response> {
		await this.requireScope(request, 'admin');

		const cache = parseRequestValue(cacheNameSchema, cacheName);
		const body = await parseRequestBody(cachePutBodySchema, request);

		this.db
			.insert(schema.caches)
			.values({
				name: cache,
				priority: body.priority,
				createdAt: new Date().toISOString()
			})
			.onConflictDoUpdate({
				target: schema.caches.name,
				set: { priority: body.priority }
			})
			.run();

		return Response.json(
			this.cacheSummary(cache, body.priority) satisfies CacheSummary
		);
	}

	private async handleRemoveCache(
		request: Request,
		cacheName: string
	): Promise<Response> {
		await this.requireScope(request, 'admin');

		const cache = parseRequestValue(cacheNameSchema, cacheName);
		const url = new URL(request.url);
		const force = url.searchParams.get('force') === 'true';
		const committedCount = this.cacheStorePathCount(cache);
		const registered =
			this.db
				.select()
				.from(schema.caches)
				.where(eq(schema.caches.name, cache))
				.get() !== undefined;

		if (committedCount > 0 && !force) {
			throw new CacheNotEmptyError(cache);
		}

		const storePathsRemoved = await this.tearDownCache(cache, url.origin);

		return Response.json({
			name: cache,
			removed: registered || committedCount > 0,
			storePathsRemoved
		} satisfies CacheRemoveResponse);
	}

	private async handleListPolicies(request: Request): Promise<Response> {
		await this.requireScope(request, 'admin');

		const policies = this.db
			.select()
			.from(schema.retentionPolicies)
			.all()
			.map((row) => policySummaryFromRow(row))
			.toSorted((left, right) => (left.id > right.id ? 1 : -1));

		return Response.json({ policies } satisfies RetentionPolicyListResponse);
	}

	private async handleAddPolicy(request: Request): Promise<Response> {
		await this.requireScope(request, 'admin');

		const body = await parseRequestBody(retentionPolicyAddBodySchema, request);
		const id = crypto.randomUUID();

		this.db
			.insert(schema.retentionPolicies)
			.values({
				id,
				scope: body.scope,
				pattern: body.pattern,
				defaultTtlSeconds: body.ttlSeconds,
				createdAt: new Date().toISOString()
			})
			.run();

		return Response.json({
			id,
			scope: body.scope,
			pattern: body.pattern,
			ttlSeconds: body.ttlSeconds
		} satisfies RetentionPolicySummary);
	}

	private async handleRemovePolicy(
		request: Request,
		id: string
	): Promise<Response> {
		await this.requireScope(request, 'admin');

		const existing = this.db
			.select()
			.from(schema.retentionPolicies)
			.where(eq(schema.retentionPolicies.id, id))
			.get();

		this.db
			.delete(schema.retentionPolicies)
			.where(eq(schema.retentionPolicies.id, id))
			.run();

		return Response.json({
			id,
			removed: existing !== undefined
		} satisfies RetentionPolicyRemoveResponse);
	}

	private async handleListOidcTrust(request: Request): Promise<Response> {
		await this.requireScope(request, 'admin');

		const rules = this.db
			.select()
			.from(schema.oidcTrust)
			.orderBy(asc(schema.oidcTrust.createdAt), asc(schema.oidcTrust.id))
			.all()
			.map((row) => oidcTrustSummaryFromRow(row));

		return Response.json({ rules } satisfies OidcTrustListResponse);
	}

	private async handleAddOidcTrust(request: Request): Promise<Response> {
		await this.requireScope(request, 'admin');

		const body = await parseRequestBody(oidcTrustAddBodySchema, request);
		const id = crypto.randomUUID();

		// Rules added through the API are always `write`; the only `admin` rule is
		// the owner, seeded from deploy config.
		this.db
			.insert(schema.oidcTrust)
			.values({
				id,
				issuer: body.issuer,
				audience: body.audience,
				scope: 'write',
				claimsJson: JSON.stringify(body.claims),
				allowedRootsJson: JSON.stringify(body.allowedRoots),
				createdAt: new Date().toISOString()
			})
			.run();

		return Response.json({
			id,
			issuer: body.issuer,
			audience: body.audience,
			scope: 'write',
			claims: body.claims,
			allowedRoots: body.allowedRoots,
			disabled: false
		} satisfies OidcTrustSummary);
	}

	private async handleRemoveOidcTrust(
		request: Request,
		id: string
	): Promise<Response> {
		await this.requireScope(request, 'admin');

		const existing = this.db
			.select()
			.from(schema.oidcTrust)
			.where(eq(schema.oidcTrust.id, id))
			.get();

		if (existing?.scope === 'admin') {
			throw new OwnerRuleImmutableError(id);
		}

		// Soft-disable so the audit row survives; `removed` reports whether this
		// call is what disabled an enabled rule.
		const removed = existing !== undefined && !existing.disabledAt;

		if (removed) {
			this.db
				.update(schema.oidcTrust)
				.set({ disabledAt: new Date().toISOString() })
				.where(eq(schema.oidcTrust.id, id))
				.run();
		}

		return Response.json({ id, removed } satisfies OidcTrustRemoveResponse);
	}

	private resolvePolicyTtl(cache: string, name: string): number | undefined {
		const policies = this.db
			.select()
			.from(schema.retentionPolicies)
			.all()
			.map((row) => ({
				scope: row.scope,
				pattern: row.pattern,
				ttlSeconds: row.defaultTtlSeconds
			}));

		return mostSpecificPolicy(policies, { cache, name })?.ttlSeconds;
	}

	private cacheStorePathCount(cache: string): number {
		const result = this.db
			.select({ count: count() })
			.from(schema.narInfos)
			.where(eq(schema.narInfos.cache, cache))
			.get();

		return result?.count ?? 0;
	}

	private async handleCheck(request: Request): Promise<Response> {
		await this.requireScope(request, 'admin');

		const deep = new URL(request.url).searchParams.get('deep') === 'true';

		const total =
			this.db.select({ count: count() }).from(schema.narInfos).get()?.count ??
			0;
		const rows = this.db
			.select()
			.from(schema.narInfos)
			.orderBy(asc(schema.narInfos.cache), asc(schema.narInfos.storePathHash))
			.limit(checkBatchSize)
			.all();

		const discrepancies: CheckDiscrepancy[] = [];

		// NAR blobs are content-addressed and shared, so check each distinct hash
		// once but attribute a fault to every narinfo that depends on it: the
		// operator sees each affected store path.
		const blobVerdicts = new Map<
			string,
			CheckDiscrepancy['kind'] | undefined
		>();
		let narBlobsChecked = 0;

		for (const row of rows) {
			const narInfoObject = await this.env.BLOBS.head(
				narInfoObjectKey(row.storePathHash, row.cache)
			);

			if (narInfoObject === null) {
				discrepancies.push({
					kind: 'missing-narinfo-object',
					cache: row.cache,
					storePathHash: row.storePathHash,
					narHash: row.narHash
				});
			}

			if (!blobVerdicts.has(row.narHash)) {
				blobVerdicts.set(row.narHash, await this.checkNarBlob(row, deep));
				narBlobsChecked += 1;
			}

			const blobVerdict = blobVerdicts.get(row.narHash);

			if (blobVerdict !== undefined) {
				discrepancies.push({
					kind: blobVerdict,
					cache: row.cache,
					storePathHash: row.storePathHash,
					narHash: row.narHash
				});
			}
		}

		return Response.json({
			narInfosChecked: rows.length,
			narBlobsChecked,
			complete: rows.length === total,
			discrepancies
		} satisfies CheckReport);
	}

	private async checkNarBlob(
		row: typeof schema.narInfos.$inferSelect,
		deep: boolean
	): Promise<CheckDiscrepancy['kind'] | undefined> {
		const object =
			(await this.env.BLOBS.head(narObjectKey(row.narHash))) ?? undefined;

		if (object === undefined) {
			return 'missing-nar';
		}

		if (!deep) {
			return undefined;
		}

		// The compressed checksum to verify against is the canonical fact in
		// `blob_state`, not a field on the narinfo row. When it is present, check the
		// stored object's `fileHash`/`fileSize`; the uncompressed re-derivation below
		// runs regardless, since it needs only the row's `narHash`/`narSize`.
		const blobFact = await this.d1
			.select({
				fileHash: d1Schema.blobState.fileHash,
				fileSize: d1Schema.blobState.fileSize
			})
			.from(d1Schema.blobState)
			.where(eq(d1Schema.blobState.narHash, row.narHash))
			.get();

		if (blobFact !== undefined) {
			try {
				verifyStoredBlob(object, {
					narHash: row.narHash,
					fileHash: blobFact.fileHash,
					fileSize: blobFact.fileSize
				});
			} catch (error) {
				if (
					error instanceof UploadedObjectSizeMismatchError ||
					error instanceof UploadedObjectChecksumMissingError ||
					error instanceof UploadedObjectChecksumMismatchError
				) {
					return 'file-hash-mismatch';
				}

				throw error;
			}
		}

		// A deep check also re-derives the uncompressed NAR hash, catching a stored
		// blob whose bytes no longer match the hash its narinfo signed.
		const blob = await this.env.BLOBS.get(narObjectKey(row.narHash));

		if (blob === null) {
			return 'missing-nar';
		}

		const verification = await verifyDecompressedNar(
			blob.body as ReadableStream<Uint8Array>,
			{ narHash: row.narHash, narSize: row.narSize }
		);

		if (!verification.ok) {
			return verification.reason;
		}

		return undefined;
	}

	private async handleVerify(request: Request): Promise<Response> {
		await this.requireScope(request, 'admin');

		// Interactive verify purges this colo's edge cache via the caller's public
		// origin; the cron sweep arrives on the internal origin, cannot know the
		// public URL, and relies on the narinfo TTL and the orphan-blob grace
		// window instead, exactly as GC does.
		const url = new URL(request.url);
		const purgeOrigin = url.origin === internalOrigin ? undefined : url.origin;
		const requested = url.searchParams.get('limit');
		const limit =
			requested === null
				? verificationBatchSize
				: Math.min(
						parseRequestValue(verificationLimitSchema, requested),
						verificationBatchSize
					);

		await this.verifyPendingUploads(limit);

		return Response.json(await this.verifyBatch(purgeOrigin, limit));
	}

	private verifyBatch(
		origin: string | undefined,
		limit: number
	): Promise<VerifyReport> {
		// The whole batch runs in one critical section: the cursor read, the
		// per-row re-materialise/reconcile, and the cursor advance must not
		// interleave with a commit or a delete.
		return this.ctx.blockConcurrencyWhile(async () => {
			const cursor = this.db
				.select()
				.from(schema.verificationCursor)
				.where(eq(schema.verificationCursor.id, 'active'))
				.get();
			// An empty cursor starts (or restarts) at the lowest (cache, hash): the
			// empty string sorts before every cache name and every 32-character hash.
			const fromCache = cursor?.cache ?? '';
			const fromHash = cursor?.lastStorePathHash ?? '';

			// Verification spans every cache, walking the (cache, store_path_hash)
			// space in order and resuming after the composite cursor. drizzle has no
			// tuple form of `gt`, so the row-value comparison is spelt out.
			const rows = this.db
				.select()
				.from(schema.narInfos)
				.where(
					or(
						gt(schema.narInfos.cache, fromCache),
						and(
							eq(schema.narInfos.cache, fromCache),
							gt(schema.narInfos.storePathHash, fromHash)
						)
					)
				)
				.orderBy(asc(schema.narInfos.cache), asc(schema.narInfos.storePathHash))
				.limit(limit)
				.all();

			let narInfoObjectsRestored = 0;
			let danglingNarInfosRemoved = 0;

			for (const row of rows) {
				const narPresent =
					(await this.env.BLOBS.head(narObjectKey(row.narHash))) !== null;

				if (!narPresent) {
					await this.reconcileMissingNar(row, origin);
					danglingNarInfosRemoved += 1;
					continue;
				}

				const narInfoObject = await this.env.BLOBS.head(
					narInfoObjectKey(row.storePathHash, row.cache)
				);

				if (narInfoObject === null) {
					const narInfo = await this.narInfoFromRow(row);

					if (narInfo !== undefined) {
						await this.putNarInfoObject(row.cache, row.storePathHash, narInfo);
						narInfoObjectsRestored += 1;
					}
				}
			}

			// A short batch means the scan reached the end; clear the cursor so the
			// next pass starts again from the first cache's lowest hash.
			const wrapped = rows.length < limit;
			const last = rows.at(-1);
			const nextCache = wrapped || last === undefined ? '' : last.cache;
			const nextHash = wrapped || last === undefined ? '' : last.storePathHash;
			const now = new Date().toISOString();

			this.db
				.insert(schema.verificationCursor)
				.values({
					id: 'active',
					cache: nextCache,
					lastStorePathHash: nextHash,
					updatedAt: now
				})
				.onConflictDoUpdate({
					target: schema.verificationCursor.id,
					set: { cache: nextCache, lastStorePathHash: nextHash, updatedAt: now }
				})
				.run();

			return {
				scanned: rows.length,
				narInfoObjectsRestored,
				danglingNarInfosRemoved,
				cursor: nextHash,
				cursorCache: nextCache,
				wrapped
			} satisfies VerifyReport;
		});
	}

	private cacheSummary(cache: string, priority: number): CacheSummary {
		return {
			name: cache,
			priority,
			storePaths: this.cacheStorePathCount(cache)
		};
	}

	// Drops a named cache: removes its narinfo rows (row-first, queuing each for
	// edge retirement), its roots, and the registry entry, then flushes the deletion
	// queue to retire the edges. The reaper later collects the now-unreferenced
	// shared blobs. Returns the number of store paths removed.
	private tearDownCache(cache: string, origin: string): Promise<number> {
		return this.ctx.blockConcurrencyWhile(async () => {
			const now = new Date().toISOString();
			const committed = this.db
				.select({
					storePathHash: schema.narInfos.storePathHash,
					narHash: schema.narInfos.narHash,
					generation: schema.narInfos.generation
				})
				.from(schema.narInfos)
				.where(eq(schema.narInfos.cache, cache))
				.all();

			this.db.transaction((tx) => {
				for (const path of committed) {
					tx.delete(schema.narInfos)
						.where(
							and(
								eq(schema.narInfos.cache, cache),
								eq(schema.narInfos.storePathHash, path.storePathHash)
							)
						)
						.run();
					this.enqueueNarInfoDeletion(
						tx,
						cache,
						path.storePathHash,
						path.narHash,
						path.generation,
						now
					);
				}

				tx.delete(schema.retentionRootTargets)
					.where(eq(schema.retentionRootTargets.cache, cache))
					.run();
				tx.delete(schema.retentionRoots)
					.where(eq(schema.retentionRoots.cache, cache))
					.run();
				tx.delete(schema.caches).where(eq(schema.caches.name, cache)).run();
				// Drop in-flight uploads negotiated under this cache so a pending
				// commit cannot resurrect it after teardown.
				tx.delete(schema.pendingUploads)
					.where(eq(schema.pendingUploads.cache, cache))
					.run();
			});

			await this.flushQueuedNarInfoDeletions(origin);

			return committed.length;
		});
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

	private async handleAuthKeyList(request: Request): Promise<Response> {
		await this.requireScope(request, 'admin');

		return Response.json({
			keys: await this.authKeySummaries()
		} satisfies AuthKeyListResponse);
	}

	private async handleAuthKeyRotate(request: Request): Promise<Response> {
		await this.requireScope(request, 'admin');

		return Response.json(
			(await this.rotateAuthKey()) satisfies AuthKeyRotateResponse
		);
	}

	private async handleAuthKeyRetire(
		request: Request,
		kid: string
	): Promise<Response> {
		await this.requireScope(request, 'admin');

		return Response.json(
			(await this.retireAuthKey(kid)) satisfies AuthKeyRetireResponse
		);
	}

	private async handleDeletePath(
		request: Request,
		cache: string,
		hash: string
	): Promise<Response> {
		await this.requireScope(request, 'admin');

		const storePathHash = parseRequestValue(storePathHashSchema, hash);
		const result = await this.deleteStorePath(
			cache,
			storePathHash,
			new URL(request.url).origin
		);

		return Response.json(result satisfies DeletePathResponse);
	}

	private async handleSetRoot(
		request: Request,
		cache: string,
		name: string
	): Promise<Response> {
		const claims = await this.requireScope(request, 'write');
		const rootName = parseRequestValue(rootNameSchema, name);

		this.enforceRootConstraint(claims, rootName);

		const body = await parseRequestBody(rootSetBodySchema, request);
		const requested: RootSetCommand = {
			name: rootName,
			targets: resolveRootTargets(body.targets),
			ttlSeconds: body.ttlSeconds
		};

		return Response.json(
			this.setRoot(cache, requested) satisfies RootSetResponse
		);
	}

	private enforceRootConstraint(claims: AccessClaims, rootName: string): void {
		// An admin token (owner) may set any root. A write token (CI) may set only
		// the roots its `cb_roots` permits; carrying none — absent or empty — it
		// may set nothing.
		if (claims.scope === 'admin') {
			return;
		}

		const permitted = claims.cbRoots ?? [];

		if (permitted.some((entry) => rootWithinConstraint(rootName, entry))) {
			return;
		}

		throw new RootNotPermittedError(rootName);
	}

	private async handleListRoots(
		request: Request,
		cache: string
	): Promise<Response> {
		await this.requireScope(request, 'admin');

		return Response.json(this.listRoots(cache) satisfies RootListResponse);
	}

	private async handleRemoveRoot(
		request: Request,
		cache: string,
		name: string
	): Promise<Response> {
		await this.requireScope(request, 'admin');

		const rootName = parseRequestValue(rootNameSchema, name);

		return Response.json(
			this.removeRoot(cache, rootName) satisfies RootRemoveResponse
		);
	}

	private loadOrCreateCache(cache: string): void {
		// The default cache is seeded at init; a named cache is registered with
		// the default priority on first write and adjusted later via PUT /caches.
		if (cache === DEFAULT_CACHE) {
			return;
		}

		this.db
			.insert(schema.caches)
			.values({
				name: cache,
				priority: CacheInfo.default.priority,
				createdAt: new Date().toISOString()
			})
			.onConflictDoNothing()
			.run();
	}

	private setRoot(cache: string, request: RootSetCommand): RootSetResponse {
		const now = new Date();
		const nowIso = now.toISOString();
		// Precedence: an explicit TTL, then a matching retention policy, then the
		// cold-path default for an implicit pin, otherwise permanent.
		const expiresAt = resolveRootExpiry({
			explicitTtlSeconds: request.ttlSeconds,
			policyTtlSeconds: this.resolvePolicyTtl(cache, request.name),
			name: request.name,
			coldPathTtlSeconds: coldPathTtlSeconds(this.env),
			now
		});

		this.loadOrCreateCache(cache);

		// Replace the root wholesale: a re-set fully declares the channel, so the
		// old row and target set are dropped and rewritten. The createdAt of an
		// existing channel is preserved; an absent expiry stores SQL NULL via the
		// undefined insert value.
		const createdAt = this.db.transaction((tx) => {
			const existing = tx
				.select()
				.from(schema.retentionRoots)
				.where(
					and(
						eq(schema.retentionRoots.cache, cache),
						eq(schema.retentionRoots.name, request.name)
					)
				)
				.get();
			const created = existing?.createdAt ?? nowIso;

			tx.delete(schema.retentionRootTargets)
				.where(
					and(
						eq(schema.retentionRootTargets.cache, cache),
						eq(schema.retentionRootTargets.rootName, request.name)
					)
				)
				.run();
			tx.delete(schema.retentionRoots)
				.where(
					and(
						eq(schema.retentionRoots.cache, cache),
						eq(schema.retentionRoots.name, request.name)
					)
				)
				.run();

			tx.insert(schema.retentionRoots)
				.values({
					cache,
					name: request.name,
					expiresAt,
					createdAt: created,
					updatedAt: nowIso
				})
				.run();

			tx.insert(schema.retentionRootTargets)
				.values(
					request.targets.map((target) => ({
						cache,
						rootName: request.name,
						storePathHash: target.storePathHash,
						storePath: target.storePath
					}))
				)
				.run();

			return created;
		});

		return this.rootSummary(
			cache,
			request.name,
			expiresAt,
			createdAt,
			nowIso,
			nowIso
		);
	}

	private async listRoots(cache: string): Promise<RootListResponse> {
		const now = new Date().toISOString();
		const roots = this.db
			.select()
			.from(schema.retentionRoots)
			.where(eq(schema.retentionRoots.cache, cache))
			.all();

		return {
			roots: (
				await Promise.all(
					roots.map((root) =>
						this.rootSummary(
							cache,
							root.name,
							root.expiresAt ?? undefined,
							root.createdAt,
							root.updatedAt,
							now
						)
					)
				)
			).toSorted((a, b) => (a.name > b.name ? 1 : -1))
		};
	}

	private removeRoot(cache: string, name: string): RootRemoveResponse {
		return this.db.transaction((tx) => {
			const existing = tx
				.select()
				.from(schema.retentionRoots)
				.where(
					and(
						eq(schema.retentionRoots.cache, cache),
						eq(schema.retentionRoots.name, name)
					)
				)
				.get();

			tx.delete(schema.retentionRootTargets)
				.where(
					and(
						eq(schema.retentionRootTargets.cache, cache),
						eq(schema.retentionRootTargets.rootName, name)
					)
				)
				.run();
			tx.delete(schema.retentionRoots)
				.where(
					and(
						eq(schema.retentionRoots.cache, cache),
						eq(schema.retentionRoots.name, name)
					)
				)
				.run();

			return { name, removed: existing !== undefined };
		});
	}

	private async rootSummary(
		cache: string,
		name: string,
		expiresAt: string | undefined,
		createdAt: string,
		updatedAt: string,
		now: string
	): Promise<RootSummary> {
		const targets = this.db
			.select()
			.from(schema.retentionRootTargets)
			.where(
				and(
					eq(schema.retentionRootTargets.cache, cache),
					eq(schema.retentionRootTargets.rootName, name)
				)
			)
			.all();

		return {
			name,
			...(expiresAt === undefined ? {} : { expiresAt }),
			expired: expiresAt !== undefined && expiresAt <= now,
			createdAt,
			updatedAt,
			targets: await this.rootTargets(cache, targets)
		};
	}

	private async rootTargets(
		cache: string,
		pairs: readonly { storePathHash: string; storePath: string }[]
	): Promise<RootTarget[]> {
		const targets = await Promise.all(
			pairs.map(async (pair) => ({
				storePathHash: pair.storePathHash,
				storePath: pair.storePath,
				present: await this.hasCommittedNarInfo(cache, pair.storePathHash)
			}))
		);

		return targets.toSorted((a, b) =>
			a.storePathHash > b.storePathHash ? 1 : -1
		);
	}

	private async hasCommittedNarInfo(
		cache: string,
		storePathHash: string
	): Promise<boolean> {
		const row = this.db
			.select()
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cache, cache),
					eq(schema.narInfos.storePathHash, storePathHash)
				)
			)
			.get();

		return row === undefined ? false : this.hasCommittedReference(cache, row);
	}

	private async hasCommittedReference(
		cache: string,
		row: typeof schema.narInfos.$inferSelect
	): Promise<boolean> {
		const reference = await this.d1
			.select({ narHash: d1Schema.blobReference.narHash })
			.from(d1Schema.blobReference)
			.where(
				and(
					eq(d1Schema.blobReference.tenant, singleTenant),
					eq(d1Schema.blobReference.cache, cache),
					eq(d1Schema.blobReference.storePathHash, row.storePathHash),
					eq(d1Schema.blobReference.generation, row.generation),
					eq(d1Schema.blobReference.narHash, row.narHash)
				)
			)
			.get();

		return reference !== undefined;
	}

	private async committedNarInfoRow(
		cache: string,
		storePathHash: string
	): Promise<typeof schema.narInfos.$inferSelect | undefined> {
		const row = this.db
			.select()
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cache, cache),
					eq(schema.narInfos.storePathHash, storePathHash)
				)
			)
			.get();

		if (row === undefined) {
			return undefined;
		}

		return (await this.hasCommittedReference(cache, row)) ? row : undefined;
	}

	private async handleNegotiate(
		request: Request,
		cache: string
	): Promise<Response> {
		await this.requireScope(request, 'write');

		const body = await parseRequestBody(uploadNegotiateRequestSchema, request);
		const uploads: UploadDecision[] = [];

		for (const metadata of body.paths) {
			const existingNarInfo = this.db
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
				const object = await this.env.BLOBS.head(
					narObjectKey(existingNarInfo.narHash)
				);
				const committed = await this.hasCommittedReference(
					cache,
					existingNarInfo
				);

				if (object !== null && committed) {
					await this.ensureNarInfoObject(cache, existingNarInfo.storePathHash);
					uploads.push({
						action: 'skip',
						storePathHash: metadata.storePathHash,
						narHash: existingNarInfo.narHash
					});
					continue;
				}

				if (committed) {
					await this.removeStaleNarInfo(
						existingNarInfo,
						new URL(request.url).origin
					);
				}
			}

			const existingBlob = await this.findReusableBlob(metadata.narHash);
			const uploadId = crypto.randomUUID();
			const now = new Date();
			const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);
			const pendingMetadata:
				| UploadPathNegotiationFields
				| UploadPathMetadataFields =
				existingBlob === undefined
					? metadata
					: {
							...commitMetadataFromPathAndBlob(metadata, existingBlob),
							// Sign the blob's verified narSize, never the client's declared
							// one: a reuse skips re-verification, so an unchecked size must
							// not reach the signed narinfo.
							narSize: existingBlob.narSize
						};
			// A fresh upload stages its bytes under a private, per-upload key; a reuse
			// commits against the canonical blob it already found. Keeping uploads off
			// the shared key means no client write can ever race or overwrite it.
			const r2Key =
				existingBlob === undefined
					? stagingObjectKey(uploadId)
					: narObjectKey(metadata.narHash);

			this.db
				.insert(schema.pendingUploads)
				.values({
					id: uploadId,
					// Bind the upload to its cache so a prepare or commit cannot
					// redirect it to a different one.
					cache,
					narHash: metadata.narHash,
					r2Key,
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
				r2Key,
				expiresAt: expiresAt.toISOString()
			});
		}

		return Response.json({ uploads } satisfies UploadNegotiateResponse);
	}

	private async handlePrepareUpload(
		request: Request,
		cache: string,
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

		if (pending.cache !== cache) {
			throw new UploadCacheMismatchError(uploadId, pending.cache, cache);
		}

		if (pending.expiresAt < new Date().toISOString()) {
			await this.clearPendingUploadAndStaging(
				uploadId,
				pending.r2Key,
				pending.narHash
			);

			throw new UploadExpiredError(uploadId);
		}

		// A reuse upload's r2Key is the shared canonical key. It needs no upload, so
		// it is never prepared; reject it explicitly rather than presign a write
		// straight onto the shared CAS object (which the reuse commit would not
		// re-verify). The client should commit a reuse decision directly.
		if (pending.r2Key === narObjectKey(pending.narHash)) {
			throw new ReusableUploadNotPreparableError(uploadId);
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
				pending.r2Key,
				metadata.fileHash,
				expiresAt
			),
			uploadHeaders: uploadHeadersFor(metadata),
			expiresAt: expiresAt.toISOString()
		} satisfies UploadPrepareResponse);
	}

	private async findReusableBlob(
		narHash: string
	): Promise<typeof d1Schema.blobState.$inferSelect | undefined> {
		const existingBlob = await this.d1
			.select()
			.from(d1Schema.blobState)
			.where(eq(d1Schema.blobState.narHash, narHash))
			.get();

		if (existingBlob === undefined) {
			return undefined;
		}

		const object = await this.env.BLOBS.head(narObjectKey(narHash));

		// The object is gone: do not reuse, and leave the stale `blob_state` row for
		// the reaper to collect. A correct re-upload of the hash heals it.
		if (object === null) {
			return undefined;
		}

		// Reusing is a fresh reference, so cancel any reaper grace timer before the
		// commit binds a new edge to the hash.
		if (existingBlob.deleteAfter !== null) {
			await this.d1
				.update(d1Schema.blobState)
				.set({ deleteAfter: sql`null` })
				.where(eq(d1Schema.blobState.narHash, narHash))
				.run();
		}

		return existingBlob;
	}

	// The global blob reaper, driven by the maintenance pass. It works the shared
	// `blob_state` facts in two bounded passes: arm every blob no live `blob_ref`
	// references with a grace timer, then collect those whose grace has elapsed and
	// that are still unreferenced. Returns how many shared blobs it collected.
	private async reapBlobs(now: Date, limit: number): Promise<number> {
		await this.armUnreferencedBlobs(now, limit);

		return this.collectExpiredBlobs(now, limit);
	}

	// Arms unreferenced shared blobs with a grace timer. The cross-tenant
	// "referenced anywhere" probe is on `blob_ref.nar_hash` (its dedicated index),
	// not any one tenant's narinfos. Bounded: only a batch is armed per pass, and a
	// commit that re-references a hash clears the timer it set.
	private async armUnreferencedBlobs(now: Date, limit: number): Promise<void> {
		const deleteAfter = new Date(
			now.getTime() + blobReaperGraceMs
		).toISOString();
		const candidates = await this.d1
			.select({ narHash: d1Schema.blobState.narHash })
			.from(d1Schema.blobState)
			.where(
				and(
					isNull(d1Schema.blobState.deleteAfter),
					notInArray(
						d1Schema.blobState.narHash,
						this.d1
							.select({ narHash: d1Schema.blobReference.narHash })
							.from(d1Schema.blobReference)
					)
				)
			)
			.limit(limit)
			.all();

		if (candidates.length === 0) {
			return;
		}

		await this.d1
			.update(d1Schema.blobState)
			.set({ deleteAfter })
			.where(
				and(
					inArray(
						d1Schema.blobState.narHash,
						candidates.map((candidate) => candidate.narHash)
					),
					isNull(d1Schema.blobState.deleteAfter)
				)
			)
			.run();
	}

	// Collects armed shared blobs whose grace has elapsed. Each is removed by a
	// single compare-and-delete that re-checks armed, elapsed and unreferenced
	// atomically, so a blob re-referenced or re-armed since the scan is never taken;
	// the D1 fact is deleted before the R2 object (D1-first/R2-last), so a crash
	// between them leaves only a harmless orphan object the next promote adopts.
	private async collectExpiredBlobs(now: Date, limit: number): Promise<number> {
		const nowIso = now.toISOString();
		const expired = await this.d1
			.select({ narHash: d1Schema.blobState.narHash })
			.from(d1Schema.blobState)
			.where(
				and(
					isNotNull(d1Schema.blobState.deleteAfter),
					lte(d1Schema.blobState.deleteAfter, nowIso)
				)
			)
			.limit(limit)
			.all();
		let collected = 0;

		for (const blob of expired) {
			const removed = await this.d1
				.delete(d1Schema.blobState)
				.where(
					and(
						eq(d1Schema.blobState.narHash, blob.narHash),
						isNotNull(d1Schema.blobState.deleteAfter),
						lte(d1Schema.blobState.deleteAfter, nowIso),
						notInArray(
							d1Schema.blobState.narHash,
							this.d1
								.select({ narHash: d1Schema.blobReference.narHash })
								.from(d1Schema.blobReference)
						)
					)
				)
				.returning({ narHash: d1Schema.blobState.narHash })
				.all();

			if (removed.length > 0) {
				await this.env.BLOBS.delete(narObjectKey(blob.narHash));
				collected += 1;
			}
		}

		return collected;
	}

	private enqueueNarInfoDeletion(
		handle: SchemaWriter,
		cache: string,
		storePathHash: string,
		narHash: string,
		generation: number,
		now: string
	): void {
		handle
			.insert(schema.narInfoDeletions)
			.values({ cache, storePathHash, narHash, generation, createdAt: now })
			.onConflictDoUpdate({
				target: [
					schema.narInfoDeletions.cache,
					schema.narInfoDeletions.storePathHash,
					schema.narInfoDeletions.generation
				],
				set: { narHash, createdAt: now }
			})
			.run();
	}

	// Retires the D1 reference edge for one captured narinfo version, then drops the
	// tenant's `tenant_blob` presence once it holds no more edges for the hash. The
	// edge delete targets the exact `(tenant, cache, store_path_hash, generation)`,
	// so a newer recommitted edge is never touched.
	private async retireBlobRefEdge(
		cache: string,
		storePathHash: string,
		generation: number,
		narHash: string
	): Promise<void> {
		await this.d1
			.delete(d1Schema.blobReference)
			.where(
				and(
					eq(d1Schema.blobReference.tenant, singleTenant),
					eq(d1Schema.blobReference.cache, cache),
					eq(d1Schema.blobReference.storePathHash, storePathHash),
					eq(d1Schema.blobReference.generation, generation)
				)
			)
			.run();

		const stillReferenced = await this.d1
			.select({ narHash: d1Schema.blobReference.narHash })
			.from(d1Schema.blobReference)
			.where(
				and(
					eq(d1Schema.blobReference.tenant, singleTenant),
					eq(d1Schema.blobReference.narHash, narHash)
				)
			)
			.get();

		if (stillReferenced === undefined) {
			await this.d1
				.delete(d1Schema.tenantBlob)
				.where(
					and(
						eq(d1Schema.tenantBlob.tenant, singleTenant),
						eq(d1Schema.tenantBlob.narHash, narHash)
					)
				)
				.run();
		}
	}

	// Whether no committed narinfo, in any tenant, still references this NAR hash —
	// the "safe to reclaim" probe, on `blob_ref` (its indexed `nar_hash`) rather than
	// any one tenant's narinfos. The reaper does the actual reclamation against
	// `blob_state.delete_after`; a delete only reports this so a client learns its
	// NAR became unreferenced.
	private async blobHashUnreferenced(narHash: string): Promise<boolean> {
		const referenced = await this.d1
			.select({ narHash: d1Schema.blobReference.narHash })
			.from(d1Schema.blobReference)
			.where(eq(d1Schema.blobReference.narHash, narHash))
			.get();

		return referenced === undefined;
	}

	private clearQueuedNarInfoDeletion(
		cache: string,
		storePathHash: string,
		generation: number
	): void {
		this.db
			.delete(schema.narInfoDeletions)
			.where(
				and(
					eq(schema.narInfoDeletions.cache, cache),
					eq(schema.narInfoDeletions.storePathHash, storePathHash),
					eq(schema.narInfoDeletions.generation, generation)
				)
			)
			.run();
	}

	private async flushQueuedNarInfoDeletions(origin?: string): Promise<number> {
		const queued = this.db.select().from(schema.narInfoDeletions).all();
		let deleted = 0;

		for (const entry of queued) {
			const { objectDeleted } = await this.deleteQueuedNarInfo(
				entry.cache,
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
		cache: string,
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
					eq(schema.narInfoDeletions.cache, cache),
					eq(schema.narInfoDeletions.storePathHash, storePathHash),
					eq(schema.narInfoDeletions.generation, generation)
				)
			)
			.get();

		if (queued === undefined) {
			return { objectDeleted: false, narScheduledForDeletion: false };
		}

		// Retire this captured narinfo version's edge first (compare-and-delete by
		// generation): it is stale whether or not the path has since recommitted at
		// a newer generation, and dropping it is what lets the shared blob be
		// reclaimed once nothing references the hash.
		await this.retireBlobRefEdge(
			cache,
			storePathHash,
			queued.generation,
			queued.narHash
		);

		// The row is truth: a re-committed path owns a live object again, so drop
		// the stale cleanup rather than delete the new object. Its old NAR may still
		// be unreferenced now (a recommit at a different hash), so still consider it.
		const reCommitted =
			this.db
				.select()
				.from(schema.narInfos)
				.where(
					and(
						eq(schema.narInfos.cache, cache),
						eq(schema.narInfos.storePathHash, storePathHash)
					)
				)
				.get() !== undefined;

		if (reCommitted) {
			const narScheduledForDeletion = await this.blobHashUnreferenced(
				queued.narHash
			);
			this.clearQueuedNarInfoDeletion(cache, storePathHash, generation);
			return { objectDeleted: false, narScheduledForDeletion };
		}

		await this.env.BLOBS.delete(narInfoObjectKey(storePathHash, cache));

		if (origin !== undefined) {
			await this.purgeCachedNarInfo(
				`${origin}${narInfoCachePath(storePathHash, cache)}`
			);
		}

		// Report whether the NAR is now unreferenced (the reaper will reclaim it).
		// Re-check against the live edges: a path may have committed the same NAR
		// since the row was removed.
		const narScheduledForDeletion = await this.blobHashUnreferenced(
			queued.narHash
		);

		this.clearQueuedNarInfoDeletion(cache, storePathHash, generation);

		return { objectDeleted: true, narScheduledForDeletion };
	}

	private async handleCommit(
		request: Request,
		cache: string,
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

		if (pending.cache !== cache) {
			throw new UploadCacheMismatchError(uploadId, pending.cache, cache);
		}

		if (pending.expiresAt < new Date().toISOString()) {
			await this.clearPendingUploadAndStaging(
				uploadId,
				pending.r2Key,
				pending.narHash
			);

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

			if (!(await this.hasCommittedReference(cache, existingNarInfo))) {
				return Response.json({
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash,
					status: 'pending'
				} satisfies CommitResponse);
			}

			// A concurrent commit already holds the path: heal its object if missing
			// and concede, reclaiming this upload's own staging.
			await this.ensureNarInfoObject(cache, existingNarInfo.storePathHash);
			await this.clearPendingUploadAndStaging(
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

		const object = (await this.env.BLOBS.head(pending.r2Key)) ?? undefined;

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
			await this.clearPendingUploadAndStaging(
				uploadId,
				pending.r2Key,
				metadata.narHash
			);

			throw new NarTooLargeError(metadata.narSize, verifiableMaxBytes);
		}

		if (metadata.narSize > inlineVerifyMaxBytes) {
			this.markUploadPending(uploadId);

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
		this.markUploadCommitting(uploadId);

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
			await this.ctx.blockConcurrencyWhile(() =>
				this.reclaimReservedRow(
					cache,
					metadata.storePathHash,
					reserved.generation,
					metadata.narHash
				)
			);
			await this.clearPendingUploadAndStaging(
				uploadId,
				stagingKey,
				metadata.narHash
			);

			throw new NarVerificationFailedError(stagingKey, verification.reason);
		}

		await this.promoteStagingBlob(stagingKey, metadata);

		const outcome = await this.ctx.blockConcurrencyWhile(() =>
			this.materialiseServable(cache, metadata, reserved.generation, uploadId)
		);

		if (outcome !== 'materialised') {
			return this.concedeToWinner(cache, uploadId, metadata, stagingKey);
		}

		await this.env.BLOBS.delete(stagingKey);

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
		this.markUploadCommitting(uploadId);

		const canonicalKey = narObjectKey(metadata.narHash);
		const reserved = await this.reserveNarInfoRow(cache, metadata);

		if (reserved.kind !== 'reserved') {
			return this.concedeToWinner(cache, uploadId, metadata, canonicalKey);
		}

		const outcome = await this.ctx.blockConcurrencyWhile(() =>
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

		await this.ctx.blockConcurrencyWhile(() =>
			this.reclaimReservedRow(
				cache,
				metadata.storePathHash,
				reserved.generation,
				metadata.narHash
			)
		);
		this.clearPendingUpload(uploadId);

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
		const winner = await this.committedNarInfoRow(
			cache,
			metadata.storePathHash
		);

		if (winner !== undefined) {
			await this.ensureNarInfoObject(cache, winner.storePathHash);
		}

		await this.clearPendingUploadAndStaging(
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

	// Promotes verified staging bytes into the shared, content-addressed CAS and
	// returns the canonical object's compressed metadata. The canonical key is
	// write-once: a conditional put means the first promotion of a hash fixes the
	// stored encoding, and any later or concurrent upload of the same hash adopts
	// that encoding instead of overwriting it — so every narinfo for the hash
	// advertises the one object that is actually served, even when tenants upload
	// different zstd encodings of the same NAR. The staging object is left in place;
	// its caller deletes it only once the commit is durable, so a crash between
	// promotion and commit recovers from the surviving staging copy.
	private async promoteStagingBlob(
		stagingKey: string,
		metadata: UploadPathMetadataFields
	): Promise<CanonicalBlob> {
		const canonical = await this.ensureCanonicalObject(stagingKey, metadata);

		// Record the shared fact together with the object, so `blob_state` exists
		// exactly when the canonical R2 object does. The first writer for a hash
		// fixes the metadata; a concurrent or repeated promotion keeps it, but clears
		// any reaper grace timer, since promoting is a fresh reference to the hash.
		await this.d1
			.insert(d1Schema.blobState)
			.values({
				narHash: metadata.narHash,
				fileHash: canonical.fileHash,
				fileSize: canonical.fileSize,
				compression: metadata.compression,
				narSize: metadata.narSize,
				verifiedAt: new Date().toISOString()
			})
			.onConflictDoUpdate({
				target: d1Schema.blobState.narHash,
				set: { deleteAfter: sql`null` }
			})
			.run();

		return canonical;
	}

	private async ensureCanonicalObject(
		stagingKey: string,
		metadata: UploadPathMetadataFields
	): Promise<CanonicalBlob> {
		const canonicalKey = narObjectKey(metadata.narHash);
		const existing = await this.env.BLOBS.head(canonicalKey);

		if (existing !== null) {
			return canonicalBlobOf(canonicalKey, existing);
		}

		const staged = await this.env.BLOBS.get(stagingKey);

		if (staged === null) {
			throw new UploadedObjectNotFoundError(stagingKey);
		}

		const written = await this.env.BLOBS.put(canonicalKey, staged.body, {
			sha256: NixSha256Hash.parse(metadata.fileHash).digestBytes(),
			onlyIf: { etagDoesNotMatch: '*' }
		});

		if (written !== null) {
			return { fileHash: metadata.fileHash, fileSize: metadata.fileSize };
		}

		// A concurrent promotion won between the head and the conditional put: adopt
		// the stored encoding so this narinfo matches the object that is served.
		const winner = await this.env.BLOBS.head(canonicalKey);

		if (winner === null) {
			throw new UploadedObjectNotFoundError(canonicalKey);
		}

		return canonicalBlobOf(canonicalKey, winner);
	}

	// Clears an abandoned pending upload's record, deleting its private staging
	// object first so the durable handle to that object is never dropped before the
	// object itself. A reuse upload's r2Key is the shared canonical key, which must
	// survive; only a per-upload staging key is removed. It awaits R2 I/O, so it is
	// called outside any critical section.
	private async clearPendingUploadAndStaging(
		uploadId: string,
		r2Key: string,
		narHash: string
	): Promise<void> {
		if (r2Key !== narObjectKey(narHash)) {
			await this.env.BLOBS.delete(r2Key);
		}

		this.clearPendingUpload(uploadId);
	}

	// Renders a narinfo by joining the tenant row (identity, uncompressed NarHash/
	// NarSize, references, signature) with the canonical compressed metadata in
	// `blob_state` — the narinfo row holds no compressed fields of its own. Returns
	// undefined when the shared fact is gone (a demoted blob), so the caller leaves
	// the path non-servable until a re-upload heals it.
	private async narInfoFromRow(
		row: typeof schema.narInfos.$inferSelect
	): Promise<NarInfo | undefined> {
		const blob = await this.d1
			.select({
				fileHash: d1Schema.blobState.fileHash,
				fileSize: d1Schema.blobState.fileSize,
				compression: d1Schema.blobState.compression
			})
			.from(d1Schema.blobState)
			.where(eq(d1Schema.blobState.narHash, row.narHash))
			.get();

		if (blob === undefined) {
			return undefined;
		}

		return new NarInfo(
			row.storePath,
			narObjectKey(row.narHash),
			blob.compression,
			blob.fileHash,
			blob.fileSize,
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

	private async ensureNarInfoObject(
		cache: string,
		storePathHash: string
	): Promise<void> {
		// Runs in a critical section, and against a freshly read row, so it cannot
		// race a delete: a concurrent delete that removed the row after the caller
		// read it must not be undone by re-materialising the object from a stale
		// copy.
		await this.ctx.blockConcurrencyWhile(async () => {
			const row = this.db
				.select()
				.from(schema.narInfos)
				.where(
					and(
						eq(schema.narInfos.cache, cache),
						eq(schema.narInfos.storePathHash, storePathHash)
					)
				)
				.get();

			if (row === undefined) {
				return;
			}

			if (!(await this.hasCommittedReference(cache, row))) {
				await this.env.BLOBS.delete(narInfoObjectKey(storePathHash, cache));
				return;
			}

			const existing = await this.env.BLOBS.head(
				narInfoObjectKey(storePathHash, cache)
			);

			if (existing !== null) {
				return;
			}

			const narInfo = await this.narInfoFromRow(row);

			// No shared fact means the blob was demoted; leave the path non-servable
			// until a re-upload re-promotes it rather than render an unbacked object.
			if (narInfo === undefined) {
				return;
			}

			await this.putNarInfoObject(cache, storePathHash, narInfo);
		});
	}

	private async putNarInfoObject(
		cache: string,
		storePathHash: string,
		narInfo: NarInfo
	): Promise<void> {
		await this.env.BLOBS.put(
			narInfoObjectKey(storePathHash, cache),
			narInfo.render(),
			{
				httpMetadata: {
					contentType: 'text/x-nix-narinfo; charset=utf-8',
					cacheControl: narInfoCacheControl
				}
			}
		);
	}

	private async stats(cache: string): Promise<StatsResponse> {
		const storePathRows = this.db
			.select({
				narHash: schema.narInfos.narHash,
				fileSize: schema.narInfos.fileSize
			})
			.from(schema.narInfos)
			.where(eq(schema.narInfos.cache, cache))
			.all();
		const pending = this.db
			.select({ count: count() })
			.from(schema.pendingUploads)
			.get();
		const narSizes = uniqueSizes(
			storePathRows.map((row) => ({ key: row.narHash, size: row.fileSize }))
		);
		const narFileSize = sum(narSizes);

		return {
			storePaths: storePathRows.length,
			narBlobs: narSizes.length,
			narFileSize,
			casObjects: 0,
			casFileSize: 0,
			pendingUploads: pending?.count ?? 0,
			totalFileSize: narFileSize
		};
	}

	private async usage(): Promise<UsageResponse> {
		const blobs = await this.d1
			.select({
				count: count(),
				total: sql<number>`coalesce(sum(${d1Schema.blobState.fileSize}), 0)`
			})
			.from(d1Schema.blobState)
			.get();
		const narFileSize = blobs?.total ?? 0;

		return {
			narBlobs: blobs?.count ?? 0,
			narFileSize,
			casObjects: 0,
			casFileSize: 0,
			totalFileSize: narFileSize
		};
	}

	private collectUnreachable(
		cache: string,
		now: string
	): {
		rootsExpired: number;
		pathsSwept: number;
	} {
		// Expire TTL'd roots first, regardless of whether a sweep follows, so an
		// expiring channel always lapses. A NULL expiry (permanent) never matches.
		const expiredRoots = this.db
			.select({ name: schema.retentionRoots.name })
			.from(schema.retentionRoots)
			.where(
				and(
					eq(schema.retentionRoots.cache, cache),
					lte(schema.retentionRoots.expiresAt, now)
				)
			)
			.all();

		this.db.transaction((tx) => {
			for (const root of expiredRoots) {
				tx.delete(schema.retentionRootTargets)
					.where(
						and(
							eq(schema.retentionRootTargets.cache, cache),
							eq(schema.retentionRootTargets.rootName, root.name)
						)
					)
					.run();
			}

			tx.delete(schema.retentionRoots)
				.where(
					and(
						eq(schema.retentionRoots.cache, cache),
						lte(schema.retentionRoots.expiresAt, now)
					)
				)
				.run();
		});

		// Mark the closure reachable from the live roots within this cache.
		// `visited` guards the traversal; `retainedCommitted` is the keep-set of
		// committed paths that the sweep spares.
		const visited = new Set<string>();
		const retainedCommitted = new Set<string>();
		const queue: string[] = [];

		for (const target of this.db
			.select({ storePathHash: schema.retentionRootTargets.storePathHash })
			.from(schema.retentionRootTargets)
			.where(eq(schema.retentionRootTargets.cache, cache))
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
				.where(
					and(
						eq(schema.narInfos.cache, cache),
						eq(schema.narInfos.storePathHash, storePathHash)
					)
				)
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

		// Guard: nothing committed is reachable in this cache and no root expired
		// (no roots, or roots that only point at absent paths), so collecting would
		// empty it without a retention event. Skip.
		if (retainedCommitted.size === 0 && expiredRoots.length === 0) {
			return { rootsExpired: expiredRoots.length, pathsSwept: 0 };
		}

		const committed = this.db
			.select({
				storePathHash: schema.narInfos.storePathHash,
				narHash: schema.narInfos.narHash,
				generation: schema.narInfos.generation
			})
			.from(schema.narInfos)
			.where(eq(schema.narInfos.cache, cache))
			.all();
		let pathsSwept = 0;

		for (const path of committed) {
			if (retainedCommitted.has(path.storePathHash)) {
				continue;
			}

			this.db.transaction((tx) => {
				tx.delete(schema.narInfos)
					.where(
						and(
							eq(schema.narInfos.cache, cache),
							eq(schema.narInfos.storePathHash, path.storePathHash)
						)
					)
					.run();
				this.enqueueNarInfoDeletion(
					tx,
					cache,
					path.storePathHash,
					path.narHash,
					path.generation,
					now
				);
			});
			pathsSwept += 1;
		}

		return { rootsExpired: expiredRoots.length, pathsSwept };
	}

	private async handleGarbageCollection(
		request: Request,
		cache?: string
	): Promise<Response> {
		await this.requireScope(request, 'admin');

		// Interactive GC purges this colo's edge cache via the caller's public
		// origin. The cron sweep arrives on the internal origin and cannot know
		// the public URL, so it skips purging and relies on the narinfo TTL and
		// the orphan-blob grace window instead.
		const requestOrigin = new URL(request.url).origin;
		const purgeOrigin =
			requestOrigin === internalOrigin ? undefined : requestOrigin;

		return Response.json({
			ok: true,
			...(await this.collectGarbage(cache, purgeOrigin))
		});
	}

	private collectGarbage(
		cache?: string,
		purgeOrigin?: string
	): Promise<GarbageCollectionOutcome> {
		const now = new Date().toISOString();

		return this.ctx.blockConcurrencyWhile(async () => {
			// A `pending` or `committing` upload is a live commit saga (awaiting
			// background verification, or a crashed inline commit the verify pass
			// re-drives), not abandoned, so it and its staged bytes must survive the
			// sweep until the verify pass resolves it. Only two states are reapable
			// once expired: a null-verdict row still awaiting its bytes, and a terminal
			// `mismatch` row whose observation window has passed (its staging bytes are
			// already gone).
			const reapable = and(
				lt(schema.pendingUploads.expiresAt, now),
				or(
					isNull(schema.pendingUploads.verdict),
					eq(schema.pendingUploads.verdict, 'mismatch')
				)
			);

			const expiredUploads = this.db
				.select()
				.from(schema.pendingUploads)
				.where(reapable)
				.all();

			// An abandoned upload's private staging object is reclaimed directly; a
			// reuse upload's r2Key is the shared canonical key, which the reaper owns,
			// so it is left alone.
			for (const upload of expiredUploads) {
				if (upload.r2Key !== narObjectKey(upload.narHash)) {
					await this.env.BLOBS.delete(upload.r2Key);
				}
			}

			this.db.delete(schema.pendingUploads).where(reapable).run();

			// Reachability GC is per-cache: each registered cache keeps its own
			// closure. A bare /gc sweeps every cache; /cache/:name/gc sweeps one.
			// Shared NAR blobs are retired only once globally unreferenced.
			const sweepCaches =
				cache === undefined
					? this.db
							.select({ name: schema.caches.name })
							.from(schema.caches)
							.all()
							.map((row) => row.name)
					: [cache];
			let rootsExpired = 0;
			let pathsSwept = 0;

			for (const name of sweepCaches) {
				const swept = this.collectUnreachable(name, now);
				rootsExpired += swept.rootsExpired;
				pathsSwept += swept.pathsSwept;
			}

			return {
				pendingUploadsDeleted: expiredUploads.length,
				rootsExpired,
				pathsSwept,
				narInfosDeleted: await this.flushQueuedNarInfoDeletions(purgeOrigin),
				blobsDeleted: await this.reapBlobs(new Date(now), blobReaperBatchSize)
			};
		});
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
	private async reserveNarInfoRow(
		cache: string,
		metadata: UploadPathMetadataFields
	): Promise<ReserveOutcome> {
		const now = new Date().toISOString();
		this.loadOrCreateCache(cache);
		const signingKeys = await this.signingKeys();
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
		return this.db.transaction((tx) => {
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
	private async materialiseServable(
		cache: string,
		metadata: UploadPathMetadataFields,
		generation: number,
		uploadId: string
	): Promise<MaterialiseOutcome> {
		const blob = await this.d1
			.select({ fileSize: d1Schema.blobState.fileSize })
			.from(d1Schema.blobState)
			.where(eq(d1Schema.blobState.narHash, metadata.narHash))
			.get();
		const canonicalPresent =
			(await this.env.BLOBS.head(narObjectKey(metadata.narHash))) !== null;

		if (blob === undefined || !canonicalPresent) {
			return 'blob-gone';
		}

		const row = this.db
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

		const narInfo = await this.narInfoFromRow(row);

		if (narInfo === undefined) {
			return 'blob-gone';
		}

		await this.d1
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
		await this.d1
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
		await this.d1
			.update(d1Schema.blobState)
			.set({ deleteAfter: sql`null` })
			.where(eq(d1Schema.blobState.narHash, metadata.narHash))
			.run();

		await this.putNarInfoObject(cache, metadata.storePathHash, narInfo);
		this.clearPendingUpload(uploadId);

		return 'materialised';
	}

	// Removes a reserved narinfo row whose commit failed verification, leaving its
	// burned generation in `generation_seq` (monotonic, never reused). Compare-and-
	// delete on the captured `(generation, narHash)`, and only while the row is not
	// yet materialised, so neither a newer recommit nor a concurrent commit that has
	// already made the path servable is ever removed. Runs in a critical section so
	// the object check and the delete cannot interleave with a materialisation.
	private async reclaimReservedRow(
		cache: string,
		storePathHash: string,
		generation: number,
		narHash: string
	): Promise<void> {
		const materialised = await this.d1
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

		await this.env.BLOBS.delete(narInfoObjectKey(storePathHash, cache));

		this.db
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

	private clearPendingUpload(uploadId: string): void {
		this.db
			.delete(schema.pendingUploads)
			.where(eq(schema.pendingUploads.id, uploadId))
			.run();
	}

	private markUploadPending(uploadId: string): void {
		this.db
			.update(schema.pendingUploads)
			.set({ verdict: 'pending' })
			.where(eq(schema.pendingUploads.id, uploadId))
			.run();
	}

	// Marks an inline commit in progress before it reserves the narinfo row, so a
	// crash mid-commit leaves a durable saga marker the verify pass re-drives rather
	// than a null-verdict upload indistinguishable from one still awaiting its bytes.
	private markUploadCommitting(uploadId: string): void {
		this.db
			.update(schema.pendingUploads)
			.set({ verdict: 'committing' })
			.where(eq(schema.pendingUploads.id, uploadId))
			.run();
	}

	// Records a durable `mismatch` verdict for a background verification failure and
	// deletes the bad staging bytes, keeping the upload row so a later status reader
	// (`push --wait` or a status endpoint) can observe why the path never became
	// servable. Synchronous inline failures reject immediately and need no verdict.
	private async markUploadFailed(
		uploadId: string,
		r2Key: string,
		narHash: string
	): Promise<void> {
		if (r2Key !== narObjectKey(narHash)) {
			await this.env.BLOBS.delete(r2Key);
		}

		// Refresh the observation window so the terminal verdict reliably outlives
		// the verify pass that recorded it (the pass may run at or past the original
		// upload TTL); GC reaps it once this window passes.
		this.db
			.update(schema.pendingUploads)
			.set({
				verdict: 'mismatch',
				expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
			})
			.where(eq(schema.pendingUploads.id, uploadId))
			.run();
	}

	private async verifyPendingNar(
		r2Key: string,
		metadata: UploadPathMetadataFields
	): Promise<NarVerification> {
		const object = await this.env.BLOBS.get(r2Key);

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

	// Background verify-and-commit of uploads deferred at commit because their blob
	// exceeded the inline budget. Each staging blob is decompressed and hash-verified
	// outside the critical section, then promoted and committed (on a match) or its
	// staging object deleted (on a failure) inside one, so a `pending` path becomes
	// servable only once its bytes are confirmed. Bounded per pass; the cron drives
	// it.
	private async verifyPendingUploads(limit: number): Promise<void> {
		// Re-drive both deferred (`pending`) uploads awaiting their first verify and
		// inline commits crashed mid-saga (`committing`); both finish through the same
		// idempotent reserve→verify→promote→materialise path.
		const pendings = this.db
			.select()
			.from(schema.pendingUploads)
			.where(
				or(
					eq(schema.pendingUploads.verdict, 'pending'),
					eq(schema.pendingUploads.verdict, 'committing')
				)
			)
			.orderBy(asc(schema.pendingUploads.id))
			.limit(limit)
			.all();

		for (const pending of pendings) {
			try {
				await this.verifyAndCommitPending(pending);
			} catch {
				// One upload's failure (a transient promote or commit error) must not
				// starve the rest of the pass; leave its marker for the next pass.
				continue;
			}
		}
	}

	private async verifyAndCommitPending(
		pending: typeof schema.pendingUploads.$inferSelect
	): Promise<void> {
		const metadata = parseStoredUploadMetadata(
			pending.id,
			pending.metadataJson
		);

		// Reserve the row before verifying: a fresh deferred upload gets its first
		// row, a crashed or re-driven commit finds its own (`mine`). A different
		// version holding the path (`lost`) means this upload can never own it — drop
		// it and reclaim its staging bytes.
		const reserved = await this.reserveNarInfoRow(pending.cache, metadata);

		if (reserved.kind === 'lost') {
			await this.clearPendingUploadAndStaging(
				pending.id,
				pending.r2Key,
				metadata.narHash
			);
			return;
		}

		const { generation } = reserved;

		// A returned `{ok:false}` (a hash/size mismatch or an undecodable frame) is a
		// definitive content failure that reclaims the reserved row. A thrown error
		// splits two ways: a definitively absent staging object cannot reappear, so it
		// fails terminally; any other thrown error is a transient read fault that
		// propagates to the per-iteration guard, leaving the row reserved and its
		// bytes staged for the next pass. `blob_state` already holding the hash never
		// short-circuits the verify: unverified bytes must not bind to the shared
		// object.
		let verification: NarVerification;

		try {
			verification = await this.verifyPendingNar(pending.r2Key, metadata);
		} catch (error) {
			if (error instanceof UploadedObjectNotFoundError) {
				await this.failReservedUpload(pending, metadata, generation);
				return;
			}

			throw error;
		}

		if (!verification.ok) {
			await this.failReservedUpload(pending, metadata, generation);
			return;
		}

		// Promote outside the critical section: streaming the staging bytes into the
		// shared CAS must not run under `blockConcurrencyWhile`. It is idempotent and
		// content-addressed, so a redundant promotion is harmless.
		await this.promoteStagingBlob(pending.r2Key, metadata);

		await this.ctx.blockConcurrencyWhile(async () => {
			const current = this.db
				.select()
				.from(schema.pendingUploads)
				.where(eq(schema.pendingUploads.id, pending.id))
				.get();

			if (current === undefined) {
				return;
			}

			const outcome = await this.materialiseServable(
				pending.cache,
				metadata,
				generation,
				pending.id
			);

			// A concurrent recommit took the path or the blob vanished, so this upload
			// lost: clear its marker. Any blob it promoted that no edge now references
			// is left for the reaper to collect.
			if (outcome !== 'materialised') {
				this.clearPendingUpload(pending.id);
			}

			await this.env.BLOBS.delete(pending.r2Key);
		});
	}

	// Records a terminal `mismatch` on a deferred upload whose bytes failed
	// verification and reclaims the reserved row it never made servable, so neither a
	// stranded row nor a stuck marker survives.
	private async failReservedUpload(
		pending: typeof schema.pendingUploads.$inferSelect,
		metadata: UploadPathMetadataFields,
		generation: number
	): Promise<void> {
		await this.ctx.blockConcurrencyWhile(() =>
			this.reclaimReservedRow(
				pending.cache,
				metadata.storePathHash,
				generation,
				metadata.narHash
			)
		);
		await this.markUploadFailed(pending.id, pending.r2Key, metadata.narHash);
	}

	private async removeStaleNarInfo(
		row: typeof schema.narInfos.$inferSelect,
		origin: string
	): Promise<void> {
		await this.ctx.blockConcurrencyWhile(() =>
			this.reconcileMissingNar(row, origin)
		);
	}

	// Removes a narinfo whose NAR is gone, row-first, as for deleteStorePath: the
	// transaction removes the row and queues the narinfo object cleanup, so an
	// interrupted recovery cannot resurrect the path through a heal. The object
	// delete that follows is opportunistic and GC finishes anything left in the
	// queue. The caller owns the critical section so verification can reconcile a
	// whole batch in one without nesting `blockConcurrencyWhile`.
	private async reconcileMissingNar(
		row: typeof schema.narInfos.$inferSelect,
		origin?: string
	): Promise<void> {
		const now = new Date().toISOString();

		this.db.transaction((tx) => {
			tx.delete(schema.narInfos)
				.where(
					and(
						eq(schema.narInfos.cache, row.cache),
						eq(schema.narInfos.storePathHash, row.storePathHash)
					)
				)
				.run();
			this.enqueueNarInfoDeletion(
				tx,
				row.cache,
				row.storePathHash,
				row.narHash,
				row.generation,
				now
			);
		});

		try {
			await this.deleteQueuedNarInfo(
				row.cache,
				row.storePathHash,
				row.generation,
				origin
			);
		} catch {
			// the durable queue row remains for GC to retry
		}
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
		cache: string,
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
				.where(
					and(
						eq(schema.narInfos.cache, cache),
						eq(schema.narInfos.storePathHash, storePathHash)
					)
				)
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
					.where(
						and(
							eq(schema.narInfos.cache, row.cache),
							eq(schema.narInfos.storePathHash, storePathHash)
						)
					)
					.run();
				this.enqueueNarInfoDeletion(
					tx,
					row.cache,
					storePathHash,
					row.narHash,
					row.generation,
					now
				);
			});

			let narScheduledForDeletion = false;

			try {
				({ narScheduledForDeletion } = await this.deleteQueuedNarInfo(
					row.cache,
					storePathHash,
					row.generation,
					origin
				));
			} catch {
				// the durable queue row remains for GC to retry
			}

			return { storePathHash, deleted: true, narScheduledForDeletion };
		});
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

	private authIssuer(): string {
		return this.env.CUPBOARD_AUTH_ISSUER || defaultAuthIssuer;
	}

	private authAudience(): string {
		return this.env.CUPBOARD_AUTH_AUDIENCE || defaultAuthAudience;
	}

	private authKeys(): Promise<readonly AuthKey[]> {
		// A shared in-flight promise so concurrent first requests against an
		// empty DO generate and insert the bootstrap key exactly once. A failed
		// attempt clears the cache so a later request can create it.
		this.authKeysPromise ??= this.loadOrCreateAuthKeys().catch(
			(error: unknown) => {
				this.authKeysPromise = undefined;
				throw error;
			}
		);

		return this.authKeysPromise;
	}

	private async loadOrCreateAuthKeys(): Promise<readonly AuthKey[]> {
		// Insertion order (rowid) decides which key is active, so a rotation always
		// supersedes the previous key regardless of timestamp resolution.
		const rows = this.db
			.select()
			.from(schema.authKeys)
			.orderBy(sql`rowid`)
			.all();

		if (rows.length > 0) {
			return rows.map((row) => this.authKeyFromRow(row));
		}

		const generated = await generateAuthKeyPair();
		const kid = crypto.randomUUID();
		const createdAt = new Date().toISOString();

		this.db
			.insert(schema.authKeys)
			.values({
				id: 'active',
				kid,
				privateJwkJson: JSON.stringify(generated.privateJwk),
				publicJwkJson: JSON.stringify(generated.publicJwk),
				createdAt
			})
			.run();

		return [{ kid, ...generated, createdAt, retired: false }];
	}

	private authKeyFromRow(row: typeof schema.authKeys.$inferSelect): AuthKey {
		// A pre-rotation row predates `kid`; give it one on first load so every
		// key the verifier and JWKS see is addressable.
		const kid = row.kid === '' ? this.backfillAuthKeyKid(row.id) : row.kid;

		return {
			kid,
			privateJwk: JSON.parse(row.privateJwkJson) as JsonWebKey,
			publicJwk: JSON.parse(row.publicJwkJson) as JsonWebKey,
			createdAt: row.createdAt,
			retired: Boolean(row.retiredAt)
		};
	}

	private backfillAuthKeyKid(id: string): string {
		const kid = crypto.randomUUID();

		this.db
			.update(schema.authKeys)
			.set({ kid })
			.where(eq(schema.authKeys.id, id))
			.run();

		return kid;
	}

	private resetAuthKeyCache(): void {
		this.authKeysPromise = undefined;
	}

	// The minting key: the last key inserted that is still in service, so a fresh
	// rotation takes over minting at once.
	private async activeAuthKey(): Promise<AuthKey> {
		const keys = await this.authKeys();
		const active = keys.findLast((key) => !key.retired);

		if (active === undefined) {
			throw new Error('no active auth key in the key set');
		}

		return active;
	}

	private async authVerificationKeys(): Promise<readonly AuthPublicKey[]> {
		const keys = await this.authKeys();

		return keys
			.filter((key) => !key.retired)
			.map((key) => ({ kid: key.kid, publicJwk: key.publicJwk }));
	}

	private async authKeySummaries(): Promise<AuthKeySummary[]> {
		const active = await this.activeAuthKey();
		const keys = await this.authKeys();

		// Listed in insertion order, the same order that decides the active key.
		return keys
			.filter((key) => !key.retired)
			.map((key) => ({
				kid: key.kid,
				createdAt: key.createdAt,
				active: key.kid === active.kid
			}));
	}

	private rotateAuthKey(): Promise<AuthKeyRotateResponse> {
		// One critical section: the insert and cache reset must not interleave
		// with a concurrent rotation or a verification reading the key set.
		return this.ctx.blockConcurrencyWhile(async () => {
			const generated = await generateAuthKeyPair();
			const kid = crypto.randomUUID();

			this.db
				.insert(schema.authKeys)
				.values({
					id: crypto.randomUUID(),
					kid,
					privateJwkJson: JSON.stringify(generated.privateJwk),
					publicJwkJson: JSON.stringify(generated.publicJwk),
					createdAt: new Date().toISOString()
				})
				.run();
			this.resetAuthKeyCache();

			return { rotated: kid, keys: await this.authKeySummaries() };
		});
	}

	private async retireAuthKey(kid: string): Promise<AuthKeyRetireResponse> {
		// The last-key check and the retirement share one critical section so two
		// concurrent retirements cannot both see themselves as safe. A refused
		// retirement is returned as an outcome and thrown afterwards: throwing
		// inside blockConcurrencyWhile would break the input gate.
		const outcome = await this.ctx.blockConcurrencyWhile(
			async (): Promise<{ retired: boolean } | { refused: true }> => {
				const keys = await this.authKeys();
				const live = keys.filter((key) => !key.retired);
				const target = live.find((key) => key.kid === kid);

				if (target === undefined) {
					return { retired: false };
				}

				if (live.length <= 1) {
					return { refused: true };
				}

				this.db
					.update(schema.authKeys)
					.set({ retiredAt: new Date().toISOString() })
					.where(eq(schema.authKeys.kid, kid))
					.run();
				this.resetAuthKeyCache();

				return { retired: true };
			}
		);

		if ('refused' in outcome) {
			throw new LastAuthKeyError(kid);
		}

		return { kid, retired: outcome.retired };
	}

	private decodeInbound(token: string): OidcClaims {
		try {
			return decodeInboundClaims(token);
		} catch {
			throw new InvalidGrantError('Subject token is not a JWT');
		}
	}

	private async verifyInbound(
		rule: OidcTrustRule,
		token: string
	): Promise<JWTPayload> {
		// Discovery resolves the issuer's JWKS and its accepted algorithms. Failing
		// to reach the issuer is an upstream condition, not a bad token, so it is a
		// retryable 503 rather than a permanent `invalid_grant`.
		const issuer = await this.discovery
			.resolve(rule.issuer)
			.catch((error: unknown) => {
				throw new IssuerUnavailableError(rule.issuer, { cause: error });
			});

		try {
			// The signature is checked against the discovered keys, with issuer and
			// audience pinned.
			return await verifyInboundOidcToken(
				issuer.resolver,
				token,
				{
					issuer: rule.issuer,
					audience: rule.audience,
					algorithms: issuer.algorithms
				},
				new Date()
			);
		} catch (error) {
			// A JWKS fetch that fails (rather than the token failing verification)
			// is the same transient upstream condition as a discovery failure.
			if (error instanceof OidcKeysUnreachableError) {
				throw new IssuerUnavailableError(rule.issuer, { cause: error });
			}

			throw new InvalidGrantError('Subject token failed verification');
		}
	}

	private async mintRuleToken(
		rule: OidcTrustRule,
		subject: string,
		ttlSeconds: number
	): Promise<string> {
		const key = await this.activeAuthKey();

		// A write token is pinned to the rule's roots via `cb_roots`; an admin
		// token is unconstrained. The rule id rides along as an audit breadcrumb.
		return mintAccessJwt(
			key.privateJwk,
			{
				issuer: this.authIssuer(),
				audience: this.authAudience(),
				subject,
				scope: rule.scope,
				kid: key.kid,
				ttlSeconds,
				cbRoots: rule.scope === 'write' ? rule.allowedRoots : undefined,
				auditClaims: { cb_rule: rule.id }
			},
			new Date()
		);
	}

	private async authPublicJwks(): Promise<JsonWebKeyWithKid[]> {
		const keys = await this.authVerificationKeys();

		return keys.map((key) => ({
			...key.publicJwk,
			kid: key.kid,
			alg: authJwtAlgorithm,
			use: 'sig'
		}));
	}

	private enabledOidcTrustRules(): OidcTrustRule[] {
		return this.db
			.select()
			.from(schema.oidcTrust)
			.where(isNull(schema.oidcTrust.disabledAt))
			.orderBy(asc(schema.oidcTrust.createdAt), asc(schema.oidcTrust.id))
			.all()
			.map((row) => oidcTrustRuleFromRow(row));
	}

	private ownerConfig(): OwnerConfig | undefined {
		const issuer = this.env.CUPBOARD_OWNER_ISSUER;
		const subject = this.env.CUPBOARD_OWNER_SUBJECT;
		const audience = this.env.CUPBOARD_OWNER_AUDIENCE;

		// A binding may be absent or empty when no owner is configured (e.g. in
		// local development); either way there is no rule to seed.
		if (!issuer || !subject || !audience) {
			return undefined;
		}

		// A configured-but-malformed issuer is a deploy error: surface it now
		// rather than seeding a rule that can never match (a silent admin lockout).
		const issuerUrl = IssuerUrl.parse(issuer);

		if (issuerUrl === undefined) {
			throw new OwnerConfigurationInvalidError(issuer);
		}

		return { issuer: issuerUrl.value, subject, audience };
	}

	private seedOwnerRule(): void {
		const owner = this.ownerConfig();

		if (owner === undefined) {
			// A deployment that clears its owner config revokes the owner's admin
			// rule, so no standing owner identity outlives the config that named it.
			this.db
				.delete(schema.oidcTrust)
				.where(eq(schema.oidcTrust.id, ownerRuleId))
				.run();
			return;
		}

		// Redeploying with new owner config updates the rule in place, so the owner
		// identity always tracks deploy config. Clearing `disabledAt` on conflict
		// re-enables it, so the owner is restored even if the rule was ever
		// disabled out of band. `ownerConfig` has already normalised the issuer.
		const fields = {
			issuer: owner.issuer,
			audience: owner.audience,
			claimsJson: JSON.stringify({ sub: owner.subject })
		};

		this.db
			.insert(schema.oidcTrust)
			.values({
				id: ownerRuleId,
				scope: 'admin',
				allowedRootsJson: '[]',
				createdAt: new Date().toISOString(),
				...fields
			})
			.onConflictDoUpdate({
				target: schema.oidcTrust.id,
				set: { ...fields, disabledAt: sql`null` }
			})
			.run();
	}

	private async requireScope(
		request: Request,
		required: AccessScope
	): Promise<AccessClaims> {
		const token = bearerToken(request);

		if (token === undefined) {
			throw new UnauthenticatedError();
		}

		const keys = await this.authVerificationKeys();
		let claims: AccessClaims;

		try {
			claims = await verifyAccessJwt(
				keys,
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
		await migrate(this.db, migrations);
		await this.assertZstdAvailable();

		// The default cache always exists in the registry so its priority is
		// resolved the same way as a named cache's. Idempotent across restarts.
		this.db
			.insert(schema.caches)
			.values({
				name: DEFAULT_CACHE,
				priority: CacheInfo.default.priority,
				createdAt: new Date().toISOString()
			})
			.onConflictDoNothing()
			.run();

		this.seedOwnerRule();
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

function oidcTrustRuleFromRow(
	row: typeof schema.oidcTrust.$inferSelect
): OidcTrustRule {
	const fault = (cause: Error): StoredOidcTrustInvalidError =>
		new StoredOidcTrustInvalidError(row.id, cause);

	return {
		id: row.id,
		issuer: row.issuer,
		audience: row.audience,
		scope: row.scope,
		claims: parseStored(storedClaimsSchema, row.claimsJson, fault),
		allowedRoots: parseStored(
			storedAllowedRootsSchema,
			row.allowedRootsJson,
			fault
		)
	};
}

// The admin-facing view of a rule. It omits `jwks_url`, so the listing says who
// is trusted without restating where their keys are fetched from.
function oidcTrustSummaryFromRow(
	row: typeof schema.oidcTrust.$inferSelect
): OidcTrustSummary {
	const rule = oidcTrustRuleFromRow(row);

	return {
		id: rule.id,
		issuer: rule.issuer,
		audience: rule.audience,
		scope: rule.scope,
		claims: { ...rule.claims },
		allowedRoots: [...rule.allowedRoots],
		disabled: Boolean(row.disabledAt)
	};
}

function policySummaryFromRow(
	row: typeof schema.retentionPolicies.$inferSelect
): RetentionPolicySummary {
	return {
		id: row.id,
		scope: row.scope,
		pattern: row.pattern,
		ttlSeconds: row.defaultTtlSeconds
	};
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

// The outcome of reserving a narinfo row: `reserved` when this commit inserted
// the row (it owns the path and reports `committed`), `mine` when an identical
// commit already holds it (a concurrent winner or this same upload re-driven),
// `lost` when a different narinfo version holds it.
type ReserveOutcome =
	| { kind: 'reserved'; generation: number }
	| { kind: 'mine'; generation: number }
	| { kind: 'lost'; narHash: string };

// The outcome of materialising a reserved narinfo: `materialised` on success;
// `superseded` when a concurrent recommit replaced the reserved version;
// `blob-gone` when the shared blob (`blob_state` or the canonical object) is no
// longer present and the path must be re-uploaded.
type MaterialiseOutcome = 'materialised' | 'superseded' | 'blob-gone';

// The compressed metadata of the one canonical object served for a NAR hash.
// Read from the object itself so a committed narinfo always advertises the
// encoding actually stored, regardless of which upload promoted it.
interface CanonicalBlob {
	readonly fileHash: string;
	readonly fileSize: number;
}

function canonicalBlobOf(key: string, object: R2Object): CanonicalBlob {
	const sha256 = object.checksums.sha256;

	if (sha256 === undefined) {
		throw new UploadedObjectChecksumMissingError(key);
	}

	return {
		fileHash: NixSha256Hash.fromDigest(new Uint8Array(sha256)).toString(),
		fileSize: object.size
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

function uniqueSizes(
	rows: readonly { readonly key: string; readonly size: number }[]
): number[] {
	return [...new Map(rows.map((row) => [row.key, row.size])).values()];
}

function sum(values: readonly number[]): number {
	return values.reduce((total, value) => total + value, 0);
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
