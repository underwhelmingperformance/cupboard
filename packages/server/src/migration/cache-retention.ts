import {
	graceSecondsSchema,
	rootNameSchema,
	ttlSecondsSchema
} from '@cupboard/nix-store/scalars';
import type { RootRetentionOverride } from '@cupboard/protocol/caches';
import { and, asc, eq, gt, inArray, isNull, type SQL, sql } from 'drizzle-orm';

import { cacheIdSchema } from '../db/cache.ts';
import * as schema from '../db/schema.ts';
import type { SchemaDatabase } from '../do/context.ts';
import { ensureRetentionRuleSet } from '../do/retention-rule-service.ts';

export const retentionMigrationBatchSize = 50;
export const maximumLegacyRetentionRules = 4096;

export type CacheRetentionMigrationOutcome =
	| { readonly status: 'pending' }
	| {
			readonly status: 'complete';
			readonly discardedRuleCount: number;
	  };

export class CacheRetentionMigrationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CacheRetentionMigrationError';
	}
}

function validateBatchSize(batchSize: number): void {
	if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
		throw new CacheRetentionMigrationError(
			'The cache retention migration batch size must be a positive integer'
		);
	}
}

function graceForCache(
	cache: Pick<typeof schema.caches.$inferSelect, 'kind' | 'name' | 'access'>,
	policies: readonly (typeof schema.legacyRetentionGracePolicies.$inferSelect)[]
): (typeof schema.caches.$inferInsert)['graceSeconds'] | SQL<null> {
	if (cache.access === 'private') {
		return sql<null>`null`;
	}

	const cacheName = cache.kind === 'default' ? '' : cache.name;
	const match = policies
		.filter((policy) => cacheName?.startsWith(policy.cachePrefix) === true)
		.toSorted(
			(left, right) => right.cachePrefix.length - left.cachePrefix.length
		)
		.at(0);

	return match === undefined
		? sql<null>`null`
		: graceSecondsSchema.parse(match.graceSeconds);
}

async function advanceRules(
	database: SchemaDatabase,
	ruleCursor: string | null,
	discardedRuleCount: number,
	batchSize: number
): Promise<CacheRetentionMigrationOutcome | undefined> {
	const rows = database
		.select({
			id: schema.legacyRetentionPolicies.id,
			rootPrefix: schema.legacyRetentionPolicies.rootNamePrefix,
			ttlSeconds: schema.legacyRetentionPolicies.defaultTtlSeconds
		})
		.from(schema.legacyRetentionPolicies)
		.where(
			and(
				eq(schema.legacyRetentionPolicies.kind, 'root-name-prefix'),
				...(ruleCursor === null
					? []
					: [gt(schema.legacyRetentionPolicies.id, ruleCursor)])
			)
		)
		.orderBy(asc(schema.legacyRetentionPolicies.id))
		.limit(batchSize)
		.all();
	let discarded = 0;

	database.transaction((tx) => {
		for (const row of rows) {
			const rootPrefix = rootNameSchema.safeParse(row.rootPrefix);
			const ttlSeconds = ttlSecondsSchema.safeParse(row.ttlSeconds);

			if (!rootPrefix.success || !ttlSeconds.success) {
				discarded += 1;
				continue;
			}

			tx.insert(schema.retentionMigrationRules)
				.values({
					sourceId: row.id,
					rootPrefix: rootPrefix.data,
					ttlSeconds: ttlSeconds.data
				})
				.onConflictDoNothing()
				.run();
		}

		const last = rows.at(-1);

		if (last !== undefined) {
			tx.update(schema.retentionMigrationState)
				.set({
					ruleCursor: last.id,
					discardedRuleCount: discardedRuleCount + discarded
				})
				.where(eq(schema.retentionMigrationState.id, 1))
				.run();
		}
	});

	const stagedCount = await database.$count(schema.retentionMigrationRules);

	if (
		stagedCount + discardedRuleCount + discarded >
		maximumLegacyRetentionRules
	) {
		throw new CacheRetentionMigrationError(
			`The tenant has more than ${maximumLegacyRetentionRules.toString()} legacy retention rules`
		);
	}

	if (rows.length === batchSize) {
		return { status: 'pending' };
	}

	const rules = database
		.select({
			rootPrefix: schema.retentionMigrationRules.rootPrefix,
			ttlSeconds: schema.retentionMigrationRules.ttlSeconds
		})
		.from(schema.retentionMigrationRules)
		.orderBy(asc(schema.retentionMigrationRules.rootPrefix))
		.all()
		.map((row): RootRetentionOverride => ({
			rootPrefix: row.rootPrefix,
			retention: { kind: 'duration', seconds: row.ttlSeconds }
		}));
	const ruleSetId = await ensureRetentionRuleSet(database, rules);

	database
		.update(schema.retentionMigrationState)
		.set({ ruleSetId, ruleCursor: sql`null` })
		.where(eq(schema.retentionMigrationState.id, 1))
		.run();

	return undefined;
}

function advanceCaches(
	database: SchemaDatabase,
	ruleSetId: NonNullable<
		(typeof schema.retentionMigrationState.$inferSelect)['ruleSetId']
	>,
	cacheCursor: number,
	batchSize: number
): CacheRetentionMigrationOutcome {
	const afterCacheId =
		cacheCursor === 0 ? undefined : cacheIdSchema.parse(cacheCursor);
	const cursorConditions =
		afterCacheId === undefined ? [] : [gt(schema.caches.id, afterCacheId)];
	const caches = database
		.select({
			id: schema.caches.id,
			kind: schema.caches.kind,
			name: schema.caches.name,
			access: schema.caches.access
		})
		.from(schema.caches)
		.where(and(...cursorConditions, isNull(schema.caches.deletedAt)))
		.orderBy(asc(schema.caches.id))
		.limit(batchSize)
		.all();
	const cacheIds = caches.map((cache) => cache.id);
	const defaults =
		cacheIds.length === 0
			? []
			: database
					.select({
						cacheId: schema.legacyRetentionPolicies.cacheId,
						ttlSeconds: schema.legacyRetentionPolicies.defaultTtlSeconds
					})
					.from(schema.legacyRetentionPolicies)
					.where(
						and(
							eq(schema.legacyRetentionPolicies.kind, 'cache'),
							inArray(schema.legacyRetentionPolicies.cacheId, cacheIds)
						)
					)
					.all();
	const gracePolicies = database
		.select()
		.from(schema.legacyRetentionGracePolicies)
		.limit(maximumLegacyRetentionRules + 1)
		.all();

	if (gracePolicies.length > maximumLegacyRetentionRules) {
		throw new CacheRetentionMigrationError(
			`The tenant has more than ${maximumLegacyRetentionRules.toString()} legacy grace rules`
		);
	}

	database.transaction((tx) => {
		for (const cache of caches) {
			const configuredDefault = defaults.find(
				(candidate) => candidate.cacheId === cache.id
			);

			tx.update(schema.caches)
				.set({
					rootRetentionRuleSetId: ruleSetId,
					defaultRootTtlSeconds:
						configuredDefault === undefined
							? sql`null`
							: ttlSecondsSchema.parse(configuredDefault.ttlSeconds),
					graceSeconds: graceForCache(cache, gracePolicies)
				})
				.where(eq(schema.caches.id, cache.id))
				.run();
		}

		const last = caches.at(-1);

		if (last !== undefined) {
			tx.update(schema.retentionMigrationState)
				.set({ cacheCursor: last.id })
				.where(eq(schema.retentionMigrationState.id, 1))
				.run();
		}
	});

	if (caches.length === batchSize) {
		return { status: 'pending' };
	}

	const state = database
		.update(schema.retentionMigrationState)
		.set({ status: 'complete' })
		.where(eq(schema.retentionMigrationState.id, 1))
		.returning({
			discardedRuleCount: schema.retentionMigrationState.discardedRuleCount
		})
		.get();

	database.delete(schema.retentionMigrationRules).run();

	return {
		status: 'complete',
		discardedRuleCount: state.discardedRuleCount
	};
}

/**
 * Advances one bounded batch of the legacy retention migration.
 *
 * Prefix rules are imported once into an immutable shared rule set. Cache
 * defaults and grace settings are then copied in cache-ID order, which avoids
 * storing one copy of every prefix rule for every cache.
 */
export async function advanceCacheRetentionMigration(
	database: SchemaDatabase,
	batchSize = retentionMigrationBatchSize
): Promise<CacheRetentionMigrationOutcome> {
	validateBatchSize(batchSize);

	database
		.insert(schema.retentionMigrationState)
		.values({ id: 1 })
		.onConflictDoNothing()
		.run();

	let state = database
		.select()
		.from(schema.retentionMigrationState)
		.where(eq(schema.retentionMigrationState.id, 1))
		.get();

	if (state === undefined) {
		throw new CacheRetentionMigrationError(
			'The cache retention migration state was not created'
		);
	}

	if (state.status === 'complete') {
		return {
			status: 'complete',
			discardedRuleCount: state.discardedRuleCount
		};
	}

	if (state.ruleSetId === null) {
		const outcome = await advanceRules(
			database,
			state.ruleCursor,
			state.discardedRuleCount,
			batchSize
		);

		if (outcome !== undefined) {
			return outcome;
		}

		state = database
			.select()
			.from(schema.retentionMigrationState)
			.where(eq(schema.retentionMigrationState.id, 1))
			.get();

		if (state === undefined) {
			throw new CacheRetentionMigrationError(
				'The cache retention migration state disappeared while importing rules'
			);
		}
	}

	if (state.ruleSetId === null) {
		throw new CacheRetentionMigrationError(
			'The retention rule set was not recorded after importing the legacy rules'
		);
	}

	return advanceCaches(database, state.ruleSetId, state.cacheCursor, batchSize);
}
