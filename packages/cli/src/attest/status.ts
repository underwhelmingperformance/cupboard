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
import { chunk } from '@cupboard/shared/collections';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { basicAuthHeader, type ReadUser } from '@cupboard/shared/http';
import {
	readResponseBytes,
	readResponseText
} from '@cupboard/shared/response-body';

import { throwIfAborted } from '../abort.ts';
import { cacheReadFetcher } from '../client/transport.ts';
import { CliError, CliUsageError, CupboardHttpError } from '../errors.ts';

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
	const fetchRead = cacheReadFetcher(options.url, fetcher, options.netrcFile);
	const base = cacheUrl(options.url, options.cache);
	const headers =
		options.readUser !== undefined && options.readPassword !== undefined
			? basicAuthHeader({
					user: options.readUser,
					password: options.readPassword
				})
			: {};
	const target = (path: string): URL =>
		new URL(`${base.href.replace(/\/$/u, '')}/${path}`);
	const read = async (path: string, init?: RequestInit): Promise<Response> => {
		const response = await fetchRead(target(path), {
			...init,
			headers: requestHeaders(headers, init?.headers),
			signal: options.signal
		});
		if (!response.ok && response.status !== 404) {
			if (response.status === 409) {
				await discardResponseBody(response);
				throw new AttestationDiscoveryScopeChangedError();
			}
			const body = await discoveryRefusalText(response, options.signal);
			if (path === 'api/v1/attestation-info') {
				const failure = parseDiscoveryFailure(body);
				if (response.status === 413 && failure?.code === 'request-too-large') {
					throw new AttestationDiscoveryRequestLimitError();
				}
				if (
					(response.status === 413 && failure?.code === 'list-too-large') ||
					(response.status === 502 && failure?.code === 'list-invalid')
				) {
					throw new InvalidAttestationDiscoveryError();
				}
			}
			throw new CupboardHttpError(
				init?.method ?? 'GET',
				path,
				response.status,
				body,
				response.headers.get('cf-ray') ?? undefined
			);
		}
		return response;
	};
	const capabilityResponse = await read('nix-cache-info');
	if (!capabilityResponse.ok) {
		await discardResponseBody(capabilityResponse);
		throw new CupboardHttpError(
			'GET',
			'nix-cache-info',
			capabilityResponse.status,
			'The cache is unavailable.'
		);
	}
	const capabilities =
		capabilityResponse.headers
			.get(cacheMetadataCapabilityHeader)
			?.split(/\s+/u) ?? [];
	await discardResponseBody(capabilityResponse);
	const hashes = [...new Set(options.storePathHashes)];
	if (!capabilities.includes(attestationInfoCapability)) {
		return mapWithConcurrency(
			hashes,
			6,
			async (hash): Promise<AttestationInfoEntry> => {
				const narResponse = await read(`${hash}.narinfo`);
				if (narResponse.status === 404) {
					await discardResponseBody(narResponse);
					return settled({ storePathHash: hash, status: 'missing' });
				}
				const text = await discoveryText(narResponse, {
					description: 'Attestation discovery narinfo',
					maximumBytes: 1024 * 1024,
					signal: options.signal
				});
				const narinfo = parseDiscoveryNarInfo(text);
				if (narinfo.storePath.hash !== hash) {
					throw new InvalidAttestationDiscoveryError();
				}
				const found = {
					storePathHash: hash,
					status: 'found',
					narHash: narinfo.narHash.toString()
				} as const;
				const response = await read(`attestations/${hash}`);
				if (response.status === 404) {
					await discardResponseBody(response);
					return settled({ ...found, attestations: [] });
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
				return settled({
					...found,
					attestations: list.data.attestations.filter(
						(descriptor) =>
							options.predicateTypes === undefined ||
							options.predicateTypes.includes(descriptor.predicateType)
					)
				});
			}
		);
	}
	const entries: AttestationInfoEntry[] = [];
	let scopeVersion: string | undefined;
	for (const group of chunk(hashes, attestationInfoMaxPaths)) {
		let remaining = group;
		while (remaining.length > 0) {
			const response = await read('api/v1/attestation-info', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					storePathHashes: remaining,
					...(options.predicateTypes !== undefined && {
						predicateTypes: options.predicateTypes
					}),
					...(scopeVersion !== undefined && {
						expectedScopeVersion: scopeVersion
					})
				})
			});
			if (!response.ok) {
				await discardResponseBody(response);
				throw new CupboardHttpError(
					'POST',
					'api/v1/attestation-info',
					response.status,
					'The advertised attestation discovery endpoint is unavailable.'
				);
			}
			const value = await discoveryJson(response, {
				description: 'Attestation discovery page',
				maximumBytes: attestationInfoMaxResponseBytes,
				signal: options.signal
			});
			const result = attestationInfoResponseSchema.safeParse(value);
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
			scopeVersion = page.scopeVersion;
			entries.push(...page.entries);
			options.onProgress?.(entries.length);
			remaining =
				page.nextIndex === undefined ? [] : remaining.slice(page.nextIndex);
		}
	}
	return entries;
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
