import type { StorePathString } from '@cupboard/nix-store/scalars';
import { canonicalHref } from '@cupboard/nix-store/url';
import { retryingFetcher } from '@cupboard/shared/retry';

import {
	CachedClosureReader,
	type CachedClosureSource,
	requireSourceUrl
} from './cache-metadata.ts';
import { withReadAuthentication } from './read-authentication.ts';
import { discoverNixStoreConfig } from './store-config.ts';

export interface TenantDependencyReference {
	readonly storePath: StorePathString;
	readonly source: string;
	readonly narinfo: string;
	readonly kind: 'intermediate';
}

export interface TenantDependencyReferenceOptions {
	readonly sources: readonly CachedClosureSource[];
	readonly fetch?: typeof fetch;
	readonly signal?: AbortSignal;
}

export async function tenantDependencyReferences(
	paths: readonly StorePathString[],
	options: TenantDependencyReferenceOptions
): Promise<TenantDependencyReference[]> {
	const references: TenantDependencyReference[] = [];
	let pending = [...new Set(paths)];
	for (const source of options.sources) {
		if (pending.length === 0) {
			break;
		}
		options.signal?.throwIfAborted();
		requireSourceUrl(source.url);
		const reader = new CachedClosureReader(
			source,
			retryingFetcher(
				withReadAuthentication(options.fetch ?? fetch, {
					tenantUrl: source.url
				}),
				'replay-safe'
			),
			options.signal
		);
		const offers = await reader.offers(pending);
		const missing: StorePathString[] = [];
		for (const [index, path] of pending.entries()) {
			const offer = offers[index];
			if (offer === undefined) {
				missing.push(path);
				continue;
			}
			references.push({
				storePath: path,
				source: canonicalHref(source.url),
				narinfo: offer.narinfo,
				kind: 'intermediate'
			});
		}
		pending = missing;
	}
	return references;
}

/**
Tenant sources in destination-first order; external substituters are excluded.
*/
export function tenantReferenceSources(
	tenantUrl: URL,
	sources: readonly CachedClosureSource[],
	configured: readonly string[] = discoverNixStoreConfig().substitution
		.substituters
): readonly CachedClosureSource[] {
	const selected = new Map<string, CachedClosureSource>();
	const base = canonicalHref(tenantUrl);
	for (const source of [
		...sources,
		...configured.flatMap((value) => {
			const url = URL.parse(value);
			if (url === null) {
				return [];
			}
			url.search = '';
			return [{ url, paths: [] }];
		})
	]) {
		const url = canonicalHref(source.url);
		if (
			source.url.origin !== tenantUrl.origin ||
			!(
				url === base ||
				(url.startsWith(`${base}/`) &&
					/^\/(?:cache|reuse)\/[^/]+$/u.test(url.slice(base.length)))
			)
		) {
			continue;
		}
		if (!selected.has(url)) {
			selected.set(url, source);
		}
	}
	return selected.values().toArray();
}
