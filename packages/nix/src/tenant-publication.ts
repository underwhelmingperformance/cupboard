import type { StorePathString } from '@cupboard/nix-store/scalars';
import { canonicalHref, parseBaseUrl } from '@cupboard/nix-store/url';
import { retryingFetcher } from '@cupboard/shared/retry';
import {
	context,
	defaultTextMapSetter,
	type Span,
	SpanKind,
	SpanStatusCode,
	trace
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { StatusCodes } from 'http-status-codes';

import {
	CachedClosureReader,
	type CachedClosureSource,
	requireSourceUrl
} from './cache-metadata.ts';
import { withReadAuthentication } from './read-authentication.ts';
import { discoverNixStoreConfig } from './store-config.ts';

const serverErrorStatus: number = StatusCodes.INTERNAL_SERVER_ERROR;

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

function observeResponseBody(
	response: Response,
	finish: (error?: unknown) => void
): Response {
	if (response.body === null) {
		finish();
		return response;
	}
	const reader = response.body.getReader();
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const result = await reader.read();
				if (result.done) {
					controller.close();
					reader.releaseLock();
					finish();
					return;
				}
				const value: unknown = result.value;
				if (!(value instanceof Uint8Array)) {
					throw new TypeError('The metadata response body must contain bytes');
				}
				controller.enqueue(value);
			} catch (error) {
				controller.error(error);
				reader.releaseLock();
				finish(error);
			}
		},
		async cancel(reason) {
			try {
				await reader.cancel(reason);
			} finally {
				reader.releaseLock();
				finish();
			}
		}
	});
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers
	});
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
			context.active()
		);
	try {
		return await context.with(trace.setSpan(context.active(), span), () =>
			discoverDependencyReferences(paths, options, span)
		);
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
	const propagator = new W3CTraceContextPropagator();
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
		const observedFetch: typeof fetch = async (input, init) => {
			const headers = new Headers(
				init?.headers ?? (input instanceof Request ? input.headers : undefined)
			);
			const requestSpan = trace.getTracer('cupboard.nix').startSpan(
				'cache-metadata-request',
				{
					kind: SpanKind.CLIENT,
					attributes: {
						'server.address': source.url.hostname,
						'http.request.method': init?.method ?? 'GET'
					}
				},
				context.active()
			);
			if (shouldPropagate) {
				const carrier: Record<string, string> = {};
				propagator.inject(
					trace.setSpan(context.active(), requestSpan),
					carrier,
					defaultTextMapSetter
				);
				for (const [key, value] of Object.entries(carrier)) {
					headers.set(key, value);
				}
			}
			requests += 1;
			inFlight += 1;
			let isFinished = false;
			const finish = (error?: unknown): void => {
				if (isFinished) {
					return;
				}
				isFinished = true;
				if (error !== undefined) {
					if (error instanceof Error) {
						requestSpan.recordException(error);
					}
					requestSpan.setStatus({ code: SpanStatusCode.ERROR });
				}
				requestSpan.end();
				inFlight -= 1;
				report();
			};
			try {
				report();
				const response = await context.with(
					trace.setSpan(context.active(), requestSpan),
					() =>
						fetcher(input, {
							...init,
							headers,
							...(shouldPropagate && { redirect: 'error' })
						})
				);
				requestSpan.setAttribute('http.response.status_code', response.status);
				if (response.status >= serverErrorStatus) {
					requestSpan.setStatus({ code: SpanStatusCode.ERROR });
				}
				return observeResponseBody(response, finish);
			} catch (error) {
				finish(error);
				throw error;
			}
		};
		const reader = new CachedClosureReader(
			source,
			retryingFetcher(observedFetch, 'replay-safe'),
			options.signal,
			(progress) => {
				mode = progress.mode;
				checked += progress.checked;
				found += progress.found;
				report();
			}
		);
		report();
		const heartbeat =
			options.onProgress === undefined
				? undefined
				: setInterval(report, 10_000);
		let offers: Awaited<ReturnType<CachedClosureReader['offers']>>;
		try {
			offers = await reader.offers(pending);
		} finally {
			clearInterval(heartbeat);
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
			return { url, paths: [] };
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
