import { eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';

import { handleControl } from '../control/control-plane.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { TenantWritesStoppedError } from '../errors.ts';
import { serverErrorResponse } from '../http/error-response.ts';
import { handleRead } from '../read/read.ts';

import { admitTenant } from './admission.ts';
import { handleDeployment } from './deployment.ts';
import { tenantServer } from './durable-object.ts';
import { runCronSweep } from './scheduled.ts';
import { parseTenantPath } from './tenant-routing.ts';

export default {
	async fetch(request, env, ctx) {
		// Deployment-level endpoints answer at the bare host before any tenant or
		// control routing.
		const deployment = await handleDeployment(request);

		if (deployment !== undefined) {
			return deployment;
		}

		const url = new URL(request.url);
		const route = parseTenantPath(url.pathname);

		// The bare host is the control surface: the control plane's own auth.
		if (route === undefined) {
			const control = await handleControl(request, env);

			return control ?? notFound();
		}

		// Admission resolves the slug against the published manifest, reading only
		// KV. A slug absent from the manifest is rejected here, before any Durable
		// Object is instantiated, so varying the slug cannot spin up unbounded
		// unprovisioned objects.
		const entry = await admitTenant(env.TENANT_CACHE, route.tenant);

		if (entry === undefined) {
			return notFound();
		}

		// Strip the `/t/<tenant>/` prefix and serve the tenant-relative request: a
		// read from R2 and the edge, or otherwise the tenant's Durable Object.
		const inner = tenantRequest(request, url, route.rest);
		const read = await handleRead(inner, env, ctx, route.tenant, entry);

		if (read !== undefined) {
			return read;
		}

		return dispatchTenant(inner, env, route.tenant);
	},

	async scheduled(_controller, env) {
		// The cron sweeps a bounded batch of active tenants per tick, advancing a
		// cursor over slug order so the whole fleet is maintained over successive
		// ticks without exhausting the subrequest budget. A non-default tenant's
		// deferred uploads need this background pass to become servable.
		await runCronSweep(env);
	}
} satisfies ExportedHandler<Env>;

// Dispatches a non-read tenant request to its Durable Object. A write (anything but
// a read or the auth-plane token exchange) is gated first: a write for a suspended or
// offboarding tenant is stopped on an authoritative D1 status read. The Durable
// Object then authorises it against that tenant's own keys and writes only that
// tenant's storage.
async function dispatchTenant(
	inner: Request,
	env: Env,
	tenant: string
): Promise<Response> {
	if (!isTenantWrite(inner)) {
		return tenantServer(env, tenant).fetch(inner);
	}

	const status = await tenantStatus(env, tenant);

	if (status !== 'active') {
		return serverErrorResponse(
			Promise.reject(new TenantWritesStoppedError(tenant, status ?? 'unknown'))
		);
	}

	return tenantServer(env, tenant).fetch(inner);
}

// Whether a tenant request mutates state. Reads never do; the token exchange is an
// auth-plane request available to any configured tenant, so it is not a write.
function isTenantWrite(inner: Request): boolean {
	if (inner.method === 'GET' || inner.method === 'HEAD') {
		return false;
	}

	return new URL(inner.url).pathname !== '/token';
}

// The authoritative tenant status, read from D1 rather than the KV manifest, so a
// write stop takes effect before the manifest TTL catches up. Returns undefined if
// the row is gone, which the caller treats as not-active and fails closed.
async function tenantStatus(
	env: Env,
	tenant: string
): Promise<string | undefined> {
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
	const row = await database
		.select({ status: d1Schema.tenant.status })
		.from(d1Schema.tenant)
		.where(eq(d1Schema.tenant.id, tenant))
		.get();

	return row?.status;
}

function notFound(): Response {
	return new Response('Not found\n', {
		status: 404,
		headers: { 'content-type': 'text/plain; charset=utf-8' }
	});
}

function tenantRequest(request: Request, url: URL, rest: string): Request {
	const inner = new URL(url);
	inner.pathname = rest;

	return new Request(inner, request);
}
