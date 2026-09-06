import { type Logger } from '@cupboard/logger';
import { type RootName, type StorePathHash } from '@cupboard/nix-store/scalars';
import { tenantContract } from '@cupboard/protocol/contract';
import { type VerifyReportInput } from '@cupboard/protocol/reports';
import { type GcResponseInput } from '@cupboard/protocol/retention';
import {
	uploadGraceFactsCapability,
	type UploadNegotiateRequest,
	type UploadPreviewRequest
} from '@cupboard/protocol/upload';
import { implement } from '@orpc/server';

import { type AccessClaims } from '../auth/auth.ts';
import { hasAcceptedCapability } from '../http/capabilities.ts';
import {
	internalOrigin,
	requestOriginSchema,
	verificationBatchSize
} from '../http/http.ts';

import { authoriseAttachRoot, authoriseRequest } from './authorise.ts';
import { type TenantOrpcContext, type TenantRpcServices } from './context.ts';
import { bridgedError } from './error-bridge.ts';

// Apply the contract's scope and maintenance metadata centrally. Every
// procedure uses the same error bridge and authentication rules, while admin
// tokens satisfy every tenant scope.
const os = implement(tenantContract)
	.$context<TenantOrpcContext>()
	.use(async ({ context, next }) => {
		try {
			return await next();
		} catch (error) {
			throw bridgedError(context.logger, error, context.resHeaders);
		}
	})
	.use(async ({ context, procedure, next }, input) => {
		const claims = await context.services.authenticate(context.request);

		await authoriseRequest(
			claims,
			procedure['~orpc'].meta,
			input,
			context.cache,
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
		get: {
			inDefaultCache: os.caches.get.inDefaultCache.handler(({ context }) =>
				context.services.cacheAdmin.getCache(context.cache)
			),
			inNamedCache: os.caches.get.inNamedCache.handler(({ input, context }) =>
				context.services.cacheAdmin.getCache({
					kind: 'named',
					name: input.cacheName
				})
			)
		},
		put: {
			inDefaultCache: os.caches.put.inDefaultCache.handler(
				({ input, context }) =>
					context.services.cacheAdmin.createCache({ kind: 'default' }, input)
			),
			inNamedCache: os.caches.put.inNamedCache.handler(({ input, context }) => {
				const { cacheName, ...configuration } = input;

				return context.services.cacheAdmin.createCache(
					{ kind: 'named', name: cacheName },
					configuration
				);
			})
		},
		update: {
			inDefaultCache: os.caches.update.inDefaultCache.handler(
				({ input, context }) =>
					context.services.cacheAdmin.updateCache({ kind: 'default' }, input)
			),
			inNamedCache: os.caches.update.inNamedCache.handler(
				({ input, context }) => {
					const { cacheName, ...update } = input;

					return context.services.cacheAdmin.updateCache(
						{ kind: 'named', name: cacheName },
						update
					);
				}
			)
		},
		remove: os.caches.remove.handler(({ input, context }) => {
			const origin = requestOriginSchema.parse(
				new URL(context.request.url).origin
			);
			return context.services.cacheAdmin.removeCache(
				input.params.cacheName,
				input.query.force,
				origin
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
			),
			abort: os.keys.signing.abort.handler(({ input, context }) =>
				context.services.signingKeys.abortKeyRotation(input.id)
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
	reuseViews: {
		list: os.reuseViews.list.handler(({ context }) =>
			context.services.reuseViews.listViews()
		),
		set: os.reuseViews.set.handler(({ input, context }) =>
			context.services.reuseViews.setView(input.name, {
				access: input.access,
				selectors: input.selectors,
				...(input.priority !== undefined && { priority: input.priority })
			})
		),
		remove: os.reuseViews.remove.handler(({ input, context }) =>
			context.services.reuseViews.removeView(input.name)
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
		cache: {
			inDefaultCache: os.stats.cache.inDefaultCache.handler(({ context }) =>
				context.services.stats.stats(context.cache)
			),
			inNamedCache: os.stats.cache.inNamedCache.handler(({ context }) =>
				context.services.stats.stats(context.cache)
			)
		},
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
		list: {
			inDefaultCache: os.roots.list.inDefaultCache.handler(
				({ input, context }) => listRoots(context, input)
			),
			inNamedCache: os.roots.list.inNamedCache.handler(({ input, context }) =>
				listRoots(context, input)
			)
		},
		targets: {
			inDefaultCache: os.roots.targets.inDefaultCache.handler(
				({ input, context }) => rootTargets(context, input.name, input)
			),
			inNamedCache: os.roots.targets.inNamedCache.handler(
				({ input, context }) => rootTargets(context, input.name, input)
			)
		},
		set: {
			inDefaultCache: os.roots.set.inDefaultCache.handler(
				({ input, context }) =>
					context.services.roots.setRoot(context.cache, input.name, {
						targets: input.targets,
						ttlSeconds: input.ttlSeconds
					})
			),
			inNamedCache: os.roots.set.inNamedCache.handler(({ input, context }) =>
				context.services.roots.setRoot(context.cache, input.name, {
					targets: input.targets,
					ttlSeconds: input.ttlSeconds
				})
			)
		},
		ensure: {
			inDefaultCache: os.roots.ensure.inDefaultCache.handler(
				({ input, context }) =>
					context.services.roots.ensureRoot(context.cache, input.name, {
						targets: input.targets,
						ttlSeconds: input.ttlSeconds
					})
			),
			inNamedCache: os.roots.ensure.inNamedCache.handler(({ input, context }) =>
				context.services.roots.ensureRoot(context.cache, input.name, {
					targets: input.targets,
					ttlSeconds: input.ttlSeconds
				})
			)
		},
		remove: {
			inDefaultCache: os.roots.remove.inDefaultCache.handler(
				({ input, context }) =>
					context.services.roots.removeRoot(context.cache, input.name)
			),
			inNamedCache: os.roots.remove.inNamedCache.handler(({ input, context }) =>
				context.services.roots.removeRoot(context.cache, input.name)
			)
		}
	},
	paths: {
		remove: {
			inDefaultCache: os.paths.remove.inDefaultCache.handler(
				({ input, context }) => removeStorePath(context, input.hash)
			),
			inNamedCache: os.paths.remove.inNamedCache.handler(({ input, context }) =>
				removeStorePath(context, input.hash)
			)
		}
	},
	gc: {
		runAll: os.gc.runAll.handler(({ context }) =>
			collectGarbage(context.logger, context.request, context.services, {
				scope: 'tenant'
			})
		),
		runCache: os.gc.runCache.handler(({ context }) =>
			collectGarbageForCache(context)
		)
	},
	verify: {
		run: os.verify.run.handler(({ input, context }) =>
			runVerify(context.logger, context.request, context.services, input.limit)
		)
	},
	uploads: {
		credential: {
			inDefaultCache: os.uploads.credential.inDefaultCache.handler(
				({ input, context }) =>
					context.services.uploads.issuePushCredential(
						context.claims.expiresAt,
						input.pushId
					)
			),
			inNamedCache: os.uploads.credential.inNamedCache.handler(
				({ input, context }) =>
					context.services.uploads.issuePushCredential(
						context.claims.expiresAt,
						input.pushId
					)
			)
		},
		negotiate: {
			inDefaultCache: os.uploads.negotiate.inDefaultCache.handler(
				({ input, context }) => negotiateUpload(context, input)
			),
			inNamedCache: os.uploads.negotiate.inNamedCache.handler(
				({ input, context }) => negotiateUpload(context, input)
			)
		},
		preview: {
			inDefaultCache: os.uploads.preview.inDefaultCache.handler(
				({ input, context }) => previewUpload(context, input.paths)
			),
			inNamedCache: os.uploads.preview.inNamedCache.handler(
				({ input, context }) => previewUpload(context, input.paths)
			)
		},
		confirm: {
			inDefaultCache: os.uploads.confirm.inDefaultCache.handler(
				({ input, context }) =>
					context.services.uploads.confirmPaths(
						context.cache,
						input.storePathHashes
					)
			),
			inNamedCache: os.uploads.confirm.inNamedCache.handler(
				({ input, context }) =>
					context.services.uploads.confirmPaths(
						context.cache,
						input.storePathHashes
					)
			)
		},
		status: os.uploads.status.handler(({ input, context }) =>
			context.services.uploads.uploadStatus(input.id)
		)
	},
	attestations: {
		negotiate: {
			inDefaultCache: os.attestations.negotiate.inDefaultCache.handler(
				({ input, context }) =>
					context.services.attestations.negotiate(context.cache, {
						pushId: input.pushId,
						bundles: input.bundles
					})
			),
			inNamedCache: os.attestations.negotiate.inNamedCache.handler(
				({ input, context }) =>
					context.services.attestations.negotiate(context.cache, {
						pushId: input.pushId,
						bundles: input.bundles
					})
			)
		},
		attach: {
			inDefaultCache: os.attestations.attach.inDefaultCache.handler(
				({ input, context }) =>
					context.services.attestations.attach(context.cache, input.id)
			),
			inNamedCache: os.attestations.attach.inNamedCache.handler(
				({ input, context }) =>
					context.services.attestations.attach(context.cache, input.id)
			)
		}
	}
});

interface ListPageQuery {
	readonly cursor?: string;
	readonly limit?: number;
}

function pageOptions(query: ListPageQuery): {
	cursor?: string;
	limit?: number;
} {
	return {
		...(query.cursor !== undefined && { cursor: query.cursor }),
		...(query.limit !== undefined && { limit: query.limit })
	};
}

function listRoots(context: TenantOrpcContext, query: ListPageQuery) {
	return context.services.roots.listRoots(context.cache, pageOptions(query));
}

function rootTargets(
	context: TenantOrpcContext,
	name: RootName,
	query: ListPageQuery
) {
	return context.services.roots.rootTargets(
		context.cache,
		name,
		pageOptions(query)
	);
}

function removeStorePath(context: TenantOrpcContext, hash: StorePathHash) {
	const origin = requestOriginSchema.parse(new URL(context.request.url).origin);

	return context.services.deletionQueue.deleteStorePath(
		context.cache,
		hash,
		origin
	);
}

function negotiateUpload(
	context: TenantOrpcContext & { readonly claims: AccessClaims },
	input: UploadNegotiateRequest
) {
	if (input.attachRoot !== undefined) {
		authoriseAttachRoot(context.claims, context.cache, input.attachRoot.name);
	}

	const origin = requestOriginSchema.parse(new URL(context.request.url).origin);

	return context.services.uploads.negotiate(
		context.cache,
		{
			pushId: input.pushId,
			paths: input.paths,
			...(input.attachRoot !== undefined && { attachRoot: input.attachRoot })
		},
		origin,
		context.services.takeNegotiateHints(context.request),
		hasAcceptedCapability(context.request, uploadGraceFactsCapability)
	);
}

function previewUpload(
	context: TenantOrpcContext,
	paths: UploadPreviewRequest['paths']
) {
	return context.services.uploads.preview(
		context.cache,
		{ paths },
		context.services.takeNegotiateHints(context.request),
		hasAcceptedCapability(context.request, uploadGraceFactsCapability)
	);
}

async function collectGarbageForCache(
	context: TenantOrpcContext
): Promise<GcResponseInput> {
	const cache = context.services.cacheAdmin.resolveCache(context.cache);

	if (cache === undefined) {
		return {
			ok: true,
			pendingUploadsDeleted: 0,
			pendingAttestationsDeleted: 0,
			rootsExpired: 0,
			pathsCollected: 0,
			narInfosDeleted: 0,
			orphanStagingDeleted: 0
		};
	}

	return collectGarbage(context.logger, context.request, context.services, {
		scope: 'cache',
		cache
	});
}

// Interactive GC purges this colo's edge cache via the caller's public
// origin. The cron pass arrives on the internal origin and cannot know the
// public URL, so it skips purging and relies on the narinfo TTL and the
// orphan-blob grace window instead.
async function collectGarbage(
	logger: Logger,
	request: Request,
	services: TenantRpcServices,
	target: Parameters<TenantRpcServices['runGarbageCollection']>[1]
): Promise<GcResponseInput> {
	const origin = requestOriginSchema.parse(new URL(request.url).origin);
	const purgeOrigin = origin === internalOrigin ? undefined : origin;
	const outcome = await services.runGarbageCollection(
		logger,
		target,
		purgeOrigin
	);

	return {
		ok: true,
		pendingUploadsDeleted: outcome.pendingUploadsDeleted,
		pendingAttestationsDeleted: outcome.pendingAttestationsDeleted,
		rootsExpired: outcome.rootsExpired,
		pathsCollected: outcome.pathsCollected,
		narInfosDeleted: outcome.narInfosDeleted,
		orphanStagingDeleted: outcome.orphanStagingDeleted
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
): Promise<VerifyReportInput> {
	const origin = requestOriginSchema.parse(new URL(request.url).origin);
	const purgeOrigin = origin === internalOrigin ? undefined : origin;
	const batch = Math.min(limit ?? verificationBatchSize, verificationBatchSize);

	return services.runVerification(logger, purgeOrigin, batch);
}
