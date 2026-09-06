import {
	type AuthorizationDetails,
	authorizationDetailsInSelectorSpelling,
	type PermittedGrant,
	permittedGrantsInSelectorSpelling
} from '@cupboard/protocol/grants';

import { CacheRepository } from '../db/cache-repository.ts';

import { type ServerContext } from './context.ts';

/**
 * Spells the grants a tenant stores: the cache bindings of its trust rules
 * and the issued grants its refresh-token families record.
 *
 * Until a deploy records `contracted`, a rollback lands on a build that parses
 * a stored grant strictly and names a cache by its selector. A row in the
 * scope spelling fails that build's parse: every token exchange under such a
 * rule is refused, and a refresh under such a family revokes it. So below
 * `contracted` a grant is stored in the selector spelling, derived from the
 * scope and the access the cache has now; `storedPermittedGrantsSchema` and
 * `storedAuthorizationDetailsSchema` read either spelling. From `contracted`
 * on, the scope spelling is stored.
 *
 * The gate answers from a reading up to `phaseCacheMs` old, so the selector
 * spelling can still be written for that long after `contracted` is recorded.
 */
export class StoredGrantSpelling {
	private readonly identities: CacheRepository;

	constructor(private readonly context: ServerContext) {
		this.identities = new CacheRepository(context.db);
	}

	async permittedGrantsJson(
		grants: readonly PermittedGrant[]
	): Promise<string> {
		if (await this.context.phases.hasReached('contracted')) {
			return JSON.stringify(grants);
		}

		return JSON.stringify(
			permittedGrantsInSelectorSpelling(grants, (name) =>
				this.identities.liveAccess({ kind: 'named', name })
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
			authorizationDetailsInSelectorSpelling(grants, (name) =>
				this.identities.liveAccess({ kind: 'named', name })
			)
		);
	}
}
