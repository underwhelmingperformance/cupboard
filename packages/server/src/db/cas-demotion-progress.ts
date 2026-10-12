import {
	type Sha256HexDigest,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { type IsoTimestamp } from '@cupboard/protocol/scalars';
import {
	and,
	asc,
	eq,
	exists,
	gt,
	inArray,
	lt,
	notExists,
	sql
} from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import { casObjectNotRepromoted } from '../blob/cas-object-state.ts';
import { jsonRowList, jsonValueList } from '../do/json-list.ts';

import * as schema from './d1-schema.ts';

export interface CasDemotionSource {
	readonly digest: Sha256HexDigest;
	readonly incarnation: number;
}

type ProgressRow = typeof schema.casDemotionProgress.$inferSelect;

export const casDemotionTenantsPerSource = 4;
export const casDemotionSourcesPerPass = 8;

export class CasDemotionProgressRepository {
	constructor(private readonly database: DrizzleD1Database<typeof schema>) {}

	private currentSource(source: CasDemotionSource) {
		return and(
			eq(schema.casObject.digest, source.digest),
			eq(schema.casObject.incarnation, source.incarnation)
		);
	}

	private capturedProgress(row: ProgressRow) {
		return and(
			eq(schema.casDemotionProgress.digest, row.digest),
			eq(schema.casDemotionProgress.incarnation, row.incarnation),
			eq(schema.casDemotionProgress.revision, row.revision)
		);
	}

	private async advance(
		row: ProgressRow,
		afterTenant: TenantId | undefined,
		now: IsoTimestamp
	): Promise<boolean> {
		const sourceExists = exists(
			this.database
				.select({ one: sql`1` })
				.from(schema.casObject)
				.where(this.currentSource(row))
		);
		const updated = await this.database
			.update(schema.casDemotionProgress)
			.set({
				afterTenant: afterTenant ?? sql`NULL`,
				revision: sql`${schema.casDemotionProgress.revision} + 1`,
				updatedAt: now
			})
			.where(and(this.capturedProgress(row), sourceExists))
			.returning({ revision: schema.casDemotionProgress.revision })
			.all();
		return updated.length === 1;
	}

	async register(source: CasDemotionSource, now: IsoTimestamp): Promise<void> {
		const progress = schema.casDemotionProgress;
		await this.database
			.insert(progress)
			.select(
				this.database
					.select({
						digest: schema.casObject.digest,
						incarnation: schema.casObject.incarnation,
						afterTenant: sql<TenantId | null>`NULL`.as('after_tenant'),
						revision: sql<number>`1`.as('revision'),
						updatedAt: sql<IsoTimestamp>`${now}`.as('updated_at')
					})
					.from(schema.casObject)
					.where(this.currentSource(source))
			)
			.onConflictDoUpdate({
				target: progress.digest,
				set: {
					incarnation: sql`excluded.incarnation`,
					afterTenant: sql`NULL`,
					revision: sql`${progress.revision} + 1`,
					updatedAt: now
				},
				setWhere: lt(progress.incarnation, sql`excluded.incarnation`)
			});
	}

	async dueSources(limit: number): Promise<CasDemotionSource[]> {
		const progress = schema.casDemotionProgress;
		const rows = await this.database
			.select()
			.from(progress)
			.orderBy(
				asc(progress.updatedAt),
				asc(progress.revision),
				asc(progress.digest)
			)
			.limit(limit)
			.all();
		const sources: CasDemotionSource[] = [];

		for (const row of rows) {
			const source = await this.database
				.select({
					digest: schema.casObject.digest,
					incarnation: schema.casObject.incarnation
				})
				.from(schema.casObject)
				.where(this.currentSource(row))
				.get();
			if (source === undefined) {
				await this.database.delete(progress).where(this.capturedProgress(row));
				continue;
			}
			sources.push(source);
		}
		return sources;
	}

	async tenantPage(
		source: CasDemotionSource,
		now: IsoTimestamp
	): Promise<TenantId[]> {
		const row = await this.database
			.select()
			.from(schema.casDemotionProgress)
			.where(
				and(
					eq(schema.casDemotionProgress.digest, source.digest),
					eq(schema.casDemotionProgress.incarnation, source.incarnation)
				)
			)
			.get();
		if (row === undefined) {
			return [];
		}
		const eligible = await this.database
			.select({ one: sql`1` })
			.from(schema.casObject)
			.where(
				and(
					this.currentSource(source),
					casObjectNotRepromoted(
						this.database,
						source.digest,
						source.incarnation
					)
				)
			)
			.get();
		if (eligible === undefined) {
			await this.advance(row, row.afterTenant ?? undefined, now);
			return [];
		}
		const tenants: TenantId[] = [];
		let after = row.afterTenant ?? undefined;
		let hasMore = false;

		for (let index = 0; index <= casDemotionTenantsPerSource; index += 1) {
			const next = await this.database
				.select({ tenant: schema.attestationReference.tenant })
				.from(schema.attestationReference)
				.where(
					and(
						eq(schema.attestationReference.digest, source.digest),
						after === undefined
							? undefined
							: gt(schema.attestationReference.tenant, after)
					)
				)
				.orderBy(asc(schema.attestationReference.tenant))
				.limit(1)
				.get();
			if (next === undefined) {
				break;
			}
			if (index === casDemotionTenantsPerSource) {
				hasMore = true;
				break;
			}
			tenants.push(next.tenant);
			after = next.tenant;
		}
		if (!(await this.advance(row, hasMore ? after : undefined, now))) {
			return [];
		}
		return tenants;
	}

	async forget(sources: readonly CasDemotionSource[]): Promise<void> {
		if (sources.length === 0) {
			return;
		}
		const captured = jsonRowList(sources);
		await this.database.delete(schema.casDemotionProgress).where(
			captured.matches({
				digest: schema.casDemotionProgress.digest,
				incarnation: schema.casDemotionProgress.incarnation
			})
		);
	}

	async prune(sources: readonly CasDemotionSource[]): Promise<void> {
		if (sources.length === 0) {
			return;
		}
		const progress = schema.casDemotionProgress;
		const digests = jsonValueList(sources.map((source) => source.digest));
		const current = this.database
			.select({ one: sql`1` })
			.from(schema.casObject)
			.where(
				and(
					eq(schema.casObject.digest, progress.digest),
					eq(schema.casObject.incarnation, progress.incarnation)
				)
			);
		await this.database
			.delete(progress)
			.where(and(inArray(progress.digest, digests), notExists(current)));
	}
}
