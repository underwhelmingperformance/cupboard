import { cacheUrl } from '@cupboard/nix-store/cache-url';
import {
	type CacheAccessMode,
	cacheNameSchema,
	cachePrioritySchema,
	type CacheScope,
	isSameCacheScope
} from '@cupboard/nix-store/scalars';
import { type AuthorizationDetails } from '@cupboard/protocol/grants';
import { type ReadResourceState } from '@cupboard/protocol/read-access';
import { reuseViewNameSchema } from '@cupboard/protocol/reuse-views';

import { contentReadAuthorizationDetails } from '../../auth/attenuate.ts';

import { type GithubCheckClient } from './check.ts';
import {
	pullRequestCacheName,
	pullRequestCachePrefix,
	pullRequestViewName
} from './convention.ts';
import {
	type DiscoveredPublishingJob,
	type ReadCredentialWiring
} from './discovery.ts';
import {
	isPresetJob,
	isReadOnlyJob,
	jobCache,
	type PublicationCase
} from './publication.ts';

export interface PublicationReadAuthority {
	readonly cache: CacheScope;
	readonly requests: readonly AuthorizationDetails[];
	readonly resources: readonly ReadResourceState[];
	readonly cacheAccess?: CacheAccessMode;
	readonly trustedContributorRepositoryId?: number;
	readonly additionalCaches: readonly {
		readonly cache: CacheScope;
		readonly access: CacheAccessMode;
	}[];
	readonly viewAccess?: CacheAccessMode;
	readonly selectedViewAccess?: CacheAccessMode;
	readonly cacheWiring: ReadCredentialWiring;
	readonly viewWiring: ReadCredentialWiring;
	readonly referenceWiring?: ReadCredentialWiring;
	readonly referenceAccess?: CacheAccessMode;
}

export async function publicationReadAuthority(
	job: DiscoveredPublishingJob,
	publication: PublicationCase,
	tenant: URL,
	repositoryId: number,
	client: GithubCheckClient,
	fetchCacheAccess: (url: URL) => Promise<CacheAccessMode>
): Promise<PublicationReadAuthority> {
	const selectedCache =
		publication.cache === undefined
			? jobCache(job)
			: { outcome: 'resolved' as const, scope: publication.cache };

	if (selectedCache.outcome === 'unresolved') {
		throw new Error(selectedCache.reason);
	}

	const isPreset = isPresetJob(job);
	const isReadOnly = isReadOnlyJob(job);
	const cacheMode = job.inputs['cache-access-mode'];
	const isPresetPullRequest =
		isPreset && publication.trigger === 'pull_request' && !isReadOnly;
	const isManagedPullRequest =
		publication.pullRequestTemplates !== undefined &&
		publication.trigger === 'pull_request' &&
		job.inputs['manage-pr-cache'] === true &&
		!isReadOnly;
	const cache: CacheScope = isPresetPullRequest
		? {
				kind: 'named',
				name: cacheNameSchema.parse(pullRequestCacheName(repositoryId, 1))
			}
		: selectedCache.scope;
	if (publication.lifecycle !== undefined) {
		return {
			cache,
			requests: [],
			resources: [],
			additionalCaches: [],
			cacheWiring: 'none',
			viewWiring: 'none'
		};
	}

	const isRepositoryView =
		publication.reuseView?.name === pullRequestViewName(repositoryId);
	const selectedViewAccess =
		!isReadOnly &&
		(isPreset || isRepositoryView) &&
		(cacheMode === 'public' || cacheMode === 'private')
			? cacheMode
			: isPreset || isRepositoryView
				? await fetchCacheAccess(tenant)
				: undefined;
	let cacheAccess: CacheAccessMode;
	if (isPresetPullRequest) {
		cacheAccess = selectedViewAccess ?? (await fetchCacheAccess(tenant));
	} else if (isManagedPullRequest && cache.kind === 'named') {
		const [prefix = '', suffix = ''] =
			publication.pullRequestTemplates.cache.split('{pr}', 2);
		const hasPrivateFamilyCache = await hasPrivateCacheInFamily(client, {
			prefix,
			matches: (name) =>
				name.startsWith(prefix) &&
				name.endsWith(suffix) &&
				/^[0-9]+$/u.test(name.slice(prefix.length, name.length - suffix.length))
		});
		const defaultAccess = await fetchCacheAccess(tenant);
		cacheAccess = hasPrivateFamilyCache ? 'private' : defaultAccess;
	} else {
		cacheAccess = await fetchCacheAccess(cacheUrl(tenant, cache));
	}
	const view = publication.reuseView;
	const cacheWiring = job.readCredentialWiring?.cache ?? 'none';
	const viewWiring = job.readCredentialWiring?.view ?? 'none';
	let viewAccess: CacheAccessMode | undefined;
	let viewPriority = cachePrioritySchema.parse(50);

	if (view !== undefined) {
		const listed = await client.reuseViews.list();
		const selected = listed.views.find(
			(candidate) => candidate.name === view.name
		);
		viewAccess = selected?.access;
		viewPriority = cachePrioritySchema.parse(
			selected?.priority ?? viewPriority
		);
		if (
			viewAccess === undefined &&
			isPreset &&
			view.name === pullRequestViewName(repositoryId)
		) {
			viewAccess = selectedViewAccess;
		}
	}

	const trustedReferenceAccess =
		publication.trustedContributorReuse === true
			? await trustedPullRequestCacheAccess(
					client,
					repositoryId,
					selectedViewAccess ?? (await fetchCacheAccess(tenant))
				)
			: undefined;

	const additionalCaches = await Promise.all(
		(publication.readCaches ?? []).map(async (cache) => ({
			cache,
			access:
				publication.trustedContributorReuse === true &&
				cache.kind === 'named' &&
				cache.name === pullRequestCacheName(repositoryId, 1)
					? (trustedReferenceAccess ?? (await fetchCacheAccess(tenant)))
					: await fetchCacheAccess(cacheUrl(tenant, cache))
		}))
	);
	const automaticReference: CacheScope | undefined = isPresetPullRequest
		? { kind: 'default' }
		: publication.trustedContributorReuse === true
			? {
					kind: 'named',
					name: cacheNameSchema.parse(pullRequestCacheName(repositoryId, 1))
				}
			: undefined;
	const referenceAccess =
		automaticReference === undefined
			? undefined
			: additionalCaches.find(({ cache }) =>
					isSameCacheScope(cache, automaticReference)
				)?.access;
	const oidcAdditionalCaches = additionalCaches.filter(
		({ cache }) =>
			viewWiring !== 'configured' ||
			automaticReference === undefined ||
			!isSameCacheScope(cache, automaticReference)
	);

	const isAdditionalContent = oidcAdditionalCaches.some(
		({ access }) => access === 'private'
	);
	const isCacheContent = cacheAccess === 'private' && cacheWiring === 'none';
	const isViewContent =
		view !== undefined && viewAccess === 'private' && viewWiring === 'none';
	const isNeedsOidc =
		isPresetPullRequest ||
		isCacheContent ||
		isViewContent ||
		isAdditionalContent;
	const resources: ReadResourceState[] = isNeedsOidc
		? [
				...(cacheWiring === 'none'
					? [
							{
								type: 'cupboard_cache' as const,
								cache,
								mode: 'content' as const,
								state:
									isPresetPullRequest && cacheAccess === 'public'
										? { kind: 'absent' as const }
										: {
												kind: 'existing' as const,
												access: cacheAccess,
												priority: cachePrioritySchema.parse(40)
											}
							}
						]
					: []),
				...oidcAdditionalCaches.map(({ cache, access }) => ({
					type: 'cupboard_cache' as const,
					cache,
					mode: 'content' as const,
					state: {
						kind: 'existing' as const,
						access,
						priority: cachePrioritySchema.parse(40)
					}
				})),
				...(view !== undefined &&
				viewAccess !== undefined &&
				viewWiring === 'none'
					? [
							{
								type: 'cupboard_view' as const,
								view: reuseViewNameSchema.parse(view.name),
								state: {
									kind: 'existing' as const,
									access: viewAccess,
									priority: viewPriority
								}
							}
						]
					: [])
			]
		: [];
	const grants = [
		...contentReadAuthorizationDetails({
			...(isCacheContent && { cache }),
			...(isViewContent && { view: reuseViewNameSchema.parse(view.name) })
		}),
		...oidcAdditionalCaches
			.filter(({ access }) => access === 'private')
			.flatMap(({ cache }) => contentReadAuthorizationDetails({ cache }))
	];

	const referencePush = privateViewReferencePush(
		publication,
		view?.name,
		viewAccess
	);

	const cacheReferencePush = privateCacheReferencePush(
		publication,
		automaticReference,
		referenceAccess
	);

	return {
		cache,
		...(publication.trustedContributorReuse === true && {
			trustedContributorRepositoryId: repositoryId
		}),
		additionalCaches,
		resources,
		cacheAccess,
		...(viewAccess !== undefined && { viewAccess }),
		...(selectedViewAccess !== undefined && { selectedViewAccess }),
		cacheWiring,
		viewWiring,
		...(automaticReference !== undefined &&
			viewWiring !== 'none' && {
				referenceAccess,
				referenceWiring: viewWiring
			}),
		requests: [
			...(grants.length > 0 ? [grants] : []),
			...(referencePush === undefined ? [] : [referencePush]),
			...(cacheReferencePush === undefined ? [] : [cacheReferencePush])
		]
	};
}

/**
 * The token request of a push that publishes by reference from a private
 * reuse view. The destination reuses a stored NAR only for a token that can
 * read it, so the push requests `view:content-read` beside its push grants,
 * whatever credential the run uses to read the view.
 */
function privateViewReferencePush(
	publication: PublicationCase,
	view: string | undefined,
	viewAccess: CacheAccessMode | undefined
): AuthorizationDetails | undefined {
	if (view === undefined || viewAccess !== 'private') {
		return;
	}

	const push = publication.requests.find((request) =>
		request.some(
			(detail) =>
				detail.type === 'cupboard_cache' &&
				detail.actions.includes('upload:commit')
		)
	);

	if (push === undefined) {
		return;
	}

	return [
		...push,
		...contentReadAuthorizationDetails({
			view: reuseViewNameSchema.parse(view)
		})
	];
}

function privateCacheReferencePush(
	publication: PublicationCase,
	cache: CacheScope | undefined,
	access: CacheAccessMode | undefined
): AuthorizationDetails | undefined {
	if (cache === undefined || access !== 'private') {
		return;
	}

	const push = publication.requests.find((request) =>
		request.some(
			(detail) =>
				detail.type === 'cupboard_cache' &&
				detail.actions.includes('upload:commit')
		)
	);

	if (push === undefined) {
		return;
	}

	return [...push, ...contentReadAuthorizationDetails({ cache })];
}

interface CacheFamily {
	readonly prefix: string;
	readonly matches: (name: string) => boolean;
}

async function hasPrivateCacheInFamily(
	client: GithubCheckClient,
	family: CacheFamily
): Promise<boolean> {
	let cursor: string | undefined;

	do {
		const page = await client.caches.list({
			namePrefix: family.prefix,
			cursor
		});
		if (
			page.caches.some(
				(candidate) =>
					candidate.scope.kind === 'named' &&
					candidate.access === 'private' &&
					family.matches(candidate.scope.name)
			)
		) {
			return true;
		}

		cursor = page.cursor;
	} while (cursor !== undefined);

	return false;
}

async function trustedPullRequestCacheAccess(
	client: GithubCheckClient,
	repositoryId: number,
	inheritedAccess: CacheAccessMode
): Promise<CacheAccessMode> {
	const prefix = pullRequestCachePrefix(repositoryId);
	const hasPrivateFamilyCache = await hasPrivateCacheInFamily(client, {
		prefix,
		matches: (name) =>
			name.startsWith(prefix) &&
			/^[1-9][0-9]*$/u.test(name.slice(prefix.length))
	});

	return hasPrivateFamilyCache ? 'private' : inheritedAccess;
}
