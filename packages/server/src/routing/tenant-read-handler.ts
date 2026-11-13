import {
	type CacheGeneration,
	cacheNameSchema,
	type CacheScope,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { type Context, Hono } from 'hono';
import { StatusCodes } from 'http-status-codes';

import { boundedWorkerEnv } from '../do/bounded-io.ts';
import { SharedDeadline, withinReadDeadline } from '../do/deadline.ts';
import { withSubrequestSlice } from '../do/subrequest-slice.ts';
import { type DeadlineClock, systemClock } from '../do/tenant-object-fetch.ts';
import { forbidStoring, keepAliveIn } from '../http/bounded-body.ts';
import { serverErrorHandler } from '../http/error-response.ts';
import {
	notFoundResponse,
	parseAttestationDigestName,
	parseNarInfoName,
	parseNarName
} from '../http/http.ts';
import { readDeadline } from '../http/read-deadline.ts';
import {
	loggerMiddleware,
	requestCostMiddleware
} from '../observability/logging.ts';
import {
	withInternalRequest,
	withoutCachedCorrelation
} from '../observability/request-context.ts';
import { withSpan } from '../observability/span.ts';
import { readRequestBudgetMs } from '../policy/streaming.ts';
import { subrequestsPerInvocation } from '../policy/subrequests.ts';
import {
	narAuthorityForScope,
	type ReadEnv,
	type ReadScope,
	serveNar,
	serveNarInfo
} from '../read/read.ts';

import {
	cacheRequestVersion,
	hasCurrentCacheKeyVersion
} from './cache-request.ts';
import { tenantServer } from './durable-object.ts';
import { isLiteralNamespacePath, parseTenantPath } from './tenant-routing.ts';

interface TenantReadHonoEnv {
	Bindings: ReadEnv;
	Variables: {
		tenant: TenantId;
		cache: CacheScope;
		// Which incarnation of the cache name admission resolved, taken from the
		// canonical request. Object keys are built from this generation.
		generation: CacheGeneration;
		tenantRest: string;
	};
}

const minimumErrorStatus: number = StatusCodes.BAD_REQUEST;

function noStore(response: Response): Response {
	const mutable = new Response(response.body, response);
	forbidStoring(mutable.headers);

	return mutable;
}

// The control Worker forwards only public cache reads here, so every read this
// app serves has public access.
function readScope(context: Context<TenantReadHonoEnv>): ReadScope {
	return {
		scope: context.get('cache'),
		access: 'public',
		generation: context.get('generation')
	};
}

function innerRequest(context: Context<TenantReadHonoEnv>): Request {
	const inner = new URL(context.req.url);
	inner.pathname = context.get('tenantRest');

	return new Request(inner, context.req.raw);
}

/**
Forwards the read to the tenant Durable Object. The capped worst case of the
object's work for these reads fits within the read budget. This Worker has
no admission budget, so each read starts a read deadline of its own on `now`.
*/
function forwardRead(
	context: Context<TenantReadHonoEnv>,
	now: () => number
): Promise<Response> {
	return withinReadDeadline(new SharedDeadline(readRequestBudgetMs, now), () =>
		tenantServer(context.env, context.get('tenant')).fetch(
			innerRequest(context)
		)
	);
}

/**
The reads this Worker serves through Workers Cache, relative to the cache
each one addresses. The control Worker forwards a read here only after it has
admitted the tenant and resolved the selected cache as public.

Hono answers HEAD by re-dispatching the request to the GET handler with the
body stripped, so a separate HEAD registration would never match.
*/
function buildCachedReadApp(now: () => number): Hono<TenantReadHonoEnv> {
	const app = new Hono<TenantReadHonoEnv>();

	app.get(String.raw`/:name{[0-9a-z]+\.narinfo}`, readDeadline, (context) => {
		const storePathHash = parseNarInfoName(context.req.param('name') ?? '');

		if (storePathHash === undefined) {
			return noStore(notFoundResponse());
		}

		return serveNarInfo(
			context.req.raw,
			context.env,
			context.get('tenant'),
			readScope(context),
			storePathHash,
			false,
			keepAliveIn(context.executionCtx)
		);
	});

	app.get('/nar/:name', (context) => {
		const nar = parseNarName(context.req.param('name'));

		if (nar === undefined) {
			return noStore(notFoundResponse());
		}

		return serveNar(
			context.req.raw,
			context.env,
			context.get('tenant'),
			nar,
			narAuthorityForScope(readScope(context)),
			false
		);
	});

	app.get('/attestation-bundles/:digest', async (context, next) => {
		if (parseAttestationDigestName(context.req.param('digest')) === undefined) {
			return next();
		}

		return noStore(await forwardRead(context, now));
	});

	return app;
}

function buildTenantReadApp(now: () => number): Hono<TenantReadHonoEnv> {
	const cachedReadApp = buildCachedReadApp(now);
	const app = new Hono<TenantReadHonoEnv>();

	app.onError(serverErrorHandler);
	app.notFound(() => noStore(notFoundResponse()));
	app.use(requestCostMiddleware);
	app.use(loggerMiddleware);
	app.use('*', async (context, next) => {
		await next();

		if (context.res.status >= minimumErrorStatus) {
			context.res = noStore(context.res);
		}
	});
	app.use('/t/:tenant/*', async (context, next) => {
		const route = parseTenantPath(new URL(context.req.url).pathname);
		const version = cacheRequestVersion(context.req.raw);

		// Without the admitted generation, neither the object key nor the Workers
		// Cache key can distinguish a deleted cache from its replacement.
		if (route === undefined || version === undefined) {
			return noStore(notFoundResponse());
		}

		context.set('tenant', route.tenant);
		context.set('cache', { kind: 'default' });
		// A caller who chooses the generation could read a deleted cache's
		// objects. Only the control Worker's service binding may reach this app,
		// after admission has read the generation from D1. The tenant Worker's
		// public entrypoint must continue to refuse requests.
		context.set('generation', version.generation);
		context.set('tenantRest', route.rest);
		await next();

		if (hasCurrentCacheKeyVersion(context.req.raw)) {
			return;
		}

		const uncached = noStore(context.res);
		// Hono copies the previous response's headers over a replacement, which
		// would restore its `Cache-Control`. Clear the previous response first.
		context.res = undefined;
		context.res = uncached;
	});

	// The control Worker sends only public cache reads here. Private reads remain
	// on the control Worker, where the reader is authenticated and the response
	// is marked `no-store`.
	app.use('/t/:tenant/cache/:cacheName/*', async (context, next) => {
		const cacheName = context.req.param('cacheName');
		const name = cacheNameSchema.safeParse(cacheName);

		// The Workers Cache key retains the raw pathname. Hono decodes the matched
		// path and the cache parameter used for R2 keys and cache tags. Refuse the
		// request if the raw and decoded paths identify different caches.
		if (
			!name.success ||
			!isLiteralNamespacePath(context.get('tenantRest'), 'cache', cacheName)
		) {
			return noStore(notFoundResponse());
		}

		context.set('cache', { kind: 'named', name: name.data });
		await next();
	});

	app.get(
		'/t/:tenant/.well-known/oauth-authorization-server',
		async (context) => noStore(await forwardRead(context, now))
	);

	app.route('/t/:tenant', cachedReadApp);
	app.route('/t/:tenant/cache/:cacheName', cachedReadApp);

	return app;
}

type TenantReadContext = Parameters<Hono<TenantReadHonoEnv>['fetch']>[2];

const tenantReadApps = new WeakMap<DeadlineClock, Hono<TenantReadHonoEnv>>();

function tenantReadAppFor(clock: DeadlineClock): Hono<TenantReadHonoEnv> {
	const existing = tenantReadApps.get(clock);

	if (existing !== undefined) {
		return existing;
	}

	const app = buildTenantReadApp(clock.now);
	tenantReadApps.set(clock, app);

	return app;
}

/**
Serves public cacheable reads after the control Worker admits the tenant.
*/
export async function tenantReadFetch(
	request: Request,
	env: ReadEnv,
	ctx: TenantReadContext,
	clock: DeadlineClock = systemClock
): Promise<Response> {
	const response = await tenantReadAppFor(clock).fetch(request, env, ctx);

	return withoutCachedCorrelation(response);
}

/**
Serves one read for the tenant Worker's `CachedTenantReads` entrypoint. It
bounds the bindings of `env` and runs the read within the invocation's
subrequest slice. `clock` starts and waits out the deadlines of the reads
that the tenant Worker forwards to the tenant object.
*/
export function cachedTenantReadFetch(
	request: Request,
	env: ReadEnv & Parameters<typeof subrequestsPerInvocation>[0],
	ctx: TenantReadContext,
	clock: DeadlineClock = systemClock
): Promise<Response> {
	return withInternalRequest(request, () =>
		withSubrequestSlice(
			() =>
				tenantReadFetch(
					request,
					boundedWorkerEnv(env, withSpan, clock.delay),
					ctx,
					clock
				),
			{ subrequests: subrequestsPerInvocation(env) }
		)
	);
}
