import {
	cacheNameSchema,
	type CacheScope,
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
import { narAuthorityForScope, serveNar, serveNarInfo } from '../read/read.ts';

import { tenantServer } from './durable-object.ts';
import { isLiteralNamespacePath, parseTenantPath } from './tenant-routing.ts';

interface TenantReadHonoEnv {
	Bindings: TenantEnv;
	Variables: {
		tenant: TenantId;
		cache: CacheScope;
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
 * admitted the tenant and resolved the selected cache as public.
 *
 * Hono answers HEAD by re-dispatching the request to the GET handler with the
 * body stripped, so a separate HEAD registration would never match.
 */
function buildCachedReadApp(): Hono<TenantReadHonoEnv> {
	const app = new Hono<TenantReadHonoEnv>();

	app.get(String.raw`/:name{[0-9a-z]+\.narinfo}`, (context) => {
		const storePathHash = parseNarInfoName(context.req.param('name') ?? '');

		if (storePathHash === undefined) {
			return noStore(notFoundResponse());
		}

		return serveNarInfo(
			context.req.raw,
			context.env,
			context.get('tenant'),
			{ scope: context.get('cache'), access: 'public' },
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
			nar,
			narAuthorityForScope({
				scope: context.get('cache'),
				access: 'public'
			}),
			false
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
		context.set('cache', { kind: 'default' });
		context.set('tenantRest', route.rest);
		await next();
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
