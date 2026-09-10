import type {
	GracePolicyListResponse,
	GracePolicyRemoveResponse,
	RetentionPolicyListResponse,
	RetentionPolicyRemoveResponse,
	RetentionPolicySummary
} from '@cupboard/protocol/retention';
import { asc, eq } from 'drizzle-orm';

import * as schema from '../db/schema.ts';
import { StoredRetentionPolicyInvalidError } from '../errors.ts';

import type { ServerContext } from './context.ts';

export class LegacyRetentionService {
	constructor(private readonly context: ServerContext) {}

	private isComplete(): boolean {
		return (
			this.context.db
				.select({ status: schema.retentionMigrationState.status })
				.from(schema.retentionMigrationState)
				.where(eq(schema.retentionMigrationState.id, 1))
				.get()?.status === 'complete'
		);
	}

	private removeFrom(
		id: string,
		table:
			| typeof schema.legacyRetentionPolicies
			| typeof schema.legacyRetentionGracePolicies
	): Promise<RetentionPolicyRemoveResponse> {
		return this.context.criticalSection(() => {
			if (this.isComplete()) {
				return Promise.resolve({ id, removed: false });
			}
			return Promise.resolve(
				this.context.db.transaction((tx) => {
					const isRemoved =
						tx
							.delete(table)
							.where(eq(table.id, id))
							.returning({ id: table.id })
							.all().length > 0;
					if (isRemoved) {
						tx.delete(schema.retentionMigrationRules).run();
						tx.delete(schema.retentionMigrationState).run();
						tx.insert(schema.retentionMigrationState).values({ id: 1 }).run();
					}
					return { id, removed: isRemoved };
				})
			);
		});
	}

	list(): RetentionPolicyListResponse {
		if (this.isComplete()) {
			return { policies: [] };
		}

		const rows = this.context.db
			.select({
				id: schema.legacyRetentionPolicies.id,
				kind: schema.legacyRetentionPolicies.kind,
				cacheId: schema.legacyRetentionPolicies.cacheId,
				rootNamePrefix: schema.legacyRetentionPolicies.rootNamePrefix,
				ttlSeconds: schema.legacyRetentionPolicies.defaultTtlSeconds
			})
			.from(schema.legacyRetentionPolicies)
			.orderBy(asc(schema.legacyRetentionPolicies.id))
			.all();

		return {
			policies: rows.map((row): RetentionPolicySummary => {
				if (row.kind === 'root-name-prefix' && row.rootNamePrefix !== null) {
					return {
						id: row.id,
						scope: 'root-name-prefix',
						pattern: row.rootNamePrefix,
						ttlSeconds: row.ttlSeconds
					};
				}

				if (row.kind === 'cache' && row.cacheId !== null) {
					return {
						id: row.id,
						scope: 'cache',
						cache: this.context.cacheRepository.scopeForId(row.cacheId),
						ttlSeconds: row.ttlSeconds
					};
				}

				throw new StoredRetentionPolicyInvalidError(row.id);
			})
		};
	}

	graceList(): GracePolicyListResponse {
		if (this.isComplete()) {
			return { policies: [] };
		}

		return {
			policies: this.context.db
				.select()
				.from(schema.legacyRetentionGracePolicies)
				.orderBy(asc(schema.legacyRetentionGracePolicies.cachePrefix))
				.all()
		};
	}

	remove(id: string): Promise<RetentionPolicyRemoveResponse> {
		return this.removeFrom(id, schema.legacyRetentionPolicies);
	}

	graceRemove(id: string): Promise<GracePolicyRemoveResponse> {
		return this.removeFrom(id, schema.legacyRetentionGracePolicies);
	}
}
