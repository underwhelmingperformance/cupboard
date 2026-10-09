import { parseTenantCacheUrl } from '@cupboard/nix-store/cache-url';
import { InvalidTenantCacheUrlError } from '@cupboard/nix-store/errors';
import {
	type CacheAccessMode,
	type CacheScope,
	isSameCacheScope
} from '@cupboard/nix-store/scalars';
import { canonicalHref } from '@cupboard/nix-store/url';
import { reuseViewNameSchema } from '@cupboard/protocol/reuse-views';

import { type ContentReadGrantIntent } from '../auth/attenuate.ts';

interface ReferenceDestination {
	readonly tenantUrl: URL;
	readonly cache: CacheScope;
}

interface SourceResource {
	readonly tenantUrl: URL;
	readonly intent: ContentReadGrantIntent;
}

function reuseViewResource(source: URL): SourceResource | undefined {
	const segments = source.pathname.replace(/\/+$/u, '').split('/');

	if (segments.at(-2) !== 'reuse' || segments.at(-4) !== 't') {
		return undefined;
	}

	const view = reuseViewNameSchema.safeParse(
		decodeURIComponent(segments.at(-1) ?? '')
	);

	if (!view.success) {
		return undefined;
	}

	const tenantUrl = new URL(source);
	tenantUrl.pathname = segments.slice(0, -2).join('/');

	return { tenantUrl, intent: { view: view.data } };
}

function sourceResource(source: URL): SourceResource | undefined {
	const view = reuseViewResource(source);

	if (view !== undefined) {
		return view;
	}

	try {
		const { tenantUrl, cache } = parseTenantCacheUrl(source);

		return { tenantUrl, intent: { cache } };
	} catch (error) {
		if (error instanceof InvalidTenantCacheUrlError) {
			return undefined;
		}

		throw error;
	}
}

/**
 * Returns the content-read grant to request for a recognised private cache or
 * reuse view in the destination's tenant. The destination, a public, unrecognised or
 * other-tenant source returns an empty intent.
 */
async function referenceSourceReadIntent(
	source: URL,
	destination: ReferenceDestination,
	fetchAccess: (url: URL) => Promise<CacheAccessMode>
): Promise<ContentReadGrantIntent> {
	const resource = sourceResource(source);

	if (
		resource === undefined ||
		canonicalHref(resource.tenantUrl) !==
			canonicalHref(destination.tenantUrl) ||
		(resource.intent.cache !== undefined &&
			isSameCacheScope(resource.intent.cache, destination.cache))
	) {
		return {};
	}

	if ((await fetchAccess(source)) === 'public') {
		return {};
	}

	return resource.intent;
}

/**
 * The read grants that a push requests for its private reference sources, and
 * those sources.
 */
export interface ReferenceSourceReads {
	readonly intents: readonly ContentReadGrantIntent[];
	readonly sources: readonly URL[];
}

/**
 * Returns the read grants for a set of reference sources. Each distinct source
 * is probed once, and sources that need no grant are left out.
 */
export async function referenceSourceReadIntents(
	sources: readonly URL[],
	destination: ReferenceDestination,
	fetchAccess: (url: URL) => Promise<CacheAccessMode>
): Promise<ReferenceSourceReads> {
	const distinct = new Map(
		sources.map((source) => [canonicalHref(source), source])
	);
	const intents: ContentReadGrantIntent[] = [];
	const readSources: URL[] = [];

	for (const source of distinct.values()) {
		const intent = await referenceSourceReadIntent(
			source,
			destination,
			fetchAccess
		);

		if (intent.cache === undefined && intent.view === undefined) {
			continue;
		}

		intents.push(intent);
		readSources.push(source);
	}

	return { intents, sources: readSources };
}
