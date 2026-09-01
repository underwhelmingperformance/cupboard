import { CacheInfo } from '@cupboard/nix-store/cache-info';
import {
	type CacheAccessMode,
	type CacheGeneration,
	type CachePriority,
	cachePrioritySchema,
	type CacheReadRevision,
	type CacheScope,
	type GraceSeconds,
	type TtlSeconds
} from '@cupboard/nix-store/scalars';
import type {
	CacheLifecycleState,
	ManagedCacheGroupId,
	ManagedPolicyId,
	ManagedPolicyRevision
} from '@cupboard/protocol/managed-caches';
import type { IsoTimestamp } from '@cupboard/protocol/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { and, eq, isNull } from 'drizzle-orm';

import type { SchemaDatabase } from '../do/context.ts';
import {
	CacheAlreadyExistsError,
	CacheIdentityMissingError,
	CacheNotFoundError
} from '../errors.ts';

import {
	cacheIdentityCondition,
	cacheScopeFromRow,
	type ResolvedCache
} from './cache.ts';
import {
	firstCacheGeneration,
	firstCacheReadRevision
} from './cache-generation.ts';
import * as schema from './schema.ts';

interface CacheCreation {
	readonly access: CacheAccessMode;
	readonly priority: CachePriority;
	readonly generation: CacheGeneration;
	readonly readRevision: CacheReadRevision;
	readonly defaultRootTtlSeconds?: TtlSeconds;
	readonly graceSeconds?: GraceSeconds;
	readonly lifecycleState?: CacheLifecycleState;
	readonly creationExpiresAt?: IsoTimestamp;
	readonly management?:
		| { readonly kind: 'durable' }
		| {
				readonly kind: 'managed';
				readonly policyId: ManagedPolicyId;
				readonly policyRevision: ManagedPolicyRevision;
				readonly groupId: ManagedCacheGroupId;
				readonly leaseExpiresAt?: IsoTimestamp;
		  };
}

export class CacheRepository {
	constructor(private readonly database: SchemaDatabase) {}

	resolve(scope: CacheScope): ResolvedCache | undefined {
		const row = this.database
			.select({
				id: schema.caches.id,
				kind: schema.caches.kind,
				name: schema.caches.name,
				access: schema.caches.access,
				generation: schema.caches.generation,
				readRevision: schema.caches.readRevision
			})
			.from(schema.caches)
			.where(
				and(
					cacheIdentityCondition(schema.caches.kind, schema.caches.name, scope),
					isNull(schema.caches.deletedAt),
					eq(schema.caches.lifecycleState, 'active')
				)
			)
			.get();

		if (row === undefined) {
			return undefined;
		}

		return {
			id: row.id,
			scope: cacheScopeFromRow({ kind: row.kind, name: row.name }),
			access: row.access,
			generation: row.generation,
			readRevision: row.readRevision
		};
	}

	require(scope: CacheScope): ResolvedCache {
		const cache = this.resolve(scope);

		if (cache === undefined) {
			throw new CacheNotFoundError(scope);
		}

		return cache;
	}

	create(scope: CacheScope, configuration: CacheCreation): ResolvedCache {
		const selectionState: 'detached' | 'source-active' =
			configuration.lifecycleState === 'creating'
				? 'detached'
				: 'source-active';
		const created = this.database
			.insert(schema.caches)
			.values({
				kind: scope.kind,
				name: scope.kind === 'named' ? scope.name : undefined,
				access: configuration.access,
				priority: configuration.priority,
				generation: configuration.generation,
				readRevision: configuration.readRevision,
				defaultRootTtlSeconds: configuration.defaultRootTtlSeconds,
				graceSeconds: configuration.graceSeconds,
				lifecycleState: configuration.lifecycleState ?? 'active',
				creationExpiresAt: configuration.creationExpiresAt,
				managementKind: configuration.management?.kind ?? 'durable',
				...(configuration.management?.kind === 'managed' && {
					managedPolicyId: configuration.management.policyId,
					managedPolicyRevision: configuration.management.policyRevision,
					managedGroupId: configuration.management.groupId,
					leaseExpiresAt: configuration.management.leaseExpiresAt,
					selectionState
				}),
				createdAt: isoTimestamp(new Date())
			})
			.onConflictDoNothing()
			.returning({
				id: schema.caches.id,
				kind: schema.caches.kind,
				name: schema.caches.name,
				access: schema.caches.access,
				generation: schema.caches.generation,
				readRevision: schema.caches.readRevision
			})
			.all()
			.at(0);

		if (created === undefined) {
			throw new CacheAlreadyExistsError(scope);
		}

		return {
			id: created.id,
			scope: cacheScopeFromRow({ kind: created.kind, name: created.name }),
			access: created.access,
			generation: created.generation,
			readRevision: created.readRevision
		};
	}

	resolveOrCreate(scope: CacheScope, access: CacheAccessMode): ResolvedCache {
		const existing = this.resolve(scope);

		if (existing !== undefined) {
			return existing;
		}

		if (scope.kind === 'default') {
			throw new CacheIdentityMissingError(scope);
		}

		this.database
			.insert(schema.caches)
			.values({
				kind: 'named',
				name: scope.name,
				access,
				priority: cachePrioritySchema.parse(CacheInfo.default.priority),
				generation: firstCacheGeneration,
				readRevision: firstCacheReadRevision,
				createdAt: isoTimestamp(new Date())
			})
			.onConflictDoNothing()
			.run();

		return this.require(scope);
	}

	setAccess(
		cache: ResolvedCache,
		access: CacheAccessMode,
		readRevision: CacheReadRevision
	): ResolvedCache {
		if (cache.access === access && cache.readRevision === readRevision) {
			return cache;
		}

		this.database
			.update(schema.caches)
			.set({ access, readRevision })
			.where(eq(schema.caches.id, cache.id))
			.run();

		return { ...cache, access, readRevision };
	}

	scopeForId(id: ResolvedCache['id']): CacheScope {
		return this.resolvedForId(id).scope;
	}

	resolvedForId(id: ResolvedCache['id']): ResolvedCache {
		const row = this.database
			.select({
				id: schema.caches.id,
				kind: schema.caches.kind,
				name: schema.caches.name,
				access: schema.caches.access,
				generation: schema.caches.generation,
				readRevision: schema.caches.readRevision
			})
			.from(schema.caches)
			.where(eq(schema.caches.id, id))
			.get();

		if (row === undefined) {
			throw new CacheIdentityMissingError({ id });
		}

		return {
			id: row.id,
			scope: cacheScopeFromRow({ kind: row.kind, name: row.name }),
			access: row.access,
			generation: row.generation,
			readRevision: row.readRevision
		};
	}
}
