import type { NixValidPathInfo } from '@cupboard/nix';
import type { UploadDecision } from '@cupboard/protocol/upload';

import { BuildOutputDivergedError } from '../errors.ts';
import { narDivergence } from '../push/divergence.ts';

type SkipDecision = Extract<UploadDecision, { action: 'skip' }>;

export function requireMatchingBuildOutput(
	info: NixValidPathInfo,
	decision: SkipDecision
): void {
	const divergent = narDivergence(
		info.storePath,
		info.narHash.toString(),
		decision.narHash
	);

	if (divergent === undefined) {
		return;
	}

	throw new BuildOutputDivergedError(
		divergent.storePath,
		divergent.localNarHash,
		divergent.cacheNarHash
	);
}
