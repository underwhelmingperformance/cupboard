import {
	type NarInfoOffer,
	offerFromNarInfo
} from '@cupboard/nix-store/narinfo-reader';
import { type StorePathString } from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
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
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { basicAuthHeader, type BasicCredential } from '@cupboard/shared/http';
import { fetchWithProbeRetries, lookupInPages } from '@cupboard/shared/paging';
import {
	type BoundedResponseBodyOptions,
	readResponseBytes,
	readResponseText
} from '@cupboard/shared/response-body';
import { loggedUrl } from '@cupboard/shared/retry';

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

export interface CachedClosureOffer extends NarInfoOffer {
	readonly narinfo: string;
}

export interface CachedClosureProgress {
	readonly mode: 'bulk' | 'legacy';
	readonly checked: number;
	readonly found: number;
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

export function requireSourceUrl(source: URL): void {
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
	const document = await fetchWithProbeRetries(
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

export class CachedClosureReader {
	#mode: 'bulk' | 'legacy' | undefined;
	#scopeVersion: string | undefined;

	constructor(
		readonly source: CachedClosureSource,
		readonly fetcher: typeof fetch,
		readonly signal?: AbortSignal,
		readonly onProgress?: (progress: CachedClosureProgress) => void
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
			this.onProgress?.({
				mode: 'legacy',
				checked: 1,
				found: result.offer === undefined ? 0 : 1
			});
			return result.offer;
		});
	}

	async #bulkPage(
		paths: readonly StorePathString[],
		signal: AbortSignal
	): Promise<readonly (CachedClosureOffer | undefined)[]> {
		const response = await this.#request(paths, signal);
		// An attempt can answer after its deadline has aborted its signal. Discard
		// that answer.
		signal.throwIfAborted();
		if (
			this.#scopeVersion !== undefined &&
			response.scopeVersion !== this.#scopeVersion
		) {
			throw new CachedClosureSourceChangedError(this.source.url);
		}
		this.#scopeVersion ??= response.scopeVersion;
		if (
			response.entries.some(
				(entry, index) => entry.storePath !== paths[index]
			) ||
			(response.nextIndex === undefined
				? response.entries.length !== paths.length
				: response.nextIndex >= paths.length)
		) {
			throw new CachedClosureSourceInvalidError(
				this.source.url,
				'the metadata response does not match the requested prefix'
			);
		}
		const pageOffers = response.entries.map((entry) =>
			entry.status === 'missing'
				? undefined
				: parseSourceOffer(this.source, entry.storePath, entry.narinfo)
		);
		this.onProgress?.({
			mode: 'bulk',
			checked: pageOffers.length,
			found: pageOffers.filter((offer) => offer !== undefined).length
		});
		return pageOffers;
	}

	async #request(
		paths: readonly StorePathString[],
		signal: AbortSignal
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
		const response = await this.fetcher(this.#pathInfoUrl(), {
			method: 'POST',
			headers: {
				accept: 'application/json',
				'content-type': 'application/json',
				...(this.source.credential && basicAuthHeader(this.source.credential))
			},
			body,
			signal
		});
		return this.#readResponse(response, request.storePaths);
	}

	#pathInfoUrl(): string {
		return `${canonicalHref(this.source.url)}/api/v1/path-info`;
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
				this.onProgress?.({
					mode: 'legacy',
					checked: 1,
					found: discovery.offer === undefined ? 0 : 1
				});
				return [discovery.offer, ...(await this.#legacy(paths.slice(1)))];
			}
		}
		if (this.#mode === 'legacy') {
			return this.#legacy(paths);
		}
		return lookupInPages(paths, {
			pageSize: cacheMetadataMaxPaths,
			concurrency: narInfoConcurrency,
			finishFirstPage: this.#scopeVersion === undefined,
			deadline: {
				target: { url: loggedUrl(this.#pathInfoUrl()) },
				replaySafety: 'replay-safe',
				signal: this.signal
			},
			isPageTooLarge: (error) =>
				error instanceof CachedClosureMetadataBudgetError,
			request: (page, signal) => this.#bulkPage(page, signal)
		});
	}
}
