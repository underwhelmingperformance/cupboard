import { tenantContract } from '@cupboard/protocol/contract';
import { implement } from '@orpc/server';

import { type TenantOrpcContext } from './context.ts';
import { bridgedError } from './error-bridge.ts';

// The implementer carries the cross-cutting middleware every procedure runs:
// the error bridge, authentication against the scope the contract's meta
// declares (an admin token satisfies every scope), and the
// maintenance-eligibility bracket for procedures whose meta marks them
// mutating. The contract supplies the scope and maintenance declarations, so
// nothing is repeated per procedure here.
const os = implement(tenantContract)
	.$context<TenantOrpcContext>()
	.use(async ({ next }) => {
		try {
			return await next();
		} catch (error) {
			throw bridgedError(error);
		}
	})
	.use(async ({ context, procedure, next }) => {
		const claims = await context.services.requireScope(
			context.request,
			procedure['~orpc'].meta.scope
		);

		return next({ context: { claims } });
	})
	.use(({ context, procedure, next }) =>
		procedure['~orpc'].meta.maintenance === true
			? context.services.withMaintenanceEligibility(async () => next())
			: next()
	);

export const tenantRouter = os.router({
	caches: {
		list: os.caches.list.handler(({ context }) =>
			context.services.cacheAdmin.listCaches()
		),
		put: os.caches.put.handler(({ input, context }) =>
			context.services.cacheAdmin.putCache(input.cacheName, input.priority)
		),
		remove: os.caches.remove.handler(({ input, context }) =>
			context.services.cacheAdmin.removeCache(
				input.params.cacheName,
				input.query.force,
				new URL(context.request.url).origin
			)
		)
	}
});
