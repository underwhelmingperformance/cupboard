import {
	type AuthorizationDetails,
	authorizationDetailsInSelectorSpelling,
	type PermittedGrant,
	permittedGrantsInSelectorSpelling,
	storedAuthorizationDetailsSchema,
	storedPermittedGrantsSchema
} from '@cupboard/protocol/grants';

import { type ServerContext } from './context.ts';

/**
 * Spells the grants a tenant stores: the cache bindings of its trust rules
 * and the issued grants its refresh-token families record.
 *
 * Until a deploy records `contracted`, a rollback can restore the preceding
 * build, which strictly parses cache selectors in stored grants. A row in the
 * scope spelling fails that build's parse: every token exchange under such a
 * rule is refused, and a refresh under such a family revokes it. So below
 * `contracted` a grant is stored in the selector spelling, derived from the
 * scope and the access the cache has now; `storedPermittedGrantsSchema` and
 * `storedAuthorizationDetailsSchema` read either spelling. From `contracted`
 * on, the scope spelling is stored.
 *
 * The gate answers from a reading up to `phaseCacheMs` old, so the selector
 * spelling can still be written until the local contraction finishes. The
 * synchronous write methods check that state again because a prepared value
 * can cross the contraction while its caller awaits another operation.
 */
export class StoredGrantSpelling {
	constructor(private readonly context: ServerContext) {}

	permittedGrantsForWrite(prepared: string): string {
		return this.context.grantsContracted
			? JSON.stringify(storedPermittedGrantsSchema.parse(JSON.parse(prepared)))
			: prepared;
	}

	authorizationDetailsForWrite(prepared: string): string {
		return this.context.grantsContracted
			? JSON.stringify(
					storedAuthorizationDetailsSchema.parse(JSON.parse(prepared))
				)
			: prepared;
	}

	async permittedGrantsJson(
		grants: readonly PermittedGrant[]
	): Promise<string> {
		if (await this.context.phases.hasReached('contracted')) {
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

	async authorizationDetailsJson(
		grants: AuthorizationDetails
	): Promise<string> {
		if (await this.context.phases.hasReached('contracted')) {
			return JSON.stringify(grants);
		}

		return JSON.stringify(
			authorizationDetailsInSelectorSpelling(
				grants,
				(name) =>
					this.context.cacheRepository.resolve({ kind: 'named', name })?.access
			)
		);
	}
}
