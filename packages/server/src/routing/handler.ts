import {
	cacheFromSelector,
	cacheSelectorSchema,
	DEFAULT_CACHE,
	type TenantId
} from '@cupboard/nix-store/scalars';
import {
	cacheAvailabilityRequestSchema,
	type CacheAvailabilityResponse
} from '@cupboard/protocol/cache-availability';
import { type TenantStatus } from '@cupboard/protocol/tenants';
import { eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { type Context, Hono } from 'hono';
import { StatusCodes } from 'http-status-codes';

import { buildVersion } from '../build-info.generated.ts';
import { controlApp } from '../control/control-app.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { readWithOneRetry } from '../db/transient.ts';
import { negotiateHintsHeader } from '../do/negotiate-hints.ts';
import {
	TenantAdmissionUnavailableError,
	TenantWritesStoppedError
} from '../errors.ts';
import { serverErrorHandler } from '../http/error-response.ts';
import {
	notFoundResponse,
	parseAttestationDigestName,
	parseNarInfoName,
	parseNarName,
	TextBody,
	textResponse
} from '../http/http.ts';
import { parseRequestBody } from '../http/parse.ts';
import { loggerMiddleware } from '../observability/logging.ts';
import {
	cacheInfoResponse,
	cacheScope,
	guardRead,
	missingStorePathHashes,
	serveNar,
	serveNarInfo
} from '../read/read.ts';

import { admitTenant, type TenantEntry } from './admission.ts';
import { canonicalCacheRequest } from './cache-request.ts';
import { tenantServer } from './durable-object.ts';
import { type WorkerHonoEnv } from './hono-env.ts';
import { computeNegotiateHints } from './negotiate-hints.ts';
import { enqueueMaintenanceJobs, handleMaintenanceQueue } from './scheduled.ts';
import { tenantReadFetch } from './tenant-read-handler.ts';
import { parseTenantPath } from './tenant-routing.ts';

const healthBody = new TextBody('ok\n');
const versionBody = new TextBody(`${buildVersion}\n`);
const uploadPreviewPathPattern = /^\/cache\/[^/]+\/uploads\/preview$/u;
const cacheAvailabilityPathPattern =
	/^(?:(?:\/cache\/[^/]+)|(?:\/reuse\/[^/]+))?\/api\/v1\/missing-paths$/u;

function buildApp(): Hono<WorkerHonoEnv> {
	const app = new Hono<WorkerHonoEnv>();

	app.onError(serverErrorHandler);
	app.notFound(() => notFoundResponse());

	// Initialise logging before admission so early refusals include request fields.
	// Add the tenant field only after the slug is admitted.
	app.use(loggerMiddleware);

	// Keep `/_health` as an alias for the conventional `/healthz` endpoint.
	// Liveness is public and performs no dependency checks; the authenticated
	// control check reports database readiness.
	app.on('GET', ['/_health', '/healthz'], (context) =>
		textResponse(context.req.raw, healthBody, {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'no-store'
		})
	);
	app.get('/_version', (context) =>
		textResponse(context.req.raw, versionBody, {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'no-store'
		})
	);

	// Reject unknown and encoded slugs before resolving a Durable Object so an
	// arbitrary URL cannot create unprovisioned tenant storage.
	//
	// Writes stop immediately after the authoritative D1 status changes. Reads stop
	// after the updated manifest reaches KV and the cached entry expires.
	app.use('/t/:tenant/*', async (context, next) => {
		const requestUrl = new URL(context.req.url);
		const route = parseTenantPath(requestUrl.pathname);

		if (route === undefined) {
			return notFoundResponse();
		}

		const admission = await admitTenant(
			context.env,
			context.executionCtx,
			route.tenant
		);

		if (admission === undefined) {
			return notFoundResponse();
		}

		const { entry, fresh } = admission;

		const isRead =
			context.req.method === 'GET' ||
			context.req.method === 'HEAD' ||
			isUploadPreviewRequest(context.req.method, route.rest) ||
			isCacheAvailabilityRequest(context.req.method, route.rest);

		if (isRead && entry.status !== 'active') {
			return notFoundResponse();
		}

		context.set('tenant', route.tenant);
		context.set('tenantEntry', entry);
		context.set('tenantEntryFresh', fresh);
		context.set('tenantRest', route.rest);
		context.set('logger', context.get('logger').with({ tenant: route.tenant }));

		// A valid `/cache/<name>/` prefix selects a named cache. Bare read paths use
		// the default cache; malformed selectors return 404.
		if (isRead) {
			const scope = cacheScope(route.rest);

			if (scope === undefined) {
				return notFoundResponse();
			}

			context.set('cache', scope.cache);
		}

		await next();
	});

	// Discovery includes absolute URLs derived from the public request origin,
	// and key rotation changes the JWKS. Fetch both from the tenant Durable Object
	// without caching them.
	app.get('/t/:tenant/.well-known/oauth-authorization-server', (context) =>
		tenantUncachedRead(context, true)
	);
	app.get('/t/:tenant/.well-known/jwks.json', (context) =>
		tenantServer(context.env, context.get('tenant')).fetch(
			innerRequest(context)
		)
	);

	// Path and cache deletion can change attestation lists and bundle references,
	// so neither response is cached. Malformed names fall through to the tenant
	// Durable Object's normal routing.
	app.on(
		'GET',
		[
			'/t/:tenant/attestations/:hash',
			'/t/:tenant/cache/:cacheName/attestations/:hash'
		],
		async (context, next) => {
			if (
				parseNarInfoName(`${context.req.param('hash')}.narinfo`) === undefined
			) {
				return next();
			}

			const denied = await guardRead(
				context.req.raw,
				context.get('tenantEntry')
			);

			return denied ?? tenantUncachedRead(context);
		}
	);
	app.on(
		'GET',
		[
			'/t/:tenant/attestation-bundles/:digest',
			'/t/:tenant/cache/:cacheName/attestation-bundles/:digest'
		],
		async (context, next) => {
			if (
				parseAttestationDigestName(context.req.param('digest')) === undefined
			) {
				return next();
			}

			const denied = await guardRead(
				context.req.raw,
				context.get('tenantEntry')
			);

			if (denied !== undefined) {
				return denied;
			}

			return tenantUncachedRead(context, true);
		}
	);

	app.on(
		'POST',
		[
			'/t/:tenant/api/v1/missing-paths',
			'/t/:tenant/cache/:cacheName/api/v1/missing-paths'
		],
		async (context) => {
			const denied = await guardRead(
				context.req.raw,
				context.get('tenantEntry')
			);

			if (denied !== undefined) {
				return denied;
			}

			const request = await parseRequestBody(
				cacheAvailabilityRequestSchema,
				context.req.raw
			);
			const response: CacheAvailabilityResponse = {
				missingStorePathHashes: await missingStorePathHashes(
					context.env,
					context.get('tenant'),
					context.get('cache'),
					request.storePathHashes
				)
			};

			return context.json(response, StatusCodes.OK, {
				'cache-control': 'no-store'
			});
		}
	);

	app.post('/t/:tenant/reuse/:view/api/v1/missing-paths', async (context) => {
		const denied = await guardRead(context.req.raw, context.get('tenantEntry'));

		return (
			denied ??
			tenantServer(context.env, context.get('tenant')).fetch(
				innerRequest(context)
			)
		);
	});

	app.on(
		'GET',
		['/t/:tenant/nar/:name', '/t/:tenant/cache/:cacheName/nar/:name'],
		async (context) => {
			const narHash = parseNarName(context.req.param('name'));

			if (narHash === undefined) {
				return notFoundResponse();
			}

			const entry = context.get('tenantEntry');
			const denied = await guardRead(context.req.raw, entry);

			if (denied !== undefined) {
				return denied;
			}

			return entry.readMode === 'private'
				? serveNar(
						context.req.raw,
						context.env,
						context.get('tenant'),
						narHash,
						true
					)
				: cachedTenantRead(context);
		}
	);

	app.on(
		'GET',
		[
			String.raw`/t/:tenant/:name{[0-9a-z]+\.narinfo}`,
			String.raw`/t/:tenant/cache/:cacheName/:name{[0-9a-z]+\.narinfo}`
		],
		async (context) => {
			const storePathHash = parseNarInfoName(context.req.param('name') ?? '');

			if (storePathHash === undefined) {
				return notFoundResponse();
			}

			const entry = context.get('tenantEntry');
			const denied = await guardRead(context.req.raw, entry);

			if (denied !== undefined) {
				return denied;
			}

			return entry.readMode === 'private'
				? serveNarInfo(
						context.req.raw,
						context.env,
						context.get('tenant'),
						context.get('cache'),
						storePathHash,
						true
					)
				: cachedTenantRead(context);
		}
	);

	app.on(
		'GET',
		['/t/:tenant/nix-cache-info', '/t/:tenant/cache/:cacheName/nix-cache-info'],
		async (context) => {
			const entry = context.get('tenantEntry');
			const denied = await guardRead(context.req.raw, entry);

			if (denied !== undefined) {
				return denied;
			}

			return entry.readMode === 'private' ||
				context.get('cache') !== DEFAULT_CACHE
				? cacheInfoResponse(
						innerRequest(context),
						context.env,
						context.get('tenant'),
						context.get('cache'),
						true
					)
				: cachedTenantRead(context);
		}
	);

	// Reuse-view metadata has its own priority and is never cached. Bypass the
	// default-cache renderer.
	app.get('/t/:tenant/reuse/:view/nix-cache-info', async (context) => {
		const denied = await guardRead(context.req.raw, context.get('tenantEntry'));

		return (
			denied ??
			tenantServer(context.env, context.get('tenant')).fetch(
				innerRequest(context)
			)
		);
	});

	// Reuse-view membership can change without a purge key. Send both hits and
	// misses directly to the Durable Object with `no-store`.
	app.get(
		String.raw`/t/:tenant/reuse/:view/:name{[0-9a-z]+\.narinfo}`,
		async (context) => {
			const denied = await guardRead(
				context.req.raw,
				context.get('tenantEntry')
			);

			return (
				denied ??
				tenantServer(context.env, context.get('tenant')).fetch(
					innerRequest(context)
				)
			);
		}
	);

	// Reuse views expose no NAR route. Authenticate private tenants before the 404
	// and prevent caches from retaining a miss for a route added later.
	app.get('/t/:tenant/reuse/*', async (context) => {
		const denied = await guardRead(context.req.raw, context.get('tenantEntry'));

		if (denied !== undefined) {
			return denied;
		}

		const response = notFoundResponse();
		response.headers.set('cache-control', 'no-store');

		return response;
	});

	// Serve signing keys uncached so rotation is visible immediately.
	app.on(
		'GET',
		['/t/:tenant/pubkey', '/t/:tenant/cache/:cacheName/pubkey'],
		(context) => {
			const pubkeyUrl = new URL(context.req.url);
			pubkeyUrl.pathname = '/pubkey';

			return tenantServer(context.env, context.get('tenant')).fetch(
				new Request(pubkeyUrl, context.req.raw)
			);
		}
	);

	// Compute shared D1 hints on the Worker before entering the tenant Durable
	// Object. If hint preparation or the deployment-skew RPC fails, dispatch
	// without them and let the Durable Object read authoritative facts.
	app.on('POST', '/t/:tenant/cache/:cacheName/uploads', async (context) => {
		const tenant = context.get('tenant');
		const writeStatus = admittedWriteStatus(context);
		const selector = cacheSelectorSchema.safeParse(
			context.req.param('cacheName')
		);

		// Skip advisory hint reads when fresh admission already found an inactive
		// tenant. The write gate still produces the authoritative refusal.
		if (writeStatus !== undefined && writeStatus !== 'active') {
			return dispatchTenant(
				innerRequest(context),
				context.env,
				tenant,
				writeStatus
			);
		}

		// Compute hints before constructing the forwarded request because reading
		// them clones the original body.
		const hints = await computeNegotiateHints(
			context.req.raw,
			context.env,
			tenant,
			selector.success ? cacheFromSelector(selector.data) : undefined
		);
		const inner = innerRequest(context);

		if (hints !== undefined) {
			try {
				const token = await tenantServer(
					context.env,
					tenant
				).stageNegotiateHints(hints);
				inner.headers.set(negotiateHintsHeader, token);
			} catch {
				// Hints are advisory; fall back to authoritative reads in the tenant.
			}
		}

		return dispatchTenant(inner, context.env, tenant, writeStatus);
	});

	// Keep the fallback last so specialised read routes can apply their cache
	// policy before Durable Object dispatch.
	app.all('/t/:tenant/*', (context) =>
		dispatchTenant(
			innerRequest(context),
			context.env,
			context.get('tenant'),
			admittedWriteStatus(context)
		)
	);

	app.route('/', controlApp);

	return app;
}

const app = buildApp();

export default {
	fetch: app.fetch,

	async scheduled(_controller, env) {
		// Enqueue bounded jobs so execution failures retry per message rather than
		// repeating the whole cron plan.
		await enqueueMaintenanceJobs(env);
	},

	async queue(batch, env) {
		await handleMaintenanceQueue(batch, env);
	}
} satisfies ExportedHandler<Env>;

// Strip the public tenant prefix and any client-supplied hint token. Upload
// negotiation adds a server-issued token only after this sanitisation.
function innerRequest(context: Context<WorkerHonoEnv>): Request {
	const inner = new URL(context.req.url);
	inner.pathname = context.get('tenantRest');
	const request = new Request(inner, context.req.raw);
	request.headers.delete(negotiateHintsHeader);

	return request;
}

async function cachedTenantRead(
	context: Context<WorkerHonoEnv>
): Promise<Response> {
	const { CUPBOARD_TENANT: service } = context.env as Partial<
		Pick<Env, 'CUPBOARD_TENANT'>
	>;

	if (service !== undefined) {
		return service.fetch(canonicalCacheRequest(context.req.raw));
	}

	return tenantReadFetch(
		context.req.raw,
		context.env as unknown as TenantEnv,
		context.executionCtx
	);
}

async function tenantUncachedRead(
	context: Context<WorkerHonoEnv>,
	shouldForceNoStore = false
): Promise<Response> {
	const response = await tenantServer(context.env, context.get('tenant')).fetch(
		innerRequest(context)
	);

	if (!shouldForceNoStore) {
		return response;
	}

	const headers = new Headers(response.headers);
	headers.set('cache-control', 'no-store');

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}

// Confirm mutable requests against authoritative D1 status before Durable
// Object dispatch. The tenant Durable Object then applies its own authorisation.
async function dispatchTenant(
	inner: Request,
	env: Env,
	tenant: TenantId,
	// Reuse status only when admission read D1 for this request. Cached admission
	// must recheck D1 before a write.
	admittedStatus?: TenantEntry['status']
): Promise<Response> {
	if (!isTenantWrite(inner)) {
		return tenantServer(env, tenant).fetch(inner);
	}

	const status = admittedStatus ?? (await tenantStatus(env, tenant));

	if (status !== 'active') {
		throw new TenantWritesStoppedError(tenant, status);
	}

	return tenantServer(env, tenant).fetch(inner);
}

function admittedWriteStatus(
	context: Context<WorkerHonoEnv>
): TenantEntry['status'] | undefined {
	return context.get('tenantEntryFresh')
		? context.get('tenantEntry').status
		: undefined;
}

// Token exchange and the two read-only POST endpoints bypass the write gate. A
// WebSocket upgrade uses GET on the wire, but the only socket route commits
// uploads and must be gated as a write.
function isTenantWrite(inner: Request): boolean {
	if (inner.headers.get('upgrade')?.toLowerCase() === 'websocket') {
		return true;
	}

	if (inner.method === 'GET' || inner.method === 'HEAD') {
		return false;
	}

	const innerUrl = new URL(inner.url);

	if (innerUrl.pathname === '/token') {
		return false;
	}

	return !(
		isUploadPreviewRequest(inner.method, innerUrl.pathname) ||
		isCacheAvailabilityRequest(inner.method, innerUrl.pathname)
	);
}

function isUploadPreviewRequest(method: string, pathname: string): boolean {
	return method === 'POST' && uploadPreviewPathPattern.test(pathname);
}

function isCacheAvailabilityRequest(method: string, pathname: string): boolean {
	return method === 'POST' && cacheAvailabilityPathPattern.test(pathname);
}

// Read D1 so write suspension does not wait for KV expiry. A missing row is
// inactive, and a persistent D1 failure remains retryable.
async function tenantStatus(
	env: Env,
	tenant: TenantId
): Promise<TenantStatus | undefined> {
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });

	try {
		const row = await readWithOneRetry(() =>
			database
				.select({ status: d1Schema.tenant.status })
				.from(d1Schema.tenant)
				.where(eq(d1Schema.tenant.id, tenant))
				.get()
		);

		return row?.status;
	} catch (error) {
		throw new TenantAdmissionUnavailableError(error);
	}
}
