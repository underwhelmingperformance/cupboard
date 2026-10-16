import type {
	CacheGeneration,
	CacheScope,
	NarInfoGeneration,
	NixSha256HashString,
	PredicateType,
	Sha256HexDigest,
	StorePathHash,
	TenantId
} from '@cupboard/nix-store/scalars';
import {
	and,
	asc,
	eq,
	exists,
	gt,
	isNull,
	ne,
	notExists,
	or,
	sql
} from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

import { jsonValueList } from '../do/json-list.ts';
import { SharedFactsUnavailableError } from '../errors.ts';
import type { R2ObjectKey } from '../http/http.ts';
import { narInfoReferenceQuery } from '../read/read.ts';

import { cacheIdentityCondition } from './cache.ts';
import * as schema from './d1-schema.ts';
import { readWithOneRetry } from './transient.ts';

export type AttestationListRevision = Readonly<
	typeof schema.attestationListRevision.$inferSelect
>;

export interface AttestationListIdentity {
	readonly cache: CacheScope;
	readonly storePathHash: StorePathHash;
	readonly generation: NarInfoGeneration;
}

export interface AttestationListParent {
	readonly cacheGeneration: CacheGeneration;
	readonly narHash: NixSha256HashString;
}

export interface AttestationListCursor {
	readonly predicateType: PredicateType;
	readonly digest: Sha256HexDigest;
}

export interface AttestationListEntry extends AttestationListCursor {
	readonly size: number | undefined;
}

export interface AttestationListPage {
	readonly entries: readonly AttestationListEntry[];
	readonly after: AttestationListCursor | undefined;
	readonly hasMore: boolean;
}

export type AttestationListReadState =
	| { readonly status: 'unavailable' | 'legacy' | 'pending' }
	| { readonly status: 'ready'; readonly key: R2ObjectKey | undefined };

export interface AttestationListPublication {
	readonly parent: AttestationListParent & {
		readonly generation: NarInfoGeneration;
	};
	readonly state: AttestationListReadState;
	readonly revision: number | undefined;
}

export const attestationListDescriptorsPerPage = 128;
const revisionsPerPage = 8;

// Drizzle leaves SQL selection aliases unqualified, even in joins.
const listParentColumns = {
	storePathHash: sql<StorePathHash>`"list_parent"."store_path_hash"`,
	generation: sql<NarInfoGeneration>`"list_parent"."generation"`,
	cacheGeneration: sql<CacheGeneration>`"list_parent"."cache_generation"`,
	narHash: sql<NixSha256HashString>`"list_parent"."nar_hash"`
};

export class AttestationListRevisionRepository {
	constructor(
		private readonly database: DrizzleD1Database<typeof schema>,
		private readonly tenant: TenantId
	) {}

	private activation() {
		return this.database
			.select({ one: sql`1` })
			.from(schema.deploymentTransition)
			.where(
				and(
					eq(schema.deploymentTransition.id, 'attestation-list-revision'),
					ne(schema.deploymentTransition.state, 'expanded')
				)
			);
	}

	private eligibleTenant() {
		const readerActivation = exists(this.activation());
		const tenantStatus = or(
			eq(schema.tenant.status, 'active'),
			eq(schema.tenant.status, 'suspended')
		);
		return this.database
			.select({ id: schema.tenant.id })
			.from(schema.tenant)
			.where(
				and(eq(schema.tenant.id, this.tenant), tenantStatus, readerActivation)
			);
	}

	private pendingCondition() {
		const revisions = schema.attestationListRevision;
		return or(
			isNull(revisions.publishedRevision),
			ne(revisions.publishedRevision, revisions.revision)
		);
	}

	private parentCondition(
		identity: AttestationListIdentity,
		parent: AttestationListParent
	) {
		return and(
			eq(listParentColumns.generation, identity.generation),
			eq(listParentColumns.cacheGeneration, parent.cacheGeneration),
			eq(listParentColumns.narHash, parent.narHash)
		);
	}

	private currentParentExists(
		identity: AttestationListIdentity,
		parent: AttestationListParent
	) {
		const current = narInfoReferenceQuery(
			this.database,
			this.tenant,
			identity.cache,
			jsonValueList([identity.storePathHash])
		).as('list_parent');
		return exists(
			this.database
				.select({ one: sql`1` })
				.from(current)
				.where(this.parentCondition(identity, parent))
		);
	}

	private stateFor(
		version: AttestationListRevision | null,
		parent: AttestationListParent
	): AttestationListReadState {
		if (version === null) {
			return { status: 'legacy' };
		}
		if (
			version.publishedRevision !== version.revision ||
			version.publishedCacheGeneration !== parent.cacheGeneration ||
			version.publishedNarHash !== parent.narHash
		) {
			return { status: 'pending' };
		}
		return { status: 'ready', key: version.publishedKey ?? undefined };
	}

	async canRefresh(): Promise<boolean> {
		const tenant = await this.eligibleTenant().get();
		return tenant !== undefined;
	}

	async publicationsFor(
		cache: CacheScope,
		hashes: readonly StorePathHash[]
	): Promise<ReadonlyMap<StorePathHash, AttestationListPublication>> {
		if (hashes.length === 0) {
			return new Map();
		}
		if (hashes.length > 32) {
			throw new RangeError(
				'A list-publication read accepts at most 32 store paths'
			);
		}
		const revisions = schema.attestationListRevision;
		const current = narInfoReferenceQuery(
			this.database,
			this.tenant,
			cache,
			jsonValueList(hashes)
		).as('list_parent');
		const activation = this.activation();
		const query = this.database
			.select({
				parent: listParentColumns,
				version: revisions,
				activated: exists(activation).mapWith(Boolean)
			})
			.from(current)
			.leftJoin(
				revisions,
				and(
					eq(revisions.tenant, this.tenant),
					cacheIdentityCondition(
						revisions.cacheKind,
						revisions.cacheName,
						cache
					),
					eq(revisions.storePathHash, listParentColumns.storePathHash),
					eq(revisions.generation, listParentColumns.generation)
				)
			);
		try {
			const rows = await readWithOneRetry(() => query.all());
			return new Map<StorePathHash, AttestationListPublication>(
				rows.map(({ parent, version, activated }) => [
					parent.storePathHash,
					{
						parent: {
							generation: parent.generation,
							cacheGeneration: parent.cacheGeneration,
							narHash: parent.narHash
						},
						state: activated
							? version === null
								? { status: 'pending' }
								: this.stateFor(version, parent)
							: { status: 'legacy' },
						revision: activated ? version?.revision : undefined
					}
				])
			);
		} catch (error) {
			throw new SharedFactsUnavailableError(error);
		}
	}

	async get(
		identity: AttestationListIdentity
	): Promise<AttestationListRevision | undefined> {
		const revisions = schema.attestationListRevision;
		return this.database
			.select()
			.from(revisions)
			.where(
				and(
					eq(revisions.tenant, this.tenant),
					cacheIdentityCondition(
						revisions.cacheKind,
						revisions.cacheName,
						identity.cache
					),
					eq(revisions.storePathHash, identity.storePathHash),
					eq(revisions.generation, identity.generation)
				)
			)
			.get();
	}

	async readState(
		identity: AttestationListIdentity,
		parent: AttestationListParent
	): Promise<AttestationListReadState> {
		const revisions = schema.attestationListRevision;
		const current = narInfoReferenceQuery(
			this.database,
			this.tenant,
			identity.cache,
			jsonValueList([identity.storePathHash])
		).as('list_parent');
		const result = await this.database
			.select({ version: revisions })
			.from(current)
			.leftJoin(
				revisions,
				and(
					eq(revisions.tenant, this.tenant),
					cacheIdentityCondition(
						revisions.cacheKind,
						revisions.cacheName,
						identity.cache
					),
					eq(revisions.storePathHash, listParentColumns.storePathHash),
					eq(revisions.generation, listParentColumns.generation)
				)
			)
			.where(this.parentCondition(identity, parent))
			.get();
		if (result === undefined) {
			return { status: 'unavailable' };
		}
		return this.stateFor(result.version, parent);
	}

	async pendingPage(
		after: number | undefined,
		limit: number
	): Promise<AttestationListRevision[]> {
		const revisions = schema.attestationListRevision;
		return this.database
			.select()
			.from(revisions)
			.where(
				and(
					eq(revisions.tenant, this.tenant),
					this.pendingCondition(),
					after === undefined ? undefined : gt(revisions.id, after)
				)
			)
			.orderBy(asc(revisions.id))
			.limit(Math.max(0, Math.min(limit, revisionsPerPage)))
			.all();
	}

	async descriptorPage(
		identity: AttestationListIdentity,
		after?: AttestationListCursor
	): Promise<AttestationListPage> {
		const references = schema.attestationReference;
		const candidates = this.database
			.select({
				digest: references.digest,
				predicateType: references.predicateType
			})
			.from(references)
			.where(
				and(
					eq(references.tenant, this.tenant),
					cacheIdentityCondition(
						references.cacheKind,
						references.cacheName,
						identity.cache
					),
					eq(references.storePathHash, identity.storePathHash),
					eq(references.generation, identity.generation),
					eq(references.readable, true),
					after === undefined
						? undefined
						: sql`(${references.predicateType}, ${references.digest}) > (${after.predicateType}, ${after.digest})`
				)
			)
			.orderBy(asc(references.predicateType), asc(references.digest))
			.limit(attestationListDescriptorsPerPage + 1)
			.as('list_reference_page');
		const rows = await this.database
			.select({
				digest: candidates.digest,
				predicateType: candidates.predicateType,
				size: schema.casObject.size
			})
			.from(candidates)
			.leftJoin(
				schema.casObject,
				eq(candidates.digest, schema.casObject.digest)
			)
			.orderBy(asc(candidates.predicateType), asc(candidates.digest))
			.all();
		const entries = rows
			.slice(0, attestationListDescriptorsPerPage)
			.map((row) => ({ ...row, size: row.size ?? undefined }));
		const last = entries.at(-1);
		return {
			entries,
			after:
				last === undefined
					? undefined
					: { predicateType: last.predicateType, digest: last.digest },
			hasMore: rows.length > attestationListDescriptorsPerPage
		};
	}

	async retire(
		captured: Pick<AttestationListRevision, 'id' | 'revision'>,
		identity: AttestationListIdentity
	): Promise<boolean> {
		const revisions = schema.attestationListRevision;
		const current = narInfoReferenceQuery(
			this.database,
			this.tenant,
			identity.cache,
			jsonValueList([identity.storePathHash])
		).as('list_parent');
		const parentExists = this.database
			.select({ one: sql`1` })
			.from(current)
			.where(eq(listParentColumns.generation, identity.generation));
		const removed = await this.database
			.delete(revisions)
			.where(
				and(
					eq(revisions.tenant, this.tenant),
					eq(revisions.id, captured.id),
					eq(revisions.revision, captured.revision),
					notExists(parentExists)
				)
			)
			.returning({ id: revisions.id })
			.all();
		return removed.length === 1;
	}

	async ensurePublications(
		cache: CacheScope,
		hashes: readonly StorePathHash[]
	): Promise<number> {
		if (hashes.length === 0) {
			return 0;
		}
		if (hashes.length > 32) {
			throw new RangeError(
				'Revision initialisation accepts at most 32 store paths'
			);
		}
		const current = narInfoReferenceQuery(
			this.database,
			this.tenant,
			cache,
			jsonValueList(hashes)
		).as('list_parent');
		const name = cache.kind === 'named' ? cache.name : sql`NULL`;
		const result = await this.database
			.run(sql`INSERT INTO attestation_list_revision
   (tenant, cache_kind, cache_name, store_path_hash, generation, revision, updated_at)
   SELECT ${this.tenant}, ${cache.kind}, ${name}, ${listParentColumns.storePathHash}, ${listParentColumns.generation}, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   FROM ${current} WHERE true ON CONFLICT DO NOTHING`);
		return result.meta.changes;
	}

	async invalidatePublication(
		cache: CacheScope,
		hash: StorePathHash,
		observed: AttestationListPublication
	): Promise<boolean> {
		if (
			observed.state.status !== 'ready' ||
			observed.state.key === undefined ||
			observed.revision === undefined
		) {
			return false;
		}
		const revisions = schema.attestationListRevision;
		const identity = {
			cache,
			storePathHash: hash,
			generation: observed.parent.generation
		};
		const parentIsCurrent = this.currentParentExists(identity, observed.parent);
		const updated = await this.database
			.update(revisions)
			.set({
				revision: sql`${revisions.revision} + 1`,
				updatedAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
			})
			.where(
				and(
					eq(revisions.tenant, this.tenant),
					cacheIdentityCondition(
						revisions.cacheKind,
						revisions.cacheName,
						cache
					),
					eq(revisions.storePathHash, hash),
					eq(revisions.generation, observed.parent.generation),
					eq(revisions.revision, observed.revision),
					eq(revisions.publishedRevision, observed.revision),
					eq(revisions.publishedKey, observed.state.key),
					eq(
						revisions.publishedCacheGeneration,
						observed.parent.cacheGeneration
					),
					eq(revisions.publishedNarHash, observed.parent.narHash),
					parentIsCurrent
				)
			)
			.returning({ id: revisions.id })
			.all();
		return updated.length === 1;
	}

	async publish(
		captured: Pick<AttestationListRevision, 'id' | 'revision'>,
		identity: AttestationListIdentity,
		parent: AttestationListParent,
		key: R2ObjectKey | undefined
	): Promise<boolean> {
		const revisions = schema.attestationListRevision;
		const current = narInfoReferenceQuery(
			this.database,
			this.tenant,
			identity.cache,
			jsonValueList([identity.storePathHash])
		).as('list_parent');
		const parentIsCurrent = exists(
			this.database
				.select({ one: sql`1` })
				.from(current)
				.where(this.parentCondition(identity, parent))
		);
		const samePublication =
			key === undefined
				? isNull(revisions.publishedKey)
				: eq(revisions.publishedKey, key);
		const tenantIsEligible = exists(this.eligibleTenant());
		const publicationAllowed = or(this.pendingCondition(), samePublication);
		const updated = await this.database
			.update(revisions)
			.set({
				publishedRevision: captured.revision,
				publishedCacheGeneration: parent.cacheGeneration,
				publishedNarHash: parent.narHash,
				publishedKey: key ?? sql`NULL`
			})
			.where(
				and(
					eq(revisions.id, captured.id),
					eq(revisions.tenant, this.tenant),
					cacheIdentityCondition(
						revisions.cacheKind,
						revisions.cacheName,
						identity.cache
					),
					eq(revisions.storePathHash, identity.storePathHash),
					eq(revisions.generation, identity.generation),
					eq(revisions.revision, captured.revision),
					publicationAllowed,
					tenantIsEligible,
					parentIsCurrent
				)
			)
			.returning({ id: revisions.id })
			.all();
		return updated.length === 1;
	}
}
