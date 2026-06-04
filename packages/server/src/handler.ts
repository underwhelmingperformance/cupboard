import { handleDeployment } from './deployment.ts';
import { cupboardServer, tenantServer } from './durable-object.ts';
import { handleRead } from './read.ts';
import { runScheduledMaintenance } from './scheduled.ts';
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

		// The bare host is the control surface; its routes land with the control
		// plane, so until then a non-tenant path is not found.
		if (route === undefined) {
			return new Response('Not found\n', {
				status: 404,
				headers: { 'content-type': 'text/plain; charset=utf-8' }
			});
		}

		// Strip the `/t/<tenant>/` prefix and serve the tenant-relative request: a
		// read from R2 and the edge, or otherwise the tenant's Durable Object.
		const inner = tenantRequest(request, url, route.rest);
		const read = await handleRead(inner, env, ctx, route.tenant);

		if (read !== undefined) {
			return read;
		}

		return tenantServer(env, route.tenant).fetch(inner);
	},

	async scheduled(_controller, env) {
		// The service binding authorises these calls, so the cron drives
		// maintenance through direct Durable Object RPC with no token to exchange.
		const server = cupboardServer(env);

		await runScheduledMaintenance(
			() => server.runGarbageCollection(),
			() => server.runVerification()
		);
	}
} satisfies ExportedHandler<Env>;

function tenantRequest(request: Request, url: URL, rest: string): Request {
	const inner = new URL(url);
	inner.pathname = rest;

	return new Request(inner, request);
}
