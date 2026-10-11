import type { StorePathString } from '@cupboard/nix-store/scalars';
import { canonicalHref, parseBaseUrl } from '@cupboard/nix-store/url';
import {
	ROOT_CONTEXT,
	type Span,
	SpanStatusCode,
	trace
} from '@opentelemetry/api';

import {
	CachedClosureReader,
	type CachedClosureSource,
	requireSourceUrl
} from './cache-metadata.ts';
import {
	MetadataDiagnostics,
	type TenantDependencyDiagnostic
} from './metadata-diagnostics.ts';
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
	readonly tenantUrl?: URL;
	readonly onProgress?: (progress: TenantDependencyProgress) => void;
	readonly onDiagnostic?: (diagnostic: TenantDependencyDiagnostic) => void;
	readonly onDiagnosticError?: (error: unknown) => void;
}

/**
Progress for the current cache during dependency metadata discovery.
*/
export interface TenantDependencyProgress {
	readonly traceId: string;
	readonly source: string;
	readonly mode: 'discovering' | 'bulk' | 'legacy';
	readonly checked: number;
	readonly total: number;
	readonly found: number;
	readonly requests: number;
	readonly inFlight: number;
	readonly elapsedMs: number;
}

function isTenantSource(source: URL, tenant: URL): boolean {
	if (source.origin !== tenant.origin) {
		return false;
	}
	const sourcePath = parseBaseUrl(source).pathname;
	const tenantPath = parseBaseUrl(tenant).pathname;
	return (
		sourcePath === tenantPath ||
		(sourcePath.startsWith(`${tenantPath}/`) &&
			/^\/(?:cache|reuse)\/[^/]+$/u.test(sourcePath.slice(tenantPath.length)))
	);
}

export async function tenantDependencyReferences(
	paths: readonly StorePathString[],
	options: TenantDependencyReferenceOptions
): Promise<TenantDependencyReference[]> {
	const span = trace
		.getTracer('cupboard.nix')
		.startSpan(
			'tenant-dependency-references',
			{ attributes: { 'cupboard.paths.requested': new Set(paths).size } },
			ROOT_CONTEXT
		);
	try {
		return await discoverDependencyReferences(paths, options, span);
	} catch (error) {
		if (error instanceof Error) {
			span.recordException(error);
		}
		span.setStatus({ code: SpanStatusCode.ERROR });
		throw error;
	} finally {
		span.end();
	}
}

async function discoverDependencyReferences(
	paths: readonly StorePathString[],
	options: TenantDependencyReferenceOptions,
	span: Span
): Promise<TenantDependencyReference[]> {
	const references: TenantDependencyReference[] = [];
	const traceId = span.spanContext().traceId;
	const parent = trace.setSpan(ROOT_CONTEXT, span);
	let pending = [...new Set(paths)];
	for (const source of options.sources) {
		if (pending.length === 0) {
			break;
		}
		options.signal?.throwIfAborted();
		requireSourceUrl(source.url);
		const startedAt = Date.now();
		let checked = 0;
		let found = 0;
		let requests = 0;
		let inFlight = 0;
		let mode: TenantDependencyProgress['mode'] = 'discovering';
		const report = (): void =>
			options.onProgress?.({
				traceId,
				source: canonicalHref(source.url),
				mode,
				checked,
				total: pending.length,
				found,
				requests,
				inFlight,
				elapsedMs: Date.now() - startedAt
			});
		const fetcher = withReadAuthentication(options.fetch ?? fetch, {
			tenantUrl: source.url
		});
		const shouldPropagate =
			options.tenantUrl !== undefined &&
			isTenantSource(source.url, options.tenantUrl);
		const diagnostics = new MetadataDiagnostics({
			source: canonicalHref(source.url),
			parent,
			propagate: shouldPropagate,
			fetcher,
			onChange(inFlightDelta, requestDelta) {
				inFlight += inFlightDelta;
				requests += requestDelta;
				report();
			},
			...(options.onDiagnostic !== undefined && {
				onDiagnostic: options.onDiagnostic
			}),
			...(options.onDiagnosticError !== undefined && {
				onDiagnosticError: options.onDiagnosticError
			})
		});
		const reader = new CachedClosureReader(
			source,
			fetcher,
			options.signal,
			(progress) => {
				mode = progress.mode;
				checked += progress.checked;
				found += progress.found;
				report();
			},
			diagnostics
		);
		report();
		const heartbeat =
			options.onProgress === undefined
				? undefined
				: setInterval(report, 10_000);
		let offers: Awaited<ReturnType<CachedClosureReader['offers']>>;
		let status: 'complete' | 'error' = 'error';
		try {
			offers = await reader.offers(pending);
			status = 'complete';
		} finally {
			clearInterval(heartbeat);
			diagnostics.emit({
				version: 1,
				kind: 'source',
				traceId,
				source: canonicalHref(source.url),
				mode,
				status,
				checked,
				total: pending.length,
				found,
				missing: checked - found,
				remaining: pending.length - checked,
				requests,
				inFlight,
				elapsedMs: Date.now() - startedAt,
				droppedRecords: diagnostics.droppedRecords
			});
		}

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
