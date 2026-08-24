import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';

import {
	WorkersCachePurgeError,
	WorkersCacheUnavailableError
} from './errors.ts';
import { tenantReadFetch } from './routing/tenant-read-handler.ts';

export { CupboardServer } from './do/server.ts';

/**
 * Cloudflare refuses to deploy an earlier Worker version across a Durable
 * Object class lifecycle change. This unbound class creates that boundary for
 * the change to versioned R2 object keys; because it has no binding, the Worker
 * cannot create instances.
 */
export class VersionedR2ObjectRollbackGuard extends DurableObject<TenantEnv> {}

export default class TenantWorker extends WorkerEntrypoint<TenantEnv> {
	/**
	Refuses requests to the tenant Worker's publicly routable entrypoint.
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
		return tenantReadFetch(request, this.env, this.ctx);
	}

	/**
	 * Purges every supplied cache tag and rejects unless the Cache API confirms
	 * the operation.
	 */
	async purgeTags(tags: string[]): Promise<void> {
		if (this.ctx.cache === undefined) {
			throw new WorkersCacheUnavailableError();
		}

		const result = await this.ctx.cache.purge({ tags });

		if (result.success) {
			return;
		}

		const details = result.errors
			.map((error) => `${String(error.code)}: ${error.message}`)
			.join('; ');
		throw new WorkersCachePurgeError(details);
	}
}
