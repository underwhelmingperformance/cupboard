import type { TtlSeconds } from '@cupboard/nix-store/scalars';
import type { RootRetentionRequest } from '@cupboard/protocol/retention';

import { RootRetentionOptionConflictError } from '../errors.ts';

export function rootRetentionChoice(
	ttl: TtlSeconds | undefined,
	permanent: boolean | undefined
): RootRetentionRequest {
	if (ttl !== undefined && permanent === true) {
		throw new RootRetentionOptionConflictError();
	}
	if (ttl !== undefined) {
		return { kind: 'duration', seconds: ttl };
	}
	return { kind: permanent === true ? 'permanent' : 'inherit' };
}
