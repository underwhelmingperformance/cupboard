import {
	type PermittedGrant,
	permittedGrantsInSelectorSpelling,
	storedPermittedGrantsSchema
} from '@cupboard/protocol/grants';

import { type ServerContext } from './context.ts';

/**
 * Stores trust-rule grants in the selector spelling until the cache-identity
 * transition permits the scope spelling.
 */
export class StoredGrantSpelling {
	constructor(private readonly context: ServerContext) {}

	permittedGrantsForWrite(prepared: string): string {
		return this.context.grantsContracted
			? JSON.stringify(storedPermittedGrantsSchema.parse(JSON.parse(prepared)))
			: prepared;
	}

	async permittedGrantsJson(
		grants: readonly PermittedGrant[]
	): Promise<string> {
		if (
			await this.context.transitions.hasReached('cache-identity', 'complete')
		) {
			return JSON.stringify(grants);
		}

		return JSON.stringify(
			permittedGrantsInSelectorSpelling(
				grants,
				(name) =>
					this.context.cacheRepository.resolve({ kind: 'named', name })?.access
			)
		);
	}
}
