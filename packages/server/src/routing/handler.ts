import {
	cacheFromSelector,
	cacheNameSchema,
	cacheSelectorSchema,
	DEFAULT_CACHE,
	privateStoredCache,
	publicCacheSelectorSchema,
	type TenantId,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { type TenantStatus } from '@cupboard/protocol/tenants';
import { eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { type Context, Hono } from 'hono';

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
	parseNarName,
	TextBody,
	textResponse,
	uncachedNotFoundResponse
} from '../http/http.ts';
import { loggerMiddleware } from '../observability/logging.ts';
import {
	guardPrivateViewRead,
	guardScopedRead,
	privateNamespaceNarAuthority,
	serveNar
} from '../read/read.ts';
import { unauthorisedResponse } from '../read/read-auth.ts';

import { admitTenant, type TenantEntry } from './admission.ts';
import { tenantServer } from './durable-object.ts';
import { type WorkerHonoEnv } from './hono-env.ts';
import { computeNegotiateHints } from './negotiate-hints.ts';
import { readApp } from './read-app.ts';
import { enqueueMaintenanceJobs, handleMaintenanceQueue } from './scheduled.ts';
import {
	innerRequest,
	tenantUncachedRead,
	withoutStoring
} from './tenant-forward.ts';
import {
	isLiteralNamespacePath,
	parsePrivateCachePath,
	parseTenantPath
} from './tenant-routing.ts';

const healthBody = new TextBody('ok\n');
const versionBody = new TextBody(`${buildVersion}\n`);
const uploadPreviewPathPattern = /^\/cache\/[^/]+\/uploads\/preview$/u;
const cacheAvailabilityPathPattern =
	/^(?:(?:\/cache\/[^/]+)|(?:\/private-cache\/[^/]+)|(?:\/reuse\/[^/]+)|(?:\/private-reuse\/[^/]+))?\/api\/v1\/missing-paths$/u;

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

	// RFC 8414 inserts the well-known component before a path-based issuer.
	// Keep the older appended spelling below for existing clients, but publish
	// and serve the standard tenant metadata URL here.
	app.get(
		'/.well-known/oauth-authorization-server/t/:tenant',
		async (context) => {
			const slug = context.req.param('tenant');
			const tenant = tenantIdSchema.safeParse(slug);
			// This document publishes the tenant issuer as a string. Serve it only
			// when the raw path segment is the canonical spelling of the slug.
			const rawSlug = new URL(context.req.url).pathname.split('/').at(-1);

			if (rawSlug !== slug || !tenant.success) {
				return notFoundResponse();
			}

			const admission = await admitTenant(
				context.env,
				context.executionCtx,
				tenant.data
			);

			if (admission?.entry.status !== 'active') {
				return notFoundResponse();
			}

			const inner = new URL(context.req.url);
			inner.pathname = '/.well-known/oauth-authorization-server';
			const response = await tenantServer(context.env, tenant.data).fetch(
				new Request(inner, context.req.raw)
			);
			const headers = new Headers(response.headers);
			headers.set('cache-control', 'no-store');

			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers
			});
		}
	);

	// The membership filter and KV marker reject unknown tenant slugs before a
	// request can create a Durable Object. Every remaining request reads the
	// authoritative D1 row, so a status change applies to reads and writes without
	// waiting for the negative caches to refresh. `parseTenantPath` reads the raw
	// pathname and rejects an encoded slug.
	app.use('/t/:tenant/*', async (context, next) => {
		const requestUrl = new URL(context.req.url);
		const route = parseTenantPath(requestUrl.pathname);

		if (route === undefined) {
			return notFoundResponse();
		}

		// A read inside the private namespace needs the addressed cache's read
		// verifier as well as the tenant row. Pass the parsed cache so admission
		// loads both in one D1 batch before any route runs.
		const privateCache = parsePrivateCachePath(route.rest);
		const admission = await admitTenant(
			context.env,
			context.executionCtx,
			route.tenant,
			privateCache?.cache
		);

		if (admission === undefined) {
			return notFoundResponse();
		}

		const { entry, fresh, cacheVerifier, isCacheDeleted } = admission;

		if (
			isTenantRead(context.req.method, route.rest) &&
			entry.status !== 'active'
		) {
			return notFoundResponse();
		}

		context.set('tenant', route.tenant);
		context.set('tenantEntry', entry);
		context.set('tenantEntryFresh', fresh);
		context.set('tenantRest', route.rest);
		context.set('readScope', { visibility: 'public', cache: DEFAULT_CACHE });
		context.set('isCacheDeleted', isCacheDeleted);
		context.set('logger', context.get('logger').with({ tenant: route.tenant }));

		if (cacheVerifier !== undefined) {
			context.set('cacheVerifier', cacheVerifier);
		}

		await next();
	});

	// A `/cache/<name>/` prefix selects a cache in the public namespace. Content
	// reads reject a `_private-` selector, while write routes parse their selector
	// separately and can accept the private namespace. Require the literal
	// spelling for every method because other routing stages inspect the raw path
	// while Hono uses decoded segments.
	app.use('/t/:tenant/cache/:cacheName/*', async (context, next) => {
		if (
			!isLiteralNamespacePath(
				context.get('tenantRest'),
				'cache',
				context.req.param('cacheName')
			)
		) {
			return notFoundResponse();
		}

		if (!isScopedContentRead(context.req.raw, context.get('tenantRest'))) {
			return next();
		}

		const selector = publicCacheSelectorSchema.safeParse(
			context.req.param('cacheName')
		);

		if (!selector.success) {
			return notFoundResponse();
		}

		context.set('readScope', {
			visibility: 'public',
			cache: cacheFromSelector(selector.data)
		});

		return next();
	});

	// A `/private-cache/<name>/` prefix contains a private cache's local name.
	// Every request under this prefix authenticates before route resolution,
	// regardless of its method or whether the cache exists. Admission parses the
	// raw path to load the cache verifier. If the raw namespace or name differs
	// from Hono's decoded route, reject the request instead of falling back to the
	// tenant verifier. Reject a malformed path for the same reason.
	app.use('/t/:tenant/private-cache/:cacheName/*', async (context, next) => {
		const cacheName = context.req.param('cacheName');
		const name = cacheNameSchema.safeParse(cacheName);

		if (
			!name.success ||
			!isLiteralNamespacePath(
				context.get('tenantRest'),
				'private-cache',
				cacheName
			)
		) {
			return unauthorisedResponse();
		}

		context.set('readScope', {
			visibility: 'private',
			cache: privateStoredCache(name.data)
		});

		const denied = await guardScopedRead(
			context.req.raw,
			context.get('tenantEntry'),
			context.get('readScope'),
			context.get('cacheVerifier')
		);

		return denied ?? next();
	});

	// Fetch discovery and signing keys from the tenant Durable Object without
	// caching them. Discovery uses the stored issuer, so an alias cannot advertise
	// another identity.
	app.get('/t/:tenant/.well-known/oauth-authorization-server', (context) =>
		tenantUncachedRead(context, true)
	);
	app.get('/t/:tenant/.well-known/jwks.json', (context) =>
		tenantServer(context.env, context.get('tenant')).fetch(
			innerRequest(context)
		)
	);

	app.route('/t/:tenant', readApp);
	app.route('/t/:tenant/cache/:cacheName', readApp);
	app.route('/t/:tenant/private-cache/:cacheName', readApp);

	// A `/reuse/<view>/` prefix selects a view in the public namespace. Require
	// the literal spelling of the namespace and view name, as for cache routes.
	app.use('/t/:tenant/reuse/:view/*', async (context, next) => {
		if (
			!isLiteralNamespacePath(
				context.get('tenantRest'),
				'reuse',
				context.req.param('view')
			)
		) {
			return withoutStoring(notFoundResponse());
		}

		await next();
	});

	app.post('/t/:tenant/reuse/:view/api/v1/missing-paths', async (context) => {
		const denied = await guardScopedRead(
			context.req.raw,
			context.get('tenantEntry'),
			context.get('readScope')
		);

		return (
			denied ??
			tenantServer(context.env, context.get('tenant')).fetch(
				innerRequest(context)
			)
		);
	});

	// Reuse-view metadata has its own priority and is never cached. Bypass the
	// default-cache renderer.
	app.get('/t/:tenant/reuse/:view/nix-cache-info', async (context) => {
		const denied = await guardScopedRead(
			context.req.raw,
			context.get('tenantEntry'),
			context.get('readScope')
		);

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
			const denied = await guardScopedRead(
				context.req.raw,
				context.get('tenantEntry'),
				context.get('readScope')
			);

			return (
				denied ??
				tenantServer(context.env, context.get('tenant')).fetch(
					innerRequest(context)
				)
			);
		}
	);

	// A `/private-reuse/<view>/` prefix selects a view in the private namespace.
	// A view can select several caches, so only the tenant credential authorises
	// it; a cache-specific credential does not. Every request under the prefix
	// authenticates, regardless of its method or whether the view exists.
	app.use('/t/:tenant/private-reuse/*', async (context, next) => {
		const denied = await guardPrivateViewRead(
			context.req.raw,
			context.get('tenantEntry')
		);

		return denied ?? next();
	});

	// The reader has already presented the tenant credential. Return the
	// namespace's 404 when the raw path does not use the literal namespace and
	// view name.
	app.use('/t/:tenant/private-reuse/:view/*', async (context, next) => {
		if (
			!isLiteralNamespacePath(
				context.get('tenantRest'),
				'private-reuse',
				context.req.param('view')
			)
		) {
			return uncachedNotFoundResponse();
		}

		await next();
	});

	// The Durable Object resolves the view and serves both hits and misses. Apply
	// `no-store` here so no authenticated response can enter a cache, regardless
	// of which Durable Object route produced it.
	const servePrivateReuse = async (
		context: Context<WorkerHonoEnv>
	): Promise<Response> =>
		withoutStoring(
			await tenantServer(context.env, context.get('tenant')).fetch(
				innerRequest(context)
			)
		);

	app.get('/t/:tenant/private-reuse/:view/nix-cache-info', servePrivateReuse);
	app.get(
		String.raw`/t/:tenant/private-reuse/:view/:name{[0-9a-z]+\.narinfo}`,
		servePrivateReuse
	);

	// A private-view narinfo refers to this route, which keeps the NAR inside the
	// authenticated namespace. The NAR URL does not identify a source cache, and
	// the view's selectors may change before the reader follows it. Authorise the
	// read against the tenant's complete private-cache range.
	app.get('/t/:tenant/private-reuse/:view/nar/:name', (context) => {
		const nar = parseNarName(context.req.param('name'));

		if (nar === undefined) {
			return uncachedNotFoundResponse();
		}

		return serveNar(
			context.req.raw,
			context.env,
			context.get('tenant'),
			nar,
			privateNamespaceNarAuthority,
			true
		);
	});

	app.post(
		'/t/:tenant/private-reuse/:view/api/v1/missing-paths',
		servePrivateReuse
	);

	// Public reuse views expose no NAR route under `/reuse/`. Authenticate private
	// tenants before returning 404 and prevent caches from retaining a miss for a
	// route added later.
	app.get('/t/:tenant/reuse/*', async (context) => {
		const denied = await guardScopedRead(
			context.req.raw,
			context.get('tenantEntry'),
			context.get('readScope')
		);

		if (denied !== undefined) {
			return denied;
		}

		const response = notFoundResponse();
		response.headers.set('cache-control', 'no-store');

		return response;
	});

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

	// Nothing in the private namespace reaches the Durable Object fallback below,
	// which serves reads without authenticating the reader. A request the read
	// app does not serve ends here instead: as a 404 when the namespace
	// middleware has already accepted the reader's credential, and as a refusal
	// when the path names no cache to check a credential against. Register these
	// after the mount above so the read app's routes still match.
	app.all('/t/:tenant/private-cache', refusePrivateNamespace);
	app.all('/t/:tenant/private-cache/*', refusePrivateNamespace);

	// The same rule for the private reuse-view namespace. Every path that names
	// a view has already passed the credential check above, so an unserved one
	// ends as a 404. The namespace root names no view, and a request for it is
	// refused without consulting any tenant or view state.
	app.all('/t/:tenant/private-reuse', () => unauthorisedResponse());
	app.all('/t/:tenant/private-reuse/*', () => uncachedNotFoundResponse());

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

// Confirm mutable requests against authoritative D1 status before Durable
// Object dispatch. The tenant Durable Object then applies its own authorisation.
async function dispatchTenant(
	inner: Request,
	env: Env,
	tenant: TenantId,
	// Current admission supplies status from this request's D1 read. If an
	// admission source cannot prove its status is authoritative, dispatch reads D1
	// before a write.
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

// Returns the admitted status only when it came from this request's D1 read.
// An unproven status therefore cannot bypass the authoritative write check.
function admittedWriteStatus(
	context: Context<WorkerHonoEnv>
): TenantEntry['status'] | undefined {
	return context.get('tenantEntryFresh')
		? context.get('tenantEntry').status
		: undefined;
}

// The two read-only POST endpoints bypass the write gate. A WebSocket upgrade
// is sent as a GET request, but the only socket route commits uploads and must
// be gated as a write.
function isTenantWrite(inner: Request): boolean {
	if (inner.headers.get('upgrade')?.toLowerCase() === 'websocket') {
		return true;
	}

	if (inner.method === 'GET' || inner.method === 'HEAD') {
		return false;
	}

	const innerUrl = new URL(inner.url);

	return !(
		isUploadPreviewRequest(inner.method, innerUrl.pathname) ||
		isCacheAvailabilityRequest(inner.method, innerUrl.pathname)
	);
}

// A read addresses cache content: the binary-cache protocol plus the two
// read-only POST endpoints. Admission requires an active tenant for these.
function isTenantRead(method: string, pathname: string): boolean {
	return (
		method === 'GET' ||
		method === 'HEAD' ||
		isUploadPreviewRequest(method, pathname) ||
		isCacheAvailabilityRequest(method, pathname)
	);
}

// Whether the request reads content from the cache selected by its URL prefix.
// A commit upgrade uses GET, and an upload preview uses a read-only POST, but
// both use the write surface. The write surface accepts private cache
// selectors, so neither request is a scoped content read.
function isScopedContentRead(request: Request, pathname: string): boolean {
	if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
		return false;
	}

	return (
		request.method === 'GET' ||
		request.method === 'HEAD' ||
		isCacheAvailabilityRequest(request.method, pathname)
	);
}

// Ends a request in the private namespace that addresses no cache content. The
// namespace middleware has already checked the reader's credential whenever the
// path names a cache, and a path that names none is refused without consulting
// any tenant or cache state, so neither answer reports whether a cache exists.
function refusePrivateNamespace(context: Context<WorkerHonoEnv>): Response {
	return context.get('readScope').visibility === 'private'
		? uncachedNotFoundResponse()
		: unauthorisedResponse();
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
