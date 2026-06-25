import { isImplicitPinName } from '@cupboard/nix-store/retention';
import { ttlSecondsSchema } from '@cupboard/nix-store/scalars';

import { ColdPathTtlConfigurationInvalidError } from '../errors.ts';

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

interface RootExpiryInput {
	readonly explicitTtlSeconds: number | undefined;
	readonly policyTtlSeconds: number | undefined;
	readonly name: string;
	readonly coldPathTtlSeconds: number | undefined;
	readonly now: Date;
}

/**
 * The expiry a root takes, as an ISO timestamp, or `undefined` for permanent.
 * Precedence: an explicit TTL wins, then a matching retention policy, then the
 * cold-path default for an implicit pin, and otherwise the root is permanent.
 */
export function resolveRootExpiry(input: RootExpiryInput): string | undefined {
	const ttl =
		input.explicitTtlSeconds ??
		input.policyTtlSeconds ??
		(isImplicitPinName(input.name) ? input.coldPathTtlSeconds : undefined);

	if (ttl === undefined) {
		return undefined;
	}

	const expiresAt = new Date(input.now.getTime() + ttl * 1000);
	return expiresAt.toISOString();
}
