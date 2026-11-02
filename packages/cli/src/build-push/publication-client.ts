import { parseTenantCacheUrl } from '@cupboard/nix-store/cache-url';
import type { CacheAccessMode } from '@cupboard/nix-store/scalars';
import { parseBaseUrl } from '@cupboard/nix-store/url';
import type { PublicationLookupSource } from '@cupboard/protocol/publication-manifests';
import type {
	PublicationWorkflowExecutionContext,
	PublicationWorkflowRequest
} from '@cupboard/protocol/publication-workflow';
import { reuseViewNameSchema } from '@cupboard/protocol/reuse-views';

import { authenticateForPush, type PushAuthOptions } from '../auth/auth.ts';
import type { CacheTarget } from '../cache-target.ts';
import { CupboardClient } from '../client/client.ts';
import { cacheAccessFetcher } from '../commands/github.ts';
import {
	publicationWorkflowAuthorizationDetails,
	publicationWorkflowFor
} from '../publication/publication-client.ts';

/**
Sources are tenant-local read selectors; callers filter URLs through tenantReferenceSources.
Capture always addresses the destination.
*/
export function publicationSourceForUrl(url: URL): PublicationLookupSource {
	url = parseBaseUrl(url);
	const marker = url.pathname.split('/').at(-2);
	if (marker === 'reuse') {
		return {
			selector: {
				view: reuseViewNameSchema.parse(
					decodeURIComponent(url.pathname.split('/').at(-1) ?? '')
				)
			}
		};
	}
	return { cache: parseTenantCacheUrl(url).cache };
}

interface BuildPublicationClientDependencies {
	readonly authenticate?: typeof authenticateForPush;
	readonly workflowFor?: typeof publicationWorkflowFor;
	readonly fetchAccess?: (url: URL) => Promise<CacheAccessMode>;
}

export function buildPublicationWorkflow(
	destination: CacheTarget,
	auth: PushAuthOptions,
	signal?: AbortSignal,
	dependencies: BuildPublicationClientDependencies = {}
) {
	destination = {
		tenantUrl: parseTenantCacheUrl(destination.tenantUrl).tenantUrl,
		cache: structuredClone(destination.cache)
	};
	const facades = new Map<
		string,
		Promise<ReturnType<typeof publicationWorkflowFor>>
	>();
	return {
		get destination() {
			return {
				tenantUrl: destination.tenantUrl.href,
				cache: structuredClone(destination.cache)
			};
		},
		async execute(
			request: PublicationWorkflowRequest,
			context?: PublicationWorkflowExecutionContext
		) {
			const authorizationDetails =
				await publicationWorkflowAuthorizationDetails(
					request,
					destination,
					dependencies.fetchAccess ?? cacheAccessFetcher({ signal })
				);
			const key = JSON.stringify(authorizationDetails);
			let facade = facades.get(key);
			if (facade === undefined) {
				facade = (async () => {
					const credential = await (
						dependencies.authenticate ?? authenticateForPush
					)(
						CupboardClient.fromUrl(destination.tenantUrl, {
							cache: destination.cache,
							signal
						}),
						{ ...auth, authorizationDetails }
					);
					return (dependencies.workflowFor ?? publicationWorkflowFor)(
						destination.tenantUrl,
						credential,
						{
							cache: destination.cache,
							signal
						}
					);
				})();
				facades.set(key, facade);
			}
			const workflow = await facade;
			return context === undefined
				? workflow.execute(request)
				: workflow.execute(request, context);
		}
	};
}
