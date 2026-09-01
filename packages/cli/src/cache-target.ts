import {
	cacheUrl,
	parseTenantCacheUrl,
	type TenantCacheUrl
} from '@cupboard/nix-store/cache-url';
import { InvalidTenantCacheUrlError } from '@cupboard/nix-store/errors';
import { cacheNameSchema, type CacheScope } from '@cupboard/nix-store/scalars';

import { type CacheScopedClient, callInCache } from './client/cache-scoped.ts';
import type { AccessCredential } from './client/credentials.ts';
import { tenantRpc } from './client/orpc.ts';
import { isRpcNotFoundError } from './client/rpc-errors.ts';
import {
	CacheTargetConflictError,
	CacheTargetPayloadCountError,
	CacheTargetPayloadRequiredError,
	CommandPayloadRequiredError,
	InvalidCacheTargetUrlError
} from './errors.ts';

export type CacheTarget = TenantCacheUrl;

export type NamedCacheTarget = TenantCacheUrl & {
	readonly cache: Extract<CacheScope, { readonly kind: 'named' }>;
};

export interface ResolvedCachePositionals {
	readonly target: CacheTarget;
	readonly payload: readonly string[];
}

export interface AuthorisedCachePositionals extends ResolvedCachePositionals {
	readonly credential: AccessCredential;
}

export interface DelimitedCachePositionals {
	readonly cacheName: string | undefined;
	readonly payload: readonly string[];
}

export interface DelimitedCacheOptions {
	readonly withoutSeparator: 'command-payload' | 'cache-only';
}

export interface CachePositionalResolution {
	readonly minimumPayload: number;
	readonly maximumPayload?: number;
	readonly payloadDescription: string;
	readonly cacheExists: (target: CacheTarget) => Promise<boolean>;
}

function validatePayload(
	resolved: ResolvedCachePositionals,
	resolution: CachePositionalResolution
): ResolvedCachePositionals {
	if (resolved.payload.length < resolution.minimumPayload) {
		throw new CommandPayloadRequiredError(resolution.payloadDescription);
	}

	if (
		resolution.maximumPayload !== undefined &&
		resolved.payload.length > resolution.maximumPayload
	) {
		throw new CacheTargetPayloadCountError(
			resolved.payload.length,
			resolution.maximumPayload,
			resolution.payloadDescription
		);
	}

	return resolved;
}

export interface CacheLookupClient {
	readonly get: CacheScopedClient<Record<never, never>, unknown>;
}

export interface CacheTargetAuthorisation extends Omit<
	CachePositionalResolution,
	'cacheExists'
> {
	readonly authorise: (
		target: CacheTarget
	) => AccessCredential | Promise<AccessCredential>;
	readonly signal?: AbortSignal;
}

/**
 * Separates an optional cache name before `--` from command arguments after
 * it. Without a separator, every positional is command payload.
 */
export function splitDelimitedCachePositionals(
	positionals: readonly string[],
	rawArguments: readonly string[],
	options: DelimitedCacheOptions
): DelimitedCachePositionals {
	const separator = rawArguments.indexOf('--');

	if (separator === -1) {
		if (options.withoutSeparator === 'command-payload') {
			return { cacheName: undefined, payload: positionals };
		}

		if (positionals.length > 1) {
			throw new CacheTargetPayloadCountError(
				positionals.length,
				1,
				'an optional cache name'
			);
		}

		return { cacheName: positionals[0], payload: [] };
	}

	const payloadLength = rawArguments.length - separator - 1;
	const cachePositionalsLength = positionals.length - payloadLength;
	const cachePositionals = positionals.slice(0, cachePositionalsLength);

	if (cachePositionals.length > 1) {
		throw new CacheTargetPayloadCountError(
			cachePositionals.length,
			1,
			'an optional cache name before --'
		);
	}

	const payload = positionals.slice(cachePositionalsLength);

	return { cacheName: cachePositionals[0], payload };
}

/**
 * Resolves a tenant or cache URL to one native cache target.
 */
export function cacheTargetFromUrl(url: URL): CacheTarget {
	try {
		return parseTenantCacheUrl(url);
	} catch (error) {
		if (error instanceof InvalidTenantCacheUrlError) {
			throw new InvalidCacheTargetUrlError(url.href, { cause: error });
		}

		throw error;
	}
}

export function cacheTargetWithName(
	target: CacheTarget,
	name: string
): NamedCacheTarget {
	if (target.cache.kind === 'named') {
		throw new CacheTargetConflictError(
			target.tenantUrl.href,
			target.cache.name
		);
	}

	return {
		tenantUrl: target.tenantUrl,
		cache: { kind: 'named', name: cacheNameSchema.parse(name) }
	};
}

/**
 * Resolves the optional cache name after a tenant URL. A syntactically valid
 * first positional selects a named cache only when that cache exists. All
 * other values remain command payload, including an explicit local path such
 * as `./result`.
 */
export async function resolveCachePositionals(
	url: URL,
	positionals: readonly string[],
	resolution: CachePositionalResolution
): Promise<ResolvedCachePositionals> {
	const urlTarget = cacheTargetFromUrl(url);

	if (urlTarget.cache.kind === 'named' || positionals.length === 0) {
		return validatePayload(
			{ target: urlTarget, payload: positionals },
			resolution
		);
	}

	const [candidate, ...payload] = positionals;
	const name = cacheNameSchema.safeParse(candidate);

	if (!name.success) {
		return validatePayload(
			{ target: urlTarget, payload: positionals },
			resolution
		);
	}

	const candidateTarget = cacheTargetWithName(urlTarget, name.data);

	if (!(await resolution.cacheExists(candidateTarget))) {
		return validatePayload(
			{ target: urlTarget, payload: positionals },
			resolution
		);
	}

	if (payload.length < resolution.minimumPayload) {
		throw new CacheTargetPayloadRequiredError(
			candidateTarget,
			resolution.payloadDescription,
			cacheUrl(candidateTarget.tenantUrl, candidateTarget.cache)
		);
	}

	return validatePayload({ target: candidateTarget, payload }, resolution);
}

/**
 * Returns an exact-cache lookup backed by the cache-scoped read procedure.
 */
export function cacheExistsWith(
	client: CacheLookupClient
): (target: CacheTarget) => Promise<boolean> {
	return async (target) => {
		try {
			await callInCache(client.get, target.cache, {});
			return true;
		} catch (error) {
			if (isRpcNotFoundError(error)) {
				return false;
			}

			throw error;
		}
	};
}

/**
 * Resolves a positional cache with the command's own cache-scoped authority.
 * The same credential is reused when the resolved target is the candidate
 * that the exact-cache lookup probed.
 */
export async function resolveAuthorisedCachePositionals(
	url: URL,
	positionals: readonly string[],
	authorisation: CacheTargetAuthorisation
): Promise<AuthorisedCachePositionals> {
	const credentials = new Map<string, Promise<AccessCredential>>();
	const credentialFor = (target: CacheTarget): Promise<AccessCredential> => {
		const key =
			target.cache.kind === 'default'
				? 'default'
				: `named:${target.cache.name}`;
		const existing = credentials.get(key);

		if (existing !== undefined) {
			return existing;
		}

		const credential = Promise.resolve(authorisation.authorise(target));
		credentials.set(key, credential);
		return credential;
	};
	const resolved = await resolveCachePositionals(url, positionals, {
		minimumPayload: authorisation.minimumPayload,
		...(authorisation.maximumPayload !== undefined && {
			maximumPayload: authorisation.maximumPayload
		}),
		payloadDescription: authorisation.payloadDescription,
		cacheExists: async (target) =>
			cacheExistsWith(
				tenantRpc(target.tenantUrl, {
					credential: await credentialFor(target),
					signal: authorisation.signal
				}).caches
			)(target)
	});

	return {
		...resolved,
		credential: await credentialFor(resolved.target)
	};
}
