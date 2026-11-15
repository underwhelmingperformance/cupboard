import { type Context } from 'hono';

import {
	SharedDeadline,
	type TenantWorkerRead,
	withinTenantWorkerRead
} from '../do/deadline.ts';
import { negotiateHintsHeader } from '../do/negotiate-hints.ts';
import { forbidStoring } from '../http/bounded-body.ts';
import { tenantNarReadBudgetMs } from '../policy/streaming.ts';

import { canonicalCacheRequest } from './cache-request.ts';
import { tenantServer } from './durable-object.ts';
import { type WorkerHonoEnv } from './hono-env.ts';
import { forwardRead, type ReadDeadline } from './read-forward.ts';
import { tenantReadFetch } from './tenant-read-handler.ts';

/**
Strips the public tenant prefix and any client-supplied hint token. Upload
negotiation adds a server-issued token only after this sanitisation.
*/
export function innerRequest(context: Context<WorkerHonoEnv>): Request {
	const inner = new URL(context.req.url);
	inner.pathname = context.get('tenantRest');
	const request = new Request(inner, context.req.raw);
	request.headers.delete(negotiateHintsHeader);

	return request;
}

/**
Returns the deadline for the response headers of `read`. A narinfo GET and
each narinfo read of a `path-info` probe get what admission left of the read
budget, so that admission and the reads together end within the CLI's
attempt; the rounds of a probe share it. A NAR gets
{@link tenantNarReadBudgetMs} from the call.
*/
function tenantWorkerReadDeadline(
	context: Context<WorkerHonoEnv>,
	read: TenantWorkerRead
): SharedDeadline {
	switch (read) {
		case 'narinfo':
		case 'path-info-narinfo': {
			return context.get('admissionDeadline');
		}
		case 'nar': {
			return new SharedDeadline(
				tenantNarReadBudgetMs,
				context.get('clock').now
			);
		}
	}
}

/**
Sends a cacheable read to the cache-owning tenant Worker, which serves it
through Workers Cache. `read` chooses the deadline for the response headers.
The tenant Worker is a separate script in production and absent in
development and tests, where the same read app runs in process.
*/
export async function cachedTenantRead(
	context: Context<WorkerHonoEnv>,
	read: TenantWorkerRead,
	readRequest: Request = context.req.raw
): Promise<Response> {
	// The in-process app takes the same canonical request as the service binding,
	// so development and tests receive the same environment as the deployed
	// tenant Worker.
	const request = canonicalCacheRequest(
		readRequest,
		context.get('cacheVersion')
	);
	const { CUPBOARD_TENANT: service } = context.env as Partial<
		Pick<Env, 'CUPBOARD_TENANT'>
	>;

	if (service !== undefined) {
		return withinTenantWorkerRead(
			{ read, deadline: tenantWorkerReadDeadline(context, read) },
			() => service.fetch(request)
		);
	}

	return tenantReadFetch(request, context.env, context.executionCtx);
}

/**
Sends a read straight to the tenant Durable Object, bypassing Workers Cache,
with the deadline that `deadline` chooses.
*/
export async function tenantUncachedRead(
	context: Context<WorkerHonoEnv>,
	deadline: ReadDeadline,
	shouldForceNoStore = false
): Promise<Response> {
	const response = await forwardRead(context, deadline, () =>
		tenantServer(context.env, context.get('tenant')).fetch(
			innerRequest(context)
		)
	);

	return shouldForceNoStore ? withoutStoring(response) : response;
}

/**
Copies a response and sets `Cache-Control: no-store`.

Responses returned by `fetch` have immutable headers, so Hono can apply
the policy only to a copy.
*/
export function withoutStoring(response: Response): Response {
	const headers = new Headers(response.headers);
	forbidStoring(headers);

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}
