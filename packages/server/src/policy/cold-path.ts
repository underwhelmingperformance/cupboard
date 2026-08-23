import { isImplicitPinName } from '@cupboard/nix-store/retention';
import { ttlSecondsSchema } from '@cupboard/nix-store/scalars';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';

import { ColdPathTtlConfigurationInvalidError } from '../errors.ts';

interface ColdPathEnv {
	readonly CUPBOARD_COLD_PATH_TTL_SECONDS: string;
}

/**
 * Parses `CUPBOARD_COLD_PATH_TTL_SECONDS`. An empty setting keeps implicit pins
 * permanently; a non-empty setting must be a valid TTL.
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
 * Uses the first available TTL from the explicit request, a matching retention
 * policy, or the cold-path default for an implicit pin. Returns `undefined`
 * when the root is permanent.
 */
export function resolveRootExpiry(
	input: RootExpiryInput
): IsoTimestamp | undefined {
	const ttl =
		input.explicitTtlSeconds ??
		input.policyTtlSeconds ??
		(isImplicitPinName(input.name) ? input.coldPathTtlSeconds : undefined);

	if (ttl === undefined) {
		return undefined;
	}

	return isoTimestamp(new Date(input.now.getTime() + ttl * 1000));
}
