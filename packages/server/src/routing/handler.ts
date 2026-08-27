import {
	cacheFromSelector,
	cacheSelectorSchema,
	DEFAULT_CACHE,
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
import { notFoundResponse, TextBody, textResponse } from '../http/http.ts';
import { loggerMiddleware } from '../observability/logging.ts';
import { guardScopedRead } from '../read/read.ts';

import { admitTenant, type TenantEntry } from './admission.ts';
import { tenantServer } from './durable-object.ts';
import { type WorkerHonoEnv } from './hono-env.ts';
import { computeNegotiateHints } from './negotiate-hints.ts';
import { readApp } from './read-app.ts';
import { enqueueMaintenanceJobs, handleMaintenanceQueue } from './scheduled.ts';
import { innerRequest, tenantUncachedRead } from './tenant-forward.ts';
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

	// RFC 8414 inserts the well-known component before a path-based issuer.
	// Keep the older appended spelling below for existing clients, but publish
	// and serve the standard tenant metadata URL here.
	app.get(
		'/.well-known/oauth-authorization-server/t/:tenant',
		async (context) => {
			const tenant = tenantIdSchema.safeParse(context.req.param('tenant'));

			if (!tenant.success) {
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

		const admission = await admitTenant(
			context.env,
			context.executionCtx,
			route.tenant
		);

		if (admission === undefined) {
			return notFoundResponse();
		}

		const { entry, fresh } = admission;

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
		context.set('logger', context.get('logger').with({ tenant: route.tenant }));

		await next();
	});

	// A `/cache/<name>/` prefix selects a named cache in the public namespace.
	// The private namespace is not read-addressable here, so a `_private-`
	// selector is refused with the same 404 as a malformed one. A write parses
	// its own selector, which does admit the private namespace, so only reads
	// pass through this rule.
	app.use('/t/:tenant/cache/:cacheName/*', async (context, next) => {
		if (!isTenantRead(context.req.method, context.get('tenantRest'))) {
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

	// The binary-cache protocol, served for the default cache at the bare tenant
	// prefix and for a named cache under `/cache/<name>/`.
	app.route('/t/:tenant', readApp);
	app.route('/t/:tenant/cache/:cacheName', readApp);

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

	// Reuse views expose no NAR route. Authenticate private tenants before the 404
	// and prevent caches from retaining a miss for a route added later.
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
// read-only POST endpoints. Admission requires an active tenant for these, and
// only these carry a cache prefix the edge parses.
function isTenantRead(method: string, pathname: string): boolean {
	return (
		method === 'GET' ||
		method === 'HEAD' ||
		isUploadPreviewRequest(method, pathname) ||
		isCacheAvailabilityRequest(method, pathname)
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
