import { type Context } from 'hono';

import { negotiateHintsHeader } from '../do/negotiate-hints.ts';

import { canonicalCacheRequest } from './cache-request.ts';
import { tenantServer } from './durable-object.ts';
import { type WorkerHonoEnv } from './hono-env.ts';
import { tenantReadFetch } from './tenant-read-handler.ts';

/**
 * Strips the public tenant prefix and any client-supplied hint token. Upload
 * negotiation adds a server-issued token only after this sanitisation.
 */
export function innerRequest(context: Context<WorkerHonoEnv>): Request {
	const inner = new URL(context.req.url);
	inner.pathname = context.get('tenantRest');
	const request = new Request(inner, context.req.raw);
	request.headers.delete(negotiateHintsHeader);

	return request;
}

/**
 * Sends a cacheable read to the cache-owning tenant Worker, which serves it
 * through Workers Cache. The tenant Worker is a separate script in production
 * and absent in development and tests, where the same read app runs in process.
 */
export async function cachedTenantRead(
	context: Context<WorkerHonoEnv>
): Promise<Response> {
	// The in-process app takes the same canonical request as the service binding,
	// so development and tests see what the deployed tenant Worker receives.
	const request = canonicalCacheRequest(context.req.raw);
	const { CUPBOARD_TENANT: service } = context.env as Partial<
		Pick<Env, 'CUPBOARD_TENANT'>
	>;

	if (service !== undefined) {
		return service.fetch(request);
	}

	return tenantReadFetch(
		request,
		context.env as unknown as TenantEnv,
		context.executionCtx
	);
}

/**
 * Sends a read straight to the tenant Durable Object, bypassing Workers Cache.
 */
export async function tenantUncachedRead(
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
