import {
	type Sha256HexDigest,
	type TenantId
} from '@cupboard/nix-store/scalars';
import {
	and,
	eq,
	notExists,
	type SQL,
	sql,
	type SQLWrapper
} from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from './d1-schema.ts';
import { readRecordedTransitions } from './deployment-transitions.ts';

export type CasReferenceKinds = 'attestations' | 'artifacts' | 'all';

/**
 * Retention predicates for the reference kinds installed in the shared store.
 * These queries do not grant access to a cache or to object bytes.
 */
export class CasReferenceSet {
	constructor(
		private readonly database: DrizzleD1Database<typeof d1Schema>,
		readonly kinds: CasReferenceKinds
	) {}

	private artifactStorageAbsent(): SQL {
		return notExists(
			this.database
				.select({ one: sql`1` })
				.from(d1Schema.deploymentTransition)
				.where(eq(d1Schema.deploymentTransition.id, 'native-artifact-storage'))
		);
	}

	private outputStorageAbsent(): SQL {
		return notExists(
			this.database
				.select({ one: sql`1` })
				.from(d1Schema.deploymentTransition)
				.where(
					eq(
						d1Schema.deploymentTransition.id,
						'shared-listing-output-retention'
					)
				)
		);
	}

	/**
	 * Refuses an attestation-only mutation after artifact storage expands.
	 */
	mutationFence(): SQL | undefined {
		return this.kinds === 'attestations'
			? this.artifactStorageAbsent()
			: undefined;
	}

	artifactReferencesAbsent(tenant: TenantId): SQL {
		if (this.kinds === 'attestations') {
			return this.artifactStorageAbsent();
		}

		return notExists(
			this.database
				.select({ one: sql`1` })
				.from(d1Schema.artifactReference)
				.where(eq(d1Schema.artifactReference.tenant, tenant))
		);
	}

	unreferenced(digest: Sha256HexDigest | SQLWrapper, tenant?: TenantId): SQL {
		const attestationFilter = and(
			eq(d1Schema.attestationReference.digest, digest),
			tenant === undefined
				? undefined
				: eq(d1Schema.attestationReference.tenant, tenant)
		);
		const attestationMissing = notExists(
			this.database
				.select({ one: sql`1` })
				.from(d1Schema.attestationReference)
				.where(attestationFilter)
		);

		if (this.kinds === 'attestations') {
			return sql`(${attestationMissing} AND ${this.artifactStorageAbsent()})`;
		}

		const artifactFilter = and(
			eq(d1Schema.artifactReference.digest, digest),
			tenant === undefined
				? undefined
				: eq(d1Schema.artifactReference.tenant, tenant)
		);
		const artifactMissing = notExists(
			this.database
				.select({ one: sql`1` })
				.from(d1Schema.artifactReference)
				.where(artifactFilter)
		);

		const tenantUnreferenced = sql`(${attestationMissing} AND ${artifactMissing})`;
		if (tenant !== undefined) {
			return tenantUnreferenced;
		}
		if (this.kinds === 'artifacts') {
			return sql`(${tenantUnreferenced} AND ${this.outputStorageAbsent()})`;
		}
		const outputMissing = notExists(
			this.database
				.select({ one: sql`1` })
				.from(d1Schema.sharedListingOutputReference)
				.where(eq(d1Schema.sharedListingOutputReference.digest, digest))
		);
		return sql`(${tenantUnreferenced} AND ${outputMissing})`;
	}
}

/**
 * Reads deployment state before a retention mutation. A cached pre-expansion
 * reading could omit references after another Worker starts publishing them.
 */
export async function readCasReferenceSet(
	database: DrizzleD1Database<typeof d1Schema>
): Promise<CasReferenceSet> {
	const transitions = await readRecordedTransitions(database);
	const state = transitions.get('native-artifact-storage');

	if (state !== 'expanded' && state !== 'complete') {
		return new CasReferenceSet(database, 'attestations');
	}
	const outputState = transitions.get('shared-listing-output-retention');
	return new CasReferenceSet(
		database,
		outputState === 'expanded' || outputState === 'complete'
			? 'all'
			: 'artifacts'
	);
}
