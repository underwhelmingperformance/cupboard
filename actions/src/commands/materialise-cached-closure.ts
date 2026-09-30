import {
	type NixDaemonSession,
	type NixValidPathInfo,
	withReadAuthentication
} from '@cupboard/nix';
import {
	type NarInfoOffer,
	offerFromNarInfo
} from '@cupboard/nix-store/narinfo-reader';
import { type StorePathString } from '@cupboard/nix-store/scalars';
import { byCodeUnit, StorePath } from '@cupboard/nix-store/store-path';
import { canonicalHref } from '@cupboard/nix-store/url';
import {
	cacheMetadataCapability,
	cacheMetadataCapabilityHeader,
	type CacheMetadataError,
	cacheMetadataErrorCodes,
	cacheMetadataErrorSchema,
	cacheMetadataMaxNarInfoBytes,
	cacheMetadataMaxPaths,
	cacheMetadataMaxRequestBytes,
	cacheMetadataMaxResponseBytes,
	cacheMetadataRequestSchema,
	type CacheMetadataResponse,
	cacheMetadataResponseSchema
} from '@cupboard/protocol/cache-metadata';
import { discardResponseBody } from '@cupboard/shared/cleanup';
import { chunk } from '@cupboard/shared/collections';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { basicAuthHeader, type BasicCredential } from '@cupboard/shared/http';
import {
	type BoundedResponseBodyOptions,
	readResponseBytes,
	readResponseText
} from '@cupboard/shared/response-body';
import { retryingFetcher } from '@cupboard/shared/retry';

import { fetchWithProbeDeadline } from '../cache-probe.ts';
import { copyNixPaths, type NixCopyOptions } from '../nix-copy.ts';

const narInfoConcurrency = 6;
const utf8 = new TextEncoder();

function sourceLabel(source: URL): string {
	const safe = new URL(source);
	safe.username = '';
	safe.password = '';
	safe.search = '';
	safe.hash = '';

	return canonicalHref(safe);
}

export interface CachedClosureSource {
	readonly url: URL;
	readonly paths: readonly StorePathString[];
	readonly credential?: BasicCredential;
}

export interface CachedClosureReference {
	readonly storePath: StorePathString;
	readonly narinfo: string;
}

interface CachedClosureOffer extends NarInfoOffer {
	readonly narinfo: string;
}

export type LocalStoreUri = 'daemon' | 'local';

export interface MaterialiseCachedClosureOptions {
	readonly sources: readonly CachedClosureSource[];
	readonly store: string;
	readonly localStore: LocalStoreUri;
	readonly nix: Pick<
		NixDaemonSession,
		'addTempRoot' | 'buildPathsWithResults' | 'resolveClosure'
	> &
		Partial<Pick<NixDaemonSession, 'queryValidPaths'>>;
	readonly localNix?: Pick<
		NixDaemonSession,
		'addTempRoot' | 'buildPathsWithResults'
	>;
	readonly signal?: AbortSignal;
	readonly fetch?: typeof fetch;
	readonly runCopy?: (
		options: NixCopyOptions,
		signal?: AbortSignal
	) => Promise<void>;
	readonly onReferenced: (
		source: URL,
		paths: readonly CachedClosureReference[]
	) => void;
}

export class CachedClosureSourceUnavailableError extends Error {
	constructor(
		storePath: StorePathString,
		source: URL,
		readonly status: number
	) {
		super(
			`The cache at ${sourceLabel(source)} returned HTTP ${String(status)} for ${storePath}`
		);
		this.name = 'CachedClosureSourceUnavailableError';
	}
}

interface MetadataRefusal {
	readonly status: number;
	readonly error?: CacheMetadataError;
}

function metadataRefusalReason(
	paths: readonly StorePathString[],
	error?: CacheMetadataError
): string {
	if (error?.code !== cacheMetadataErrorCodes.narInfoInvalid) {
		return `for the metadata page. Requested paths: ${paths.join(', ')}.`;
	}
	if (error.storePath !== undefined) {
		return `because the narinfo for ${error.storePath} is invalid. Ask the cache operator to inspect this path.`;
	}
	return `because a narinfo in the requested metadata page is invalid. Requested paths: ${paths.join(', ')}. Ask the cache operator to inspect these paths.`;
}

export class CachedClosureMetadataUnavailableError extends Error {
	constructor(
		source: URL,
		readonly storePaths: readonly StorePathString[],
		refusal: MetadataRefusal
	) {
		super(
			`The cache at ${sourceLabel(source)} returned HTTP ${String(refusal.status)} ${metadataRefusalReason(storePaths, refusal.error)}`
		);
		this.name = 'CachedClosureMetadataUnavailableError';
	}
}

export class CachedClosureSourceInvalidError extends Error {
	constructor(source: URL, reason: string) {
		super(`Cannot read cache at ${sourceLabel(source)}: ${reason}`);
		this.name = 'CachedClosureSourceInvalidError';
	}
}

export class CachedClosureSourceChangedError extends Error {
	constructor(source: URL) {
		super(
			`The cache at ${sourceLabel(source)} changed during runtime closure discovery. Refresh cache availability before retrying.`
		);
		this.name = 'CachedClosureSourceChangedError';
	}
}

export class CachedClosureMetadataBudgetError extends Error {
	constructor(source: URL, storePath: StorePathString) {
		super(
			`The cache at ${sourceLabel(source)} could not read metadata for ${storePath} within its execution budget. Use a narrower reuse view before retrying.`
		);
		this.name = 'CachedClosureMetadataBudgetError';
	}
}

type MetadataSizeErrorCode =
	| typeof cacheMetadataErrorCodes.requestTooLarge
	| typeof cacheMetadataErrorCodes.narInfoTooLarge;

export class CachedClosureMetadataTooLargeError extends Error {
	constructor(
		source: URL,
		public readonly storePaths: readonly StorePathString[],
		public readonly code: MetadataSizeErrorCode
	) {
		const reason =
			code === cacheMetadataErrorCodes.requestTooLarge
				? `The request exceeds ${String(cacheMetadataMaxRequestBytes)} bytes. Reduce the number of store paths per metadata page before retrying.`
				: `A narinfo exceeds ${String(cacheMetadataMaxNarInfoBytes)} bytes. Smaller pages cannot resolve an oversized metadata entry. Ask the cache operator to inspect these paths.`;
		super(
			`The cache at ${sourceLabel(source)} rejected metadata for ${storePaths.join(', ')}. ${reason}`
		);
		this.name = 'CachedClosureMetadataTooLargeError';
	}
}

export class CachedClosureReferenceUnavailableError extends Error {
	constructor(storePath: StorePathString, message: string) {
		super(`The reference ${storePath} could not be substituted: ${message}`);
		this.name = 'CachedClosureReferenceUnavailableError';
	}
}

export class CachedClosureIdentityMismatchError extends Error {
	constructor(storePath: StorePathString, source: URL) {
		super(
			`The path ${storePath} in the selected store differs from the narinfo at ${sourceLabel(source)}`
		);
		this.name = 'CachedClosureIdentityMismatchError';
	}
}

export class CachedClosureLocalStoreRequiredError extends Error {
	constructor() {
		super(
			'Remote closure publication needs a runner-local Nix store session to substitute references'
		);
		this.name = 'CachedClosureLocalStoreRequiredError';
	}
}

function requireSourceUrl(source: URL): void {
	if (!['http:', 'https:'].includes(source.protocol)) {
		throw new CachedClosureSourceInvalidError(
			source,
			'the URL must use HTTP or HTTPS'
		);
	}

	if (source.username !== '' || source.password !== '') {
		throw new CachedClosureSourceInvalidError(
			source,
			'pass read credentials separately from the URL'
		);
	}

	if (source.search !== '' || source.hash !== '') {
		throw new CachedClosureSourceInvalidError(
			source,
			'the URL must not contain a query or fragment'
		);
	}
}

async function sourceOffer(
	source: CachedClosureSource,
	storePath: StorePathString,
	fetcher: typeof fetch,
	signal?: AbortSignal,
	shouldDiscoverCapability = false
): Promise<{ readonly bulk: boolean; readonly offer?: CachedClosureOffer }> {
	const url = `${canonicalHref(source.url)}/${StorePath.hash(storePath)}.narinfo`;
	const document = await fetchWithProbeDeadline(
		fetcher,
		url,
		{
			headers: {
				accept: 'text/x-nix-narinfo',
				...(source.credential && basicAuthHeader(source.credential))
			},
			...(signal && { signal })
		},
		async (response) => {
			const hasBulkCapability =
				shouldDiscoverCapability &&
				(response.headers.get(cacheMetadataCapabilityHeader) ?? '')
					.split(/[\s,]+/u)
					.includes(cacheMetadataCapability);
			if (hasBulkCapability && (response.ok || response.status === 404)) {
				// This response has no scope version. Read the path through the probe
				// before using its references.
				await discardResponseBody(response);
				return { bulk: true };
			}
			if (response.status === 404) {
				await discardResponseBody(response);
				return { bulk: false };
			}
			if (!response.ok) {
				await discardResponseBody(response);
				throw new CachedClosureSourceUnavailableError(
					storePath,
					source.url,
					response.status
				);
			}

			return {
				bulk: false,
				body: await readResponseText(response, {
					description: `narinfo for ${storePath}`,
					maximumBytes: cacheMetadataMaxNarInfoBytes
				})
			};
		}
	);
	return {
		bulk: document.bulk,
		...(document.body !== undefined && {
			offer: parseSourceOffer(source, storePath, document.body)
		})
	};
}

function parseSourceOffer(
	source: CachedClosureSource,
	storePath: StorePathString,
	body: string
): CachedClosureOffer {
	try {
		if (utf8.encode(body).byteLength > cacheMetadataMaxNarInfoBytes) {
			throw new Error('The narinfo exceeds the metadata byte limit');
		}
		return {
			...offerFromNarInfo(
				body,
				storePath,
				new StorePath(storePath).storeDirectory
			),
			narinfo: body
		};
	} catch (error) {
		throw new CachedClosureSourceInvalidError(
			source.url,
			`the narinfo for ${storePath} is invalid: ${String(error)}`
		);
	}
}

async function readMetadataText(
	response: Response,
	options: BoundedResponseBodyOptions
): Promise<string> {
	const bytes = await readResponseBytes(response, options);
	return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

async function readMetadataJson(
	response: Response,
	options: BoundedResponseBodyOptions
): Promise<unknown> {
	return JSON.parse(await readMetadataText(response, options));
}

class CachedClosureReader {
	#mode: 'bulk' | 'legacy' | undefined;
	#scopeVersion: string | undefined;

	constructor(
		readonly source: CachedClosureSource,
		readonly fetcher: typeof fetch,
		readonly signal?: AbortSignal
	) {}

	async #legacy(
		paths: readonly StorePathString[]
	): Promise<readonly (CachedClosureOffer | undefined)[]> {
		return mapWithConcurrency(paths, narInfoConcurrency, async (storePath) => {
			const result = await sourceOffer(
				this.source,
				storePath,
				this.fetcher,
				this.signal
			);
			return result.offer;
		});
	}

	async #bulkPage(
		paths: readonly StorePathString[]
	): Promise<readonly (CachedClosureOffer | undefined)[]> {
		const offers: (CachedClosureOffer | undefined)[] = [];
		let remaining = paths;
		while (remaining.length > 0) {
			let response: CacheMetadataResponse;
			try {
				response = await this.#request(remaining);
			} catch (error) {
				if (
					!(error instanceof CachedClosureMetadataBudgetError) ||
					remaining.length === 1
				) {
					throw error;
				}
				const midpoint = Math.ceil(remaining.length / 2);
				return [
					...offers,
					...(await this.#bulkPage(remaining.slice(0, midpoint))),
					...(await this.#bulkPage(remaining.slice(midpoint)))
				];
			}
			if (
				this.#scopeVersion !== undefined &&
				response.scopeVersion !== this.#scopeVersion
			) {
				throw new CachedClosureSourceChangedError(this.source.url);
			}
			this.#scopeVersion ??= response.scopeVersion;
			if (
				response.entries.some(
					(entry, index) => entry.storePath !== remaining[index]
				) ||
				(response.nextIndex === undefined
					? response.entries.length !== remaining.length
					: response.nextIndex >= remaining.length)
			) {
				throw new CachedClosureSourceInvalidError(
					this.source.url,
					'the metadata response does not match the requested prefix'
				);
			}
			offers.push(
				...response.entries.map((entry) =>
					entry.status === 'missing'
						? undefined
						: parseSourceOffer(this.source, entry.storePath, entry.narinfo)
				)
			);
			remaining =
				response.nextIndex === undefined
					? []
					: remaining.slice(response.nextIndex);
		}
		return offers;
	}

	async #request(
		paths: readonly StorePathString[]
	): Promise<CacheMetadataResponse> {
		const request = cacheMetadataRequestSchema.parse({
			storePaths: paths,
			...(this.#scopeVersion !== undefined && {
				expectedScopeVersion: this.#scopeVersion
			})
		});
		const body = JSON.stringify(request);
		if (utf8.encode(body).byteLength > cacheMetadataMaxRequestBytes) {
			throw new CachedClosureSourceInvalidError(
				this.source.url,
				'the metadata request exceeds the byte limit'
			);
		}
		return fetchWithProbeDeadline(
			this.fetcher,
			`${canonicalHref(this.source.url)}/api/v1/path-info`,
			{
				method: 'POST',
				headers: {
					accept: 'application/json',
					'content-type': 'application/json',
					...(this.source.credential && basicAuthHeader(this.source.credential))
				},
				body,
				...(this.signal && { signal: this.signal })
			},
			(response) => this.#readResponse(response, request.storePaths)
		);
	}

	async #readError(
		response: Response,
		paths: readonly StorePathString[]
	): Promise<CacheMetadataError | undefined> {
		let text: string;
		try {
			text = await readMetadataText(response, {
				description: 'cache metadata error',
				maximumBytes: cacheMetadataMaxRequestBytes,
				...(this.signal && { signal: this.signal })
			});
		} catch {
			this.signal?.throwIfAborted();
			throw new CachedClosureSourceInvalidError(
				this.source.url,
				'the metadata error response could not be read as bounded UTF-8'
			);
		}
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			if (response.status !== 413) {
				return undefined;
			}
			throw new CachedClosureSourceInvalidError(
				this.source.url,
				'the metadata error response is not valid JSON'
			);
		}
		const parsed = cacheMetadataErrorSchema.safeParse(body);
		if (!parsed.success) {
			const code =
				typeof body === 'object' && body !== null && 'code' in body
					? body.code
					: undefined;
			if (
				response.status !== 413 &&
				!cacheMetadataErrorSchema.shape.code.safeParse(code).success
			) {
				return undefined;
			}
			throw new CachedClosureSourceInvalidError(
				this.source.url,
				'the metadata error response does not match the protocol'
			);
		}
		if (
			parsed.data.storePath !== undefined &&
			!paths.includes(parsed.data.storePath)
		) {
			throw new CachedClosureSourceInvalidError(
				this.source.url,
				'the metadata error response identifies a store path outside the requested page'
			);
		}
		return parsed.data;
	}

	async #readResponse(
		response: Response,
		paths: readonly StorePathString[]
	): Promise<CacheMetadataResponse> {
		const first = paths[0];
		if (first === undefined) {
			throw new CachedClosureSourceInvalidError(
				this.source.url,
				'a metadata request must contain a store path'
			);
		}
		if (!response.ok) {
			const errorBody = await this.#readError(response, paths);
			if (
				response.status === 409 ||
				errorBody?.code === cacheMetadataErrorCodes.scopeChanged
			) {
				throw new CachedClosureSourceChangedError(this.source.url);
			}
			if (response.status === 413) {
				if (errorBody?.code === cacheMetadataErrorCodes.candidateBudget) {
					throw new CachedClosureMetadataBudgetError(this.source.url, first);
				}
				if (
					errorBody?.code === cacheMetadataErrorCodes.requestTooLarge ||
					errorBody?.code === cacheMetadataErrorCodes.narInfoTooLarge
				) {
					throw new CachedClosureMetadataTooLargeError(
						this.source.url,
						errorBody.storePath === undefined ? paths : [errorBody.storePath],
						errorBody.code
					);
				}
			}
			throw new CachedClosureMetadataUnavailableError(this.source.url, paths, {
				status: response.status,
				...(errorBody && { error: errorBody })
			});
		}
		try {
			return cacheMetadataResponseSchema.parse(
				await readMetadataJson(response, {
					description: `cache metadata from ${sourceLabel(this.source.url)}`,
					maximumBytes: cacheMetadataMaxResponseBytes,
					...(this.signal && { signal: this.signal })
				})
			);
		} catch (error) {
			this.signal?.throwIfAborted();
			throw new CachedClosureSourceInvalidError(
				this.source.url,
				`the metadata response is invalid: ${String(error)}`
			);
		}
	}
	async offers(
		paths: readonly StorePathString[]
	): Promise<readonly (CachedClosureOffer | undefined)[]> {
		const first = paths[0];
		if (first === undefined) {
			return [];
		}
		if (this.#mode === undefined) {
			const discovery = await sourceOffer(
				this.source,
				first,
				this.fetcher,
				this.signal,
				true
			);
			this.#mode = discovery.bulk ? 'bulk' : 'legacy';
			if (!discovery.bulk) {
				return [discovery.offer, ...(await this.#legacy(paths.slice(1)))];
			}
		}
		if (this.#mode === 'legacy') {
			return this.#legacy(paths);
		}
		const pages = chunk(paths, cacheMetadataMaxPaths);
		const initial: (CachedClosureOffer | undefined)[] = [];
		if (this.#scopeVersion === undefined) {
			const page = pages.shift();
			if (page !== undefined) {
				initial.push(...(await this.#bulkPage(page)));
			}
		}
		const results = await mapWithConcurrency(
			pages,
			narInfoConcurrency,
			(page) => this.#bulkPage(page)
		);
		return [...initial, ...results.flat()];
	}
}

function haveSameReferences(
	left: readonly StorePathString[],
	right: readonly StorePathString[]
): boolean {
	return (
		[...new Set(left)].toSorted(byCodeUnit).join('\n') ===
		[...new Set(right)].toSorted(byCodeUnit).join('\n')
	);
}

function hasSameIdentity(
	info: NixValidPathInfo,
	offer: CachedClosureOffer
): boolean {
	return (
		info.narHash.toString() === offer.narHash.toString() &&
		haveSameReferences(info.references, offer.references)
	);
}

async function substituteReferences(
	references: readonly StorePathString[],
	nix: Pick<NixDaemonSession, 'addTempRoot' | 'buildPathsWithResults'>
): Promise<void> {
	if (references.length === 0) {
		return;
	}

	for (const reference of references) {
		await nix.addTempRoot(reference);
	}

	const results = await nix.buildPathsWithResults(references);
	const byPath = new Map(results.map((result) => [result.target, result]));

	for (const reference of references) {
		const outcome = byPath.get(reference)?.outcome;

		if (
			outcome?.kind === 'substituted' ||
			outcome?.kind === 'already-valid' ||
			outcome?.kind === 'resolves-to-already-valid'
		) {
			continue;
		}

		throw new CachedClosureReferenceUnavailableError(
			reference,
			outcome === undefined
				? 'Nix returned no result'
				: 'message' in outcome
					? outcome.message
					: `Nix reported ${outcome.kind}`
		);
	}
}

async function copyReferences(
	references: readonly StorePathString[],
	options: MaterialiseCachedClosureOptions
): Promise<void> {
	if (references.length === 0 || options.store === '') {
		return;
	}

	for (const reference of references) {
		await options.nix.addTempRoot(reference);
	}

	await (options.runCopy ?? copyNixPaths)(
		{ paths: references, from: options.localStore, to: options.store },
		options.signal
	);
}

async function resolveReferenceClosure(
	options: MaterialiseCachedClosureOptions,
	fetcherFor: (source: CachedClosureSource) => typeof fetch
): Promise<readonly StorePathString[]> {
	interface PendingPath {
		readonly storePath: StorePathString;
		readonly source: CachedClosureSource;
		readonly target: boolean;
	}
	interface ResolvedPath {
		readonly source: CachedClosureSource;
		readonly storePath: StorePathString;
		readonly offer: CachedClosureOffer;
	}
	interface ReadAttempt {
		readonly entry: PendingPath;
		readonly index: number;
		readonly sources: readonly CachedClosureSource[];
		readonly sourceIndex: number;
	}
	const readers = new Map<CachedClosureSource, CachedClosureReader>();
	const referenced = new Map<CachedClosureSource, StorePathString[]>();
	const known = new Map<
		StorePathString,
		{ source: CachedClosureSource; offer: CachedClosureOffer }
	>();
	const missing: StorePathString[] = [];
	const seen = new Set<StorePathString>();
	let pending: PendingPath[] = [];
	const enqueue = (entry: PendingPath): void => {
		if (seen.has(entry.storePath)) {
			return;
		}
		seen.add(entry.storePath);
		pending.push(entry);
	};

	for (const source of options.sources) {
		requireSourceUrl(source.url);
		for (const storePath of source.paths) {
			enqueue({ source, storePath, target: true });
		}
	}

	while (pending.length > 0) {
		options.signal?.throwIfAborted();
		const batch = pending;
		pending = [];
		const resolved: (ResolvedPath | undefined)[] = Array.from({
			length: batch.length
		});
		let attempts: ReadAttempt[] = batch.map((entry, index) => ({
			entry,
			index,
			sources: entry.target
				? [entry.source]
				: [
						entry.source,
						...options.sources.filter((source) => source !== entry.source)
					],
			sourceIndex: 0
		}));
		while (attempts.length > 0) {
			const groups = new Map<CachedClosureSource, ReadAttempt[]>();
			for (const attempt of attempts) {
				const source = attempt.sources[attempt.sourceIndex];
				if (source === undefined) {
					continue;
				}
				const entries = groups.get(source) ?? [];
				entries.push(attempt);
				groups.set(source, entries);
			}
			attempts = [];
			for (const [source, entries] of groups) {
				let reader = readers.get(source);
				if (reader === undefined) {
					reader = new CachedClosureReader(
						source,
						fetcherFor(source),
						options.signal
					);
					readers.set(source, reader);
				}
				const offers = await reader.offers(
					entries.map((attempt) => attempt.entry.storePath)
				);
				for (const [index, attempt] of entries.entries()) {
					const offer = offers[index];
					if (offer !== undefined) {
						resolved[attempt.index] = {
							source,
							storePath: attempt.entry.storePath,
							offer
						};
						continue;
					}
					if (attempt.entry.target) {
						throw new CachedClosureSourceUnavailableError(
							attempt.entry.storePath,
							source.url,
							404
						);
					}
					if (attempt.sourceIndex + 1 < attempt.sources.length) {
						attempts.push({ ...attempt, sourceIndex: attempt.sourceIndex + 1 });
					}
				}
			}
		}
		for (const [index, entry] of resolved.entries()) {
			if (entry === undefined) {
				const requested = batch[index];
				if (requested !== undefined) {
					missing.push(requested.storePath);
				}
				continue;
			}
			known.set(entry.storePath, entry);
			const paths = referenced.get(entry.source) ?? [];
			paths.push(entry.storePath);
			referenced.set(entry.source, paths);
			for (const storePath of entry.offer.references) {
				enqueue({ source: entry.source, storePath, target: false });
			}
		}
	}

	const paths: StorePathString[] = [];
	if (missing.length > 0) {
		for (const storePath of missing) {
			await options.nix.addTempRoot(storePath);
		}
		const valid =
			options.nix.queryValidPaths === undefined
				? new Set<StorePathString>()
				: new Set(await options.nix.queryValidPaths(missing));
		const needed = missing.filter((storePath) => !valid.has(storePath));
		if (needed.length > 0) {
			const local = options.store === '' ? options.nix : options.localNix;
			if (local === undefined) {
				throw new CachedClosureLocalStoreRequiredError();
			}
			await substituteReferences(needed, local);
			await copyReferences(needed, options);
		}
		const infos = await options.nix.resolveClosure(missing);
		const present = new Set(infos.map((info) => info.storePath));
		for (const storePath of missing) {
			if (!present.has(storePath)) {
				throw new CachedClosureReferenceUnavailableError(
					storePath,
					'the selected store did not return the realised path'
				);
			}
		}
		for (const info of infos) {
			const cached = known.get(info.storePath);
			if (cached !== undefined) {
				if (!hasSameIdentity(info, cached.offer)) {
					throw new CachedClosureIdentityMismatchError(
						info.storePath,
						cached.source.url
					);
				}
				continue;
			}
			paths.push(info.storePath);
		}
	}
	for (const [source, paths] of referenced) {
		options.onReferenced(
			source.url,
			paths.map((storePath) => {
				const entry = known.get(storePath);
				if (entry === undefined) {
					throw new CachedClosureSourceInvalidError(
						source.url,
						`missing metadata for ${storePath}`
					);
				}
				return { storePath, narinfo: entry.offer.narinfo };
			})
		);
	}
	return [...new Set(paths)].toSorted(byCodeUnit);
}

/**
 * The caller keeps the session and temporary roots live through publication.
 */
export async function materialiseCachedClosure(
	options: MaterialiseCachedClosureOptions
): Promise<readonly StorePathString[]> {
	const sourceFetchers = new Map<CachedClosureSource, typeof fetch>();
	const sourceFetcher = (source: CachedClosureSource): typeof fetch => {
		let fetcher = sourceFetchers.get(source);

		if (fetcher === undefined) {
			fetcher = retryingFetcher(
				withReadAuthentication(options.fetch ?? fetch, {
					tenantUrl: source.url
				}),
				'replay-safe'
			);
			sourceFetchers.set(source, fetcher);
		}

		return fetcher;
	};
	return resolveReferenceClosure(options, sourceFetcher);
}
