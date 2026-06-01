import { isImplicitPinName, ttlSecondsSchema } from '@cupboard/shared';

import { ColdPathTtlConfigurationInvalidError } from './errors.ts';

interface ColdPathEnv {
	readonly CUPBOARD_COLD_PATH_TTL_SECONDS: string;
}

/**
 * The configured cold-path TTL in seconds, or `undefined` when implicit pins
 * are permanent. An empty (or absent) variable means permanent; any other value
 * must be a valid TTL, otherwise the deployment is misconfigured.
 */
export function coldPathTtlSeconds(env: ColdPathEnv): number | undefined {
	const raw = env.CUPBOARD_COLD_PATH_TTL_SECONDS;

	if (!raw) {
		return undefined;
	}

	const result = ttlSecondsSchema.safeParse(Number(raw));

	if (!result.success) {
		throw new ColdPathTtlConfigurationInvalidError(raw);
	}

	return result.data;
}

interface ColdPathExpiryInput {
	readonly explicitTtlSeconds: number | undefined;
	readonly name: string;
	readonly coldPathTtlSeconds: number | undefined;
	readonly now: Date;
}

/**
 * The expiry a root takes, as an ISO timestamp, or `undefined` for permanent.
 * An explicit TTL always wins; otherwise an implicit pin inherits the cold-path
 * default when one is configured, and everything else stays permanent.
 */
export function resolveColdPathExpiry(
	input: ColdPathExpiryInput
): string | undefined {
	const ttl =
		input.explicitTtlSeconds ??
		(isImplicitPinName(input.name) ? input.coldPathTtlSeconds : undefined);

	if (ttl === undefined) {
		return undefined;
	}

	return new Date(input.now.getTime() + ttl * 1000).toISOString();
}
