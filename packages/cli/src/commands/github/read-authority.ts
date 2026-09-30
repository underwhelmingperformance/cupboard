import { cacheUrl } from '@cupboard/nix-store/cache-url';
import {
	type CacheAccessMode,
	cacheNameSchema,
	cachePrioritySchema,
	type CacheScope
} from '@cupboard/nix-store/scalars';
import { type AuthorizationDetails } from '@cupboard/protocol/grants';
import { type ReadResourceState } from '@cupboard/protocol/read-access';
import { reuseViewNameSchema } from '@cupboard/protocol/reuse-views';

import { contentReadAuthorizationDetails } from '../../auth/attenuate.ts';

import { type GithubCheckClient } from './check.ts';
import { pullRequestCacheName, pullRequestViewName } from './convention.ts';
import {
	type DiscoveredPublishingJob,
	type ReadCredentialWiring
} from './discovery.ts';
import { isPresetJob, jobCache, type PublicationCase } from './publication.ts';

export interface PublicationReadAuthority {
	readonly cache: CacheScope;
	readonly requests: readonly AuthorizationDetails[];
	readonly resources: readonly ReadResourceState[];
	readonly cacheAccess: CacheAccessMode;
	readonly viewAccess?: CacheAccessMode;
	readonly selectedViewAccess?: CacheAccessMode;
	readonly cacheWiring: ReadCredentialWiring;
	readonly viewWiring: ReadCredentialWiring;
}

export async function publicationReadAuthority(
	job: DiscoveredPublishingJob,
	publication: PublicationCase,
	tenant: URL,
	repositoryId: number,
	client: GithubCheckClient,
	fetchCacheAccess: (url: URL) => Promise<CacheAccessMode>
): Promise<PublicationReadAuthority> {
	const selectedCache = jobCache(job);

	if (selectedCache.outcome === 'unresolved') {
		throw new Error(selectedCache.reason);
	}

	const isPreset = isPresetJob(job);
	const cacheMode = job.inputs['cache-access-mode'];
	const isPullRequest =
		isPreset &&
		publication.trigger === 'pull_request' &&
		job.inputs.push !== false;
	const cache: CacheScope = isPullRequest
		? {
				kind: 'named',
				name: cacheNameSchema.parse(pullRequestCacheName(repositoryId, 1))
			}
		: selectedCache.scope;
	const selectedViewAccess =
		isPreset &&
		job.inputs.push !== false &&
		(cacheMode === 'public' || cacheMode === 'private')
			? cacheMode
			: isPreset
				? await fetchCacheAccess(tenant)
				: undefined;
	const cacheAccess = isPullRequest
		? (selectedViewAccess ?? (await fetchCacheAccess(tenant)))
		: await fetchCacheAccess(cacheUrl(tenant, cache));
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

	const isCacheContent = cacheAccess === 'private' && cacheWiring === 'none';
	const isViewContent =
		view !== undefined && viewAccess === 'private' && viewWiring === 'none';
	const isNeedsOidc = isPullRequest || isCacheContent || isViewContent;
	const resources: ReadResourceState[] = isNeedsOidc
		? [
				...(cacheWiring === 'none'
					? [
							{
								type: 'cupboard_cache' as const,
								cache,
								mode: 'content' as const,
								state:
									isPullRequest && cacheAccess === 'public'
										? { kind: 'absent' as const }
										: {
												kind: 'existing' as const,
												access: cacheAccess,
												priority: cachePrioritySchema.parse(40)
											}
							}
						]
					: []),
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
	const grants = contentReadAuthorizationDetails({
		...(isCacheContent && { cache }),
		...(isViewContent && { view: reuseViewNameSchema.parse(view.name) })
	});

	return {
		cache,
		resources,
		cacheAccess,
		...(viewAccess !== undefined && { viewAccess }),
		...(selectedViewAccess !== undefined && { selectedViewAccess }),
		cacheWiring,
		viewWiring,
		requests: grants.length > 0 ? [grants] : []
	};
}
