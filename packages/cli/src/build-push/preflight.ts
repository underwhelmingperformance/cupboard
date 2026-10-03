import {
	type BuildObservationPreflight,
	type BuildObservationPreflightOptions,
	preflightBuildObservation
} from '@cupboard/nix/build-observation';
import type { CacheScope, RootName } from '@cupboard/nix-store/scalars';
import {
	type AuthorizationDetail,
	isCoveredByToken,
	type Operation
} from '@cupboard/protocol/grants';

import { MissingGrantError } from '../errors.ts';

export interface BuildPushPreflightOptions extends BuildObservationPreflightOptions {
	readonly grants: readonly AuthorizationDetail[];
	readonly cache: CacheScope;
	readonly runRoot?: RootName;
	readonly targetRoots?: readonly RootName[];
}

export type BuildPushPreflight = BuildObservationPreflight;

function requireGrant(
	grants: readonly AuthorizationDetail[],
	operation: Operation,
	cache: CacheScope,
	root: RootName
): void {
	if (isCoveredByToken(grants, operation, { cache, root })) {
		return;
	}

	throw new MissingGrantError(operation, root);
}

export async function preflightBuildPush(
	options: BuildPushPreflightOptions
): Promise<BuildPushPreflight> {
	const preflight = await preflightBuildObservation(options);

	if (options.runRoot !== undefined) {
		requireGrant(options.grants, 'root:attach', options.cache, options.runRoot);
	}

	const targetRoots = options.targetRoots ?? [];

	for (const targetRoot of targetRoots) {
		requireGrant(options.grants, 'root:set', options.cache, targetRoot);
	}

	return preflight;
}
