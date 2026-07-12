import { type Logger } from '@cupboard/logger';
import { cacheFromSelector } from '@cupboard/nix-store/scalars';
import { tenantContract } from '@cupboard/protocol/contract';
import { type VerifyReport } from '@cupboard/protocol/reports';
import { type GcResponse } from '@cupboard/protocol/retention';
import { implement } from '@orpc/server';

import { internalOrigin, verificationBatchSize } from '../http/http.ts';

import { authoriseRequest } from './authorise.ts';
import { type TenantOrpcContext, type TenantRpcServices } from './context.ts';
import { bridgedError } from './error-bridge.ts';

// The implementer carries the cross-cutting middleware every procedure runs:
// the error bridge, authentication against the scope the contract's meta
// declares (an admin token satisfies every scope), and the post-mutation
// maintenance hook for procedures whose meta marks them mutating. The contract
// supplies the scope and maintenance declarations, so nothing is repeated per
// procedure here.
const os = implement(tenantContract)
	.$context<TenantOrpcContext>()
	.use(async ({ context, next }) => {
		try {
			return await next();
		} catch (error) {
			throw bridgedError(context.logger, error);
		}
	})
	.use(async ({ context, procedure, next }, input) => {
		const claims = await context.services.authenticate(context.request);

		await authoriseRequest(
			claims,
			procedure['~orpc'].meta,
			input,
			context.services.pendingCache
		);

		return next({ context: { claims } });
	})
	.use(({ context, procedure, next }) =>
		procedure['~orpc'].meta.maintenance === true
			? context.services.afterMutation(async () => next())
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
		remove: os.caches.remove.handler(({ input, context }) => {
			const requestUrl = new URL(context.request.url);
			return context.services.cacheAdmin.removeCache(
				input.params.cacheName,
				input.query.force,
				requestUrl.origin
			);
		})
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
		get: os.oidcTrust.get.handler(({ input, context }) =>
			context.services.oidcTrust.getRule(input.id)
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
				cacheFromSelector(input.cacheName),
				input.name,
				{ targets: input.targets, ttlSeconds: input.ttlSeconds }
			)
		),
		ensure: os.roots.ensure.handler(({ input, context }) =>
			context.services.roots.ensureRoot(
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
		remove: os.paths.remove.handler(({ input, context }) => {
			const requestUrl = new URL(context.request.url);
			return context.services.deletionQueue.deleteStorePath(
				cacheFromSelector(input.cacheName),
				input.hash,
				requestUrl.origin
			);
		})
	},
	gc: {
		runAll: os.gc.runAll.handler(({ context }) =>
			collectGarbage(context.logger, context.request, context.services)
		),
		runCache: os.gc.runCache.handler(({ input, context }) =>
			collectGarbage(
				context.logger,
				context.request,
				context.services,
				cacheFromSelector(input.cacheName)
			)
		)
	},
	verify: {
		run: os.verify.run.handler(({ input, context }) =>
			runVerify(context.logger, context.request, context.services, input.limit)
		)
	},
	uploads: {
		credential: os.uploads.credential.handler(({ input, context }) =>
			context.services.uploads.issuePushCredential(
				context.claims.expiresAt,
				input.pushId
			)
		),
		negotiate: os.uploads.negotiate.handler(({ input, context }) => {
			const requestUrl = new URL(context.request.url);
			return context.services.uploads.negotiate(
				cacheFromSelector(input.cacheName),
				{ pushId: input.pushId, paths: input.paths },
				requestUrl.origin,
				context.services.takeNegotiateHints(context.request)
			);
		}),
		status: os.uploads.status.handler(({ input, context }) =>
			context.services.uploads.uploadStatus(input.id)
		)
	},
	attestations: {
		negotiate: os.attestations.negotiate.handler(({ input, context }) =>
			context.services.attestations.negotiate(
				cacheFromSelector(input.cacheName),
				{ pushId: input.pushId, bundles: input.bundles }
			)
		),
		attach: os.attestations.attach.handler(({ input, context }) =>
			context.services.attestations.attach(
				cacheFromSelector(input.cacheName),
				input.id
			)
		)
	}
});

// Interactive GC purges this colo's edge cache via the caller's public
// origin. The cron sweep arrives on the internal origin and cannot know the
// public URL, so it skips purging and relies on the narinfo TTL and the
// orphan-blob grace window instead.
async function collectGarbage(
	logger: Logger,
	request: Request,
	services: TenantRpcServices,
	cache?: string
): Promise<GcResponse> {
	const { origin } = new URL(request.url);
	const purgeOrigin = origin === internalOrigin ? undefined : origin;

	return {
		ok: true,
		...(await services.runGarbageCollection(logger, cache, purgeOrigin))
	};
}

// One interactive verification pass. Like `collectGarbage`, an interactive run
// purges this colo's edge cache via the caller's public origin while the cron's
// internal origin skips it. The requested limit is clamped to the server's
// batch ceiling.
async function runVerify(
	logger: Logger,
	request: Request,
	services: TenantRpcServices,
	limit: number | undefined
): Promise<VerifyReport> {
	const { origin } = new URL(request.url);
	const purgeOrigin = origin === internalOrigin ? undefined : origin;
	const batch = Math.min(limit ?? verificationBatchSize, verificationBatchSize);

	return services.runVerification(logger, purgeOrigin, batch);
}
