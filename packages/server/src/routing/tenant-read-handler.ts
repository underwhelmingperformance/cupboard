import {
	cacheFromSelector,
	DEFAULT_CACHE,
	publicCacheSelectorSchema,
	type StoredCache,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { type Context, Hono } from 'hono';
import { StatusCodes } from 'http-status-codes';

import { serverErrorHandler } from '../http/error-response.ts';
import {
	notFoundResponse,
	parseAttestationDigestName,
	parseNarInfoName,
	parseNarName
} from '../http/http.ts';
import { cacheInfoResponse, serveNar, serveNarInfo } from '../read/read.ts';

import { tenantServer } from './durable-object.ts';
import { parseTenantPath } from './tenant-routing.ts';

interface TenantReadHonoEnv {
	Bindings: TenantEnv;
	Variables: {
		tenant: TenantId;
		cache: StoredCache;
		tenantRest: string;
	};
}

const minimumErrorStatus: number = StatusCodes.BAD_REQUEST;

function noStore(response: Response): Response {
	const mutable = new Response(response.body, response);
	mutable.headers.set('cache-control', 'no-store');

	return mutable;
}

function innerRequest(context: Context<TenantReadHonoEnv>): Request {
	const inner = new URL(context.req.url);
	inner.pathname = context.get('tenantRest');

	return new Request(inner, context.req.raw);
}

/**
 * The reads this Worker serves through Workers Cache, relative to the cache
 * each one addresses. The control Worker forwards a read here only after it has
 * admitted the tenant and found the read needs no credential.
 *
 * Hono answers HEAD by re-dispatching the request to the GET handler with the
 * body stripped, so a separate HEAD registration would never match.
 */
function buildCachedReadApp(): Hono<TenantReadHonoEnv> {
	const app = new Hono<TenantReadHonoEnv>();

	app.get('/nix-cache-info', async (context) => {
		const cache = context.get('cache');
		const response = await cacheInfoResponse(
			innerRequest(context),
			context.env,
			context.get('tenant'),
			cache,
			false
		);

		return cache === DEFAULT_CACHE ? response : noStore(response);
	});

	app.get(String.raw`/:name{[0-9a-z]+\.narinfo}`, (context) => {
		const storePathHash = parseNarInfoName(context.req.param('name') ?? '');

		if (storePathHash === undefined) {
			return noStore(notFoundResponse());
		}

		return serveNarInfo(
			context.req.raw,
			context.env,
			context.get('tenant'),
			context.get('cache'),
			storePathHash,
			false
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
			nar.narHash,
			false,
			nar.incarnation
		);
	});

	app.get('/attestation-bundles/:digest', async (context, next) => {
		if (parseAttestationDigestName(context.req.param('digest')) === undefined) {
			return next();
		}

		return noStore(
			await tenantServer(context.env, context.get('tenant')).fetch(
				innerRequest(context)
			)
		);
	});

	return app;
}

const cachedReadApp = buildCachedReadApp();

function buildTenantReadApp(): Hono<TenantReadHonoEnv> {
	const app = new Hono<TenantReadHonoEnv>();

	app.onError(serverErrorHandler);
	app.notFound(() => noStore(notFoundResponse()));
	app.use('*', async (context, next) => {
		await next();

		if (context.res.status >= minimumErrorStatus) {
			context.res = noStore(context.res);
		}
	});
	app.use('/t/:tenant/*', async (context, next) => {
		const route = parseTenantPath(new URL(context.req.url).pathname);

		if (route === undefined) {
			return noStore(notFoundResponse());
		}

		context.set('tenant', route.tenant);
		context.set('cache', DEFAULT_CACHE);
		context.set('tenantRest', route.rest);
		await next();
	});

	// Only the public namespace is mounted here, and deliberately so: every read
	// in the private namespace must stay on the control Worker, where the reader
	// is authenticated and the response is marked `no-store`. Giving this Worker
	// a private mount would put private content behind Workers Cache.
	app.use('/t/:tenant/cache/:cacheName/*', async (context, next) => {
		const selector = publicCacheSelectorSchema.safeParse(
			context.req.param('cacheName')
		);

		if (!selector.success) {
			return noStore(notFoundResponse());
		}

		context.set('cache', cacheFromSelector(selector.data));
		await next();
	});

	app.get(
		'/t/:tenant/.well-known/oauth-authorization-server',
		async (context) =>
			noStore(
				await tenantServer(context.env, context.get('tenant')).fetch(
					innerRequest(context)
				)
			)
	);

	app.route('/t/:tenant', cachedReadApp);
	app.route('/t/:tenant/cache/:cacheName', cachedReadApp);

	return app;
}

const tenantReadApp = buildTenantReadApp();

/**
Serves public cacheable reads after the control Worker admits the tenant.
*/
export function tenantReadFetch(
	request: Request,
	env: TenantEnv,
	ctx: Parameters<typeof tenantReadApp.fetch>[2]
): Promise<Response> {
	return Promise.resolve(tenantReadApp.fetch(request, env, ctx));
}
