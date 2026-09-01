import {
	type RootName,
	type Sha256HexDigest,
	sha256HexDigestSchema,
	ttlSecondsSchema
} from '@cupboard/nix-store/scalars';
import {
	type CacheRootRetention,
	type RootRetentionOverride
} from '@cupboard/protocol/caches';
import { eq } from 'drizzle-orm';

import { sha256Hex } from '../crypto/crypto.ts';
import type { ResolvedCache } from '../db/cache.ts';
import { rootRetentionRuleSetIdSchema } from '../db/retention-rule.ts';
import * as schema from '../db/schema.ts';

import type { SchemaWriter, ServerContext } from './context.ts';

const encoder = new TextEncoder();

export type RetentionRuleDigest = (value: string) => Promise<Sha256HexDigest>;

function compareUtf8(left: string, right: string): number {
	const leftBytes = encoder.encode(left);
	const rightBytes = encoder.encode(right);
	const length = Math.min(leftBytes.length, rightBytes.length);

	for (let index = 0; index < length; index += 1) {
		const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);

		if (difference !== 0) {
			return difference;
		}
	}

	return leftBytes.length - rightBytes.length;
}

export function canonicalRetentionRules(
	rules: readonly RootRetentionOverride[]
): readonly RootRetentionOverride[] {
	return [...rules].toSorted((left, right) =>
		compareUtf8(left.rootPrefix, right.rootPrefix)
	);
}

export function serialiseRetentionRules(
	rules: readonly RootRetentionOverride[]
): string {
	return JSON.stringify(
		canonicalRetentionRules(rules).map((rule) => [
			rule.rootPrefix,
			rule.retention.kind,
			rule.retention.kind === 'duration' ? rule.retention.seconds : undefined
		])
	);
}

function listRules(
	database: SchemaWriter,
	ruleSetId: (typeof schema.rootRetentionRuleSets.$inferSelect)['id']
): readonly RootRetentionOverride[] {
	return database
		.select({
			rootPrefix: schema.rootRetentionRules.rootPrefix,
			kind: schema.rootRetentionRules.kind,
			seconds: schema.rootRetentionRules.ttlSeconds
		})
		.from(schema.rootRetentionRules)
		.where(eq(schema.rootRetentionRules.ruleSetId, ruleSetId))
		.all()
		.map((row): RootRetentionOverride => {
			if (row.kind === 'permanent') {
				return {
					rootPrefix: row.rootPrefix,
					retention: { kind: 'permanent' }
				};
			}

			return {
				rootPrefix: row.rootPrefix,
				retention: {
					kind: 'duration',
					seconds: ttlSecondsSchema.parse(row.seconds)
				}
			};
		})
		.toSorted((left, right) => compareUtf8(left.rootPrefix, right.rootPrefix));
}

export async function ensureRetentionRuleSet(
	database: ServerContext['db'],
	rules: readonly RootRetentionOverride[],
	digest: RetentionRuleDigest = async (value) =>
		sha256HexDigestSchema.parse(await sha256Hex(value))
): Promise<(typeof schema.rootRetentionRuleSets.$inferSelect)['id']> {
	const canonical = canonicalRetentionRules(rules);
	const serialised = serialiseRetentionRules(canonical);
	const contentHash = await digest(serialised);

	return database.transaction((tx) => {
		const candidates = tx
			.select({ id: schema.rootRetentionRuleSets.id })
			.from(schema.rootRetentionRuleSets)
			.where(eq(schema.rootRetentionRuleSets.contentHash, contentHash))
			.all();
		const matching = candidates.find(
			(candidate) =>
				serialiseRetentionRules(listRules(tx, candidate.id)) === serialised
		);

		if (matching !== undefined) {
			return matching.id;
		}

		const ruleSetId = rootRetentionRuleSetIdSchema.parse(
			tx
				.insert(schema.rootRetentionRuleSets)
				.values({ contentHash })
				.returning({ id: schema.rootRetentionRuleSets.id })
				.get().id
		);

		if (canonical.length > 0) {
			tx.insert(schema.rootRetentionRules)
				.values(
					canonical.map((rule) => ({
						ruleSetId,
						rootPrefix: rule.rootPrefix,
						kind: rule.retention.kind,
						ttlSeconds:
							rule.retention.kind === 'duration'
								? rule.retention.seconds
								: undefined
					}))
				)
				.run();
		}

		return ruleSetId;
	});
}

export class RetentionRuleService {
	constructor(private readonly context: ServerContext) {}

	private async bind(
		cache: ResolvedCache,
		rules: readonly RootRetentionOverride[]
	): Promise<void> {
		const ruleSetId = await ensureRetentionRuleSet(this.context.db, rules);

		this.context.db
			.update(schema.caches)
			.set({ rootRetentionRuleSetId: ruleSetId })
			.where(eq(schema.caches.id, cache.id))
			.run();
	}

	listForRuleSet(
		ruleSetId: (typeof schema.caches.$inferSelect)['rootRetentionRuleSetId']
	): readonly RootRetentionOverride[] {
		return listRules(this.context.db, ruleSetId);
	}

	listForCache(cache: ResolvedCache): readonly RootRetentionOverride[] {
		const row = this.context.db
			.select({ ruleSetId: schema.caches.rootRetentionRuleSetId })
			.from(schema.caches)
			.where(eq(schema.caches.id, cache.id))
			.get();

		return row === undefined ? [] : this.listForRuleSet(row.ruleSetId);
	}

	async setRule(
		cache: ResolvedCache,
		rootPrefix: RootName,
		retention: CacheRootRetention
	): Promise<void> {
		const current = this.listForCache(cache).filter(
			(rule) => rule.rootPrefix !== rootPrefix
		);

		await this.bind(cache, [...current, { rootPrefix, retention }]);
	}

	async removeRule(cache: ResolvedCache, rootPrefix: RootName): Promise<void> {
		await this.bind(
			cache,
			this.listForCache(cache).filter((rule) => rule.rootPrefix !== rootPrefix)
		);
	}
}
