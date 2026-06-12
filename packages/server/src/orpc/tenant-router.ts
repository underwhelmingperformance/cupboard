import { cacheFromSelector } from '@cupboard/nix/scalars';
import { tenantContract } from '@cupboard/protocol/contract';
import { type GcResponse } from '@cupboard/protocol/retention';
import { implement } from '@orpc/server';

import { internalOrigin } from '../http/http.ts';

import { type TenantOrpcContext, type TenantRpcServices } from './context.ts';
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
	},
	keys: {
		signing: {
			list: os.keys.signing.list.handler(({ context }) =>
				context.services.signingKeys.keyList()
			),
			rotate: os.keys.signing.rotate.handler(({ context }) =>
				context.services.signingKeys.rotateKey()
			),
			retire: os.keys.signing.retire.handler(({ input, context }) =>
				context.services.signingKeys.retireKey(input.id)
			)
		},
		auth: {
			list: os.keys.auth.list.handler(({ context }) =>
				context.services.authKeys.authKeyList()
			),
			rotate: os.keys.auth.rotate.handler(({ context }) =>
				context.services.authKeys.rotateAuthKey()
			),
			retire: os.keys.auth.retire.handler(({ input, context }) =>
				context.services.authKeys.retireAuthKey(input.kid)
			)
		}
	},
	policies: {
		list: os.policies.list.handler(({ context }) =>
			context.services.retention.listPolicies()
		),
		add: os.policies.add.handler(({ input, context }) =>
			context.services.retention.addPolicy(input)
		),
		remove: os.policies.remove.handler(({ input, context }) =>
			context.services.retention.removePolicy(input.id)
		)
	},
	oidcTrust: {
		list: os.oidcTrust.list.handler(({ context }) =>
			context.services.oidcTrust.listRules()
		),
		add: os.oidcTrust.add.handler(({ input, context }) =>
			context.services.oidcTrust.addRule(input)
		),
		remove: os.oidcTrust.remove.handler(({ input, context }) =>
			context.services.oidcTrust.removeRule(input.id)
		)
	},
	stats: {
		cache: os.stats.cache.handler(({ input, context }) =>
			context.services.stats.stats(cacheFromSelector(input.cacheName))
		),
		usage: os.stats.usage.handler(({ context }) =>
			context.services.stats.usage()
		)
	},
	check: {
		run: os.check.run.handler(({ input, context }) =>
			context.services.integrityCheck.check(input.deep)
		)
	},
	roots: {
		list: os.roots.list.handler(({ input, context }) =>
			context.services.roots.listRoots(cacheFromSelector(input.cacheName))
		),
		set: os.roots.set.handler(({ input, context }) =>
			context.services.roots.setRoot(
				context.claims,
				cacheFromSelector(input.cacheName),
				input.name,
				{ targets: input.targets, ttlSeconds: input.ttlSeconds }
			)
		),
		remove: os.roots.remove.handler(({ input, context }) =>
			context.services.roots.removeRoot(
				cacheFromSelector(input.cacheName),
				input.name
			)
		)
	},
	paths: {
		remove: os.paths.remove.handler(({ input, context }) =>
			context.services.deletionQueue.deleteStorePath(
				cacheFromSelector(input.cacheName),
				input.hash,
				new URL(context.request.url).origin
			)
		)
	},
	gc: {
		runAll: os.gc.runAll.handler(({ context }) =>
			collectGarbage(context.request, context.services)
		),
		runCache: os.gc.runCache.handler(({ input, context }) =>
			collectGarbage(
				context.request,
				context.services,
				cacheFromSelector(input.cacheName)
			)
		)
	}
});

// Interactive GC purges this colo's edge cache via the caller's public
// origin. The cron sweep arrives on the internal origin and cannot know the
// public URL, so it skips purging and relies on the narinfo TTL and the
// orphan-blob grace window instead.
async function collectGarbage(
	request: Request,
	services: TenantRpcServices,
	cache?: string
): Promise<GcResponse> {
	const { origin } = new URL(request.url);
	const purgeOrigin = origin === internalOrigin ? undefined : origin;

	return {
		ok: true,
		...(await services.garbageCollection.collectGarbage(cache, purgeOrigin))
	};
}
