import { cacheUrl } from '@cupboard/nix-store/cache-url';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	type CacheScope,
	type PredicateType,
	type StorePathHash
} from '@cupboard/nix-store/scalars';
import {
	attestationInfoCapability,
	type AttestationInfoEntry,
	attestationInfoErrorSchema,
	attestationInfoMaxListBytes,
	attestationInfoMaxPaths,
	attestationInfoMaxResponseBytes,
	attestationInfoResponseSchema,
	attestationListSchema
} from '@cupboard/protocol/attestations';
import { cacheMetadataCapabilityHeader } from '@cupboard/protocol/cache-metadata';
import { discardResponseBody } from '@cupboard/shared/cleanup';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { basicAuthHeader, type ReadUser } from '@cupboard/shared/http';
import { fetchWithProbeRetries, lookupInPages } from '@cupboard/shared/paging';
import {
	readResponseBytes,
	readResponseText
} from '@cupboard/shared/response-body';
import { loggedUrl } from '@cupboard/shared/retry';
import { StatusCodes } from 'http-status-codes';

import { throwIfAborted } from '../abort.ts';
import { cacheReadFetcher } from '../client/transport.ts';
import { CliError, CliUsageError, CupboardHttpError } from '../errors.ts';

const notFoundStatus: number = StatusCodes.NOT_FOUND;
const conflictStatus: number = StatusCodes.CONFLICT;
const requestTooLongStatus: number = StatusCodes.REQUEST_TOO_LONG;
const badGatewayStatus: number = StatusCodes.BAD_GATEWAY;

export interface AttestationDiscoveryOptions {
	readonly url: URL;
	readonly cache: CacheScope;
	readonly storePathHashes: readonly StorePathHash[];
	readonly predicateTypes?: readonly PredicateType[];
	readonly readUser?: ReadUser;
	readonly readPassword?: string;
	readonly netrcFile?: string;
	readonly signal?: AbortSignal;
	readonly onProgress?: (completed: number) => void;
}

export class InvalidAttestationDiscoveryError extends CliError {
	constructor(override readonly cause?: unknown) {
		super(
			'The cache returned invalid attestation discovery metadata. Retry against the current server revision.'
		);
		this.name = 'InvalidAttestationDiscoveryError';
	}
	override get exitCode(): number {
		return 75;
	}
}

export class AttestationDiscoveryScopeChangedError extends CliError {
	constructor() {
		super(
			'The cache changed during attestation discovery. Repeat the status check.'
		);
		this.name = 'AttestationDiscoveryScopeChangedError';
	}
	override get exitCode(): number {
		return 69;
	}
}

class AttestationDiscoveryRequestLimitError extends CliUsageError {
	constructor() {
		super(
			'The attestation discovery request exceeds the server limit. Use fewer or shorter predicate filters.'
		);
		this.name = 'AttestationDiscoveryRequestLimitError';
	}
}

/**
Returns stored descriptors without verifying bundle signatures or subjects.
*/
export async function readAttestationInfo(
	options: AttestationDiscoveryOptions,
	fetcher?: typeof fetch
): Promise<AttestationInfoEntry[]> {
	let completed = 0;
	const settled = (entry: AttestationInfoEntry): AttestationInfoEntry => {
		completed += 1;
		options.onProgress?.(completed);
		return entry;
	};
	const fetchRead = cacheReadFetcher(options.url, fetcher, {
		netrcFile: options.netrcFile,
		trustedOrigin: options.url.origin
	});
	const base = cacheUrl(options.url, options.cache);
	const headers =
		options.readUser === undefined || options.readPassword === undefined
			? {}
			: basicAuthHeader({
					user: options.readUser,
					password: options.readPassword
				});
	const target = (path: string): string =>
		`${base.href.replace(/\/$/u, '')}/${path}`;
	const refuseUnexpected = async (
		path: string,
		method: string,
		response: Response
	): Promise<void> => {
		if (response.ok || response.status === notFoundStatus) {
			return;
		}
		if (response.status === conflictStatus) {
			await discardResponseBody(response);
			throw new AttestationDiscoveryScopeChangedError();
		}
		const body = await discoveryRefusalText(response, options.signal);
		if (path === 'api/v1/attestation-info') {
			const failure = parseDiscoveryFailure(body);
			if (
				response.status === requestTooLongStatus &&
				failure?.code === 'request-too-large'
			) {
				throw new AttestationDiscoveryRequestLimitError();
			}
			if (
				(response.status === requestTooLongStatus &&
					failure?.code === 'list-too-large') ||
				(response.status === badGatewayStatus &&
					failure?.code === 'list-invalid')
			) {
				throw new InvalidAttestationDiscoveryError();
			}
		}
		throw new CupboardHttpError(
			method,
			path,
			response.status,
			body,
			response.headers.get('cf-ray') ?? undefined
		);
	};
	const read = async <Result>(
		path: string,
		consume: (response: Response) => Promise<Result>
	): Promise<Result> =>
		fetchWithProbeRetries(
			fetchRead,
			target(path),
			{ headers: requestHeaders(headers), signal: options.signal },
			async (response) => {
				await refuseUnexpected(path, 'GET', response);
				return consume(response);
			}
		);
	const capabilities = await read('nix-cache-info', async (response) => {
		if (!response.ok) {
			await discardResponseBody(response);
			throw new CupboardHttpError(
				'GET',
				'nix-cache-info',
				response.status,
				'The cache is unavailable.'
			);
		}
		const advertised =
			response.headers.get(cacheMetadataCapabilityHeader)?.split(/\s+/u) ?? [];
		await discardResponseBody(response);
		return advertised;
	});
	const hashes = [...new Set(options.storePathHashes)];
	if (!capabilities.includes(attestationInfoCapability)) {
		return mapWithConcurrency(
			hashes,
			6,
			async (hash): Promise<AttestationInfoEntry> => {
				const narinfo = await read(`${hash}.narinfo`, async (response) => {
					if (response.status === notFoundStatus) {
						await discardResponseBody(response);
						return;
					}
					return parseDiscoveryNarInfo(
						await discoveryText(response, {
							description: 'Attestation discovery narinfo',
							maximumBytes: 1024 * 1024,
							signal: options.signal
						})
					);
				});
				if (narinfo === undefined) {
					return settled({ storePathHash: hash, status: 'missing' });
				}
				if (narinfo.storePath.hash !== hash) {
					throw new InvalidAttestationDiscoveryError();
				}
				const found = {
					storePathHash: hash,
					status: 'found',
					narHash: narinfo.narHash.toString()
				} as const;
				const attestations = await read(
					`attestations/${hash}`,
					async (response) => {
						if (response.status === notFoundStatus) {
							await discardResponseBody(response);
							return [];
						}
						const value = await discoveryJson(response, {
							description: 'Attestation list',
							maximumBytes: attestationInfoMaxListBytes,
							signal: options.signal
						});
						const list = attestationListSchema.safeParse(value);
						if (!list.success) {
							throw new InvalidAttestationDiscoveryError(list.error);
						}
						return list.data.attestations;
					}
				);
				return settled({
					...found,
					attestations: attestations.filter(
						(descriptor) =>
							options.predicateTypes === undefined ||
							options.predicateTypes.includes(descriptor.predicateType)
					)
				});
			}
		);
	}
	const pagePath = 'api/v1/attestation-info';
	let scopeVersion: string | undefined;
	return lookupInPages(hashes, {
		pageSize: attestationInfoMaxPaths,
		concurrency: 1,
		deadline: {
			target: { url: loggedUrl(target(pagePath)) },
			replaySafety: 'replay-safe',
			signal: options.signal
		},
		request: async (remaining, signal) => {
			const response = await fetchRead(target(pagePath), {
				method: 'POST',
				headers: requestHeaders(headers, {
					'content-type': 'application/json'
				}),
				body: JSON.stringify({
					storePathHashes: remaining,
					...(options.predicateTypes !== undefined && {
						predicateTypes: options.predicateTypes
					}),
					...(scopeVersion !== undefined && {
						expectedScopeVersion: scopeVersion
					})
				}),
				signal
			});
			await refuseUnexpected(pagePath, 'POST', response);
			if (!response.ok) {
				await discardResponseBody(response);
				throw new CupboardHttpError(
					'POST',
					pagePath,
					response.status,
					'The advertised attestation discovery endpoint is unavailable.'
				);
			}
			const result = attestationInfoResponseSchema.safeParse(
				await discoveryJson(response, {
					description: 'Attestation discovery page',
					maximumBytes: attestationInfoMaxResponseBytes,
					signal: options.signal
				})
			);
			if (!result.success) {
				throw new InvalidAttestationDiscoveryError(result.error);
			}
			const page = result.data;
			if (
				(scopeVersion !== undefined && page.scopeVersion !== scopeVersion) ||
				page.entries.length > remaining.length ||
				page.entries.some(
					(entry, index) => entry.storePathHash !== remaining[index]
				) ||
				(page.nextIndex === undefined &&
					page.entries.length !== remaining.length)
			) {
				throw new InvalidAttestationDiscoveryError();
			}
			// An attempt can answer after its deadline has aborted its signal.
			// Discard that answer.
			signal.throwIfAborted();
			scopeVersion = page.scopeVersion;
			completed += page.entries.length;
			options.onProgress?.(completed);
			return page.entries;
		}
	});
}

async function discoveryRefusalText(
	response: Response,
	signal?: AbortSignal
): Promise<string> {
	try {
		return await readResponseText(response, {
			description: 'Attestation discovery refusal',
			maximumBytes: 8192,
			signal
		});
	} catch {
		throwIfAborted(signal);
		return 'The error response body could not be read within the discovery limit.';
	}
}

function parseDiscoveryFailure(body: string) {
	try {
		const result = attestationInfoErrorSchema.safeParse(JSON.parse(body));
		return result.success ? result.data : undefined;
	} catch {
		return;
	}
}

async function discoveryText(
	response: Response,
	options: {
		readonly description: string;
		readonly maximumBytes: number;
		readonly signal?: AbortSignal;
	}
): Promise<string> {
	try {
		return await readResponseText(response, options);
	} catch (error) {
		throwIfAborted(options.signal);
		throw new InvalidAttestationDiscoveryError(error);
	}
}

function requestHeaders(
	authentication: HeadersInit,
	additional?: HeadersInit
): Headers {
	const headers = new Headers(authentication);
	new Headers(additional).forEach((value, key) => {
		headers.set(key, value);
	});
	return headers;
}

async function discoveryJson(
	response: Response,
	options: {
		readonly description: string;
		readonly maximumBytes: number;
		readonly signal?: AbortSignal;
	}
): Promise<unknown> {
	try {
		const bytes = await readResponseBytes(response, options);
		return JSON.parse(
			new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
		);
	} catch (error) {
		throwIfAborted(options.signal);
		throw new InvalidAttestationDiscoveryError(error);
	}
}

function parseDiscoveryNarInfo(text: string): NarInfo {
	try {
		return NarInfo.parse(text);
	} catch (error) {
		throw new InvalidAttestationDiscoveryError(error);
	}
}
