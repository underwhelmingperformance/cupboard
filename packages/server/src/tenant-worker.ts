import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';

import { WorkersCacheUnavailableError } from './errors.ts';
import { cachedTenantReadFetch } from './routing/tenant-read-handler.ts';

export { ControlDatabaseRollbackGuard } from './control-database-rollback-guard.ts';
export { CupboardServer } from './do/server.ts';
export { PathReadAuthorityRollbackGuard } from './path-read-authority-rollback-guard.ts';

/**
Cloudflare refuses to deploy an earlier Worker version across a Durable
Object class lifecycle change. This unbound class creates that boundary for
the change to versioned R2 object keys; because it has no binding, the Worker
cannot create instances.
*/
export class VersionedR2ObjectRollbackGuard extends DurableObject<TenantEnv> {}

export default class TenantWorker extends WorkerEntrypoint<TenantEnv> {
	/**
	Refuses requests to the tenant Worker's publicly routable entrypoint.

	`CachedTenantReads` takes the addressed cache's generation from the
	request, so a caller that could reach it could read the objects of a
	deleted incarnation. This entrypoint must keep refusing every request: a
	route here would make that generation caller-controlled.
	*/
	override fetch(): Response {
		return new Response(undefined, {
			status: StatusCodes.NOT_FOUND,
			headers: { 'cache-control': 'no-store' }
		});
	}
}

/**
Serves cacheable reads admitted by the control Worker.
*/
export class CachedTenantReads extends WorkerEntrypoint<TenantEnv> {
	override fetch(request: Request): Promise<Response> {
		return cachedTenantReadFetch(request, this.env, this.ctx);
	}

	/**
	Purges every supplied cache tag and returns the Cache API's result. The
	caller checks `success`. A refusal is returned rather than thrown because
	the error's class and `codes` would not survive the RPC call.
	*/
	async purgeTags(tags: string[]): Promise<CachePurgeResult> {
		if (this.ctx.cache === undefined) {
			throw new WorkersCacheUnavailableError();
		}

		const result = await this.ctx.cache.purge({ tags });

		return {
			success: result.success,
			errors: result.errors.map(({ code, message }) => ({ code, message }))
		};
	}
}
