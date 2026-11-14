import { narFingerprint } from '@cupboard/nix-store/narinfo';
import { NixPublicKey } from '@cupboard/nix-store/public-key';
import {
	narInfoGenerationSchema,
	type NixFingerprint,
	type SigningKeyGeneration,
	signingKeyGenerationSchema,
	type SigningKeyId,
	signingKeyIdSchema,
	storedReferencesSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { NixSignature } from '@cupboard/nix-store/signature';
import { byCodeUnit, StorePath } from '@cupboard/nix-store/store-path';
import {
	type InstanceName,
	instanceNameSchema
} from '@cupboard/protocol/instance';
import type {
	BackfillStatusInput,
	KeyAbortResponseInput,
	KeyListResponseInput,
	KeyRetireResponseInput,
	KeyRotateResponseInput,
	SigningKeyEntryInput
} from '@cupboard/protocol/keys';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { and, count, eq, isNull, lt, ne, sql } from 'drizzle-orm';
import { z } from 'zod';

import {
	generateSigningKey,
	generateSigningKeyMaterial,
	signNixFingerprint
} from '../crypto/crypto.ts';
import { cacheIdSchema } from '../db/cache.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import {
	LastSigningKeyError,
	SigningKeyBackfillIncompleteError,
	SigningKeyInstanceMissingError,
	SigningKeyRotationAbortNotAllowedError,
	SigningKeyRotationInProgressError,
	SigningKeySequenceMissingError,
	SigningKeyVanishedError
} from '../errors.ts';
import { narInfoCacheTag } from '../http/cache-tags.ts';
import {
	narInfoCacheTtlSeconds,
	TextBody as CachedTextBody,
	type TextBody
} from '../http/http.ts';

import {
	armAlarmNoLaterThan,
	type MaintenanceProgress,
	noProgressRetryMs
} from './alarm.ts';
import {
	type BackfillPurgeClaim,
	BackfillPurgePace
} from './backfill-purge-pace.ts';
import {
	CachePurgeBackoff,
	type CachePurgeRowRetry
} from './cache-purge-backoff.ts';
import { CachePurgeRetryPolicy } from './cache-purge-retry.ts';
import { type ServerContext, tagsPerPurgeRequest } from './context.ts';
import { criticalSectionBudgetMs, withDeadlineBudget } from './deadline.ts';
import { maintenancePassSubrequests } from './maintenance-eligibility-service.ts';
import { type NarInfoObjectsService } from './narinfo-objects-service.ts';
import { narInfoOfLiveCache } from './removed-cache.ts';
import {
	bootstrapKeyId,
	byPublicKey,
	keyEntry,
	type SigningKey,
	signingKeyFromRow,
	signingKeyName,
	storedSignaturesSchema
} from './signing-keys.ts';
import { affordableSubrequestOperations } from './subrequest-slice.ts';

const sequenceId = 'singleton';

// Staging re-signs rows and writes them to the Durable Object's local SQLite
// database. Its size is independent of the subrequest calculation below.
const backfillBatchSize = 32;

// A pass sends one purge request of up to `tagsPerPurgeRequest` tags. Staging
// keeps this many rows queued, so the request is full when the pace allows it.
const backfillRowsPerRequest = Math.ceil(
	tagsPerPurgeRequest / backfillBatchSize
);

// Publishing one continuation entry reads the shared blob row from which its
// narinfo is rendered. The publish then re-renders the entry if the row changed
// while that read was in flight, reads the shared blob row again to confirm the
// written object, probes the path's committed reference edge, and renders the
// narinfo once more.
const subrequestsPerBackfillEntry = 5;

// The purge request is one subrequest. The page leaves it unspent, so the
// request does not depend on the slice's safety reserve.
const subrequestsPerBackfillPurge = 1;

/**
How many entries one pass can publish within the per-invocation subrequest
allowance, when each entry uses the five D1 and R2 calls of the calculation
above.
*/
export function backfillEntriesPerPass(subrequestAllowance: number): number {
	return Math.floor(
		maintenancePassSubrequests(subrequestAllowance, 'continuation') /
			subrequestsPerBackfillEntry
	);
}

const purgeEntrySchema = z.strictObject({
	cacheId: cacheIdSchema,
	storePathHash: storePathHashSchema,
	narInfoGeneration: narInfoGenerationSchema,
	targetGeneration: signingKeyGenerationSchema,
	tag: z.string()
});
type PurgeEntry = z.output<typeof purgeEntrySchema>;

// Do not bound the length. The row is persisted, so a bound here would refuse
// a row an earlier build wrote larger. A row is never written empty, so an
// empty array is corrupt.
const purgeEntriesSchema = z.array(purgeEntrySchema).min(1);

type BackfillRow = typeof schema.signingKeyBackfills.$inferSelect;

type ContinuationRow = typeof schema.cachePurgeContinuations.$inferSelect;

// The entries of one continuation row in a page: those that the pass publishes
// and purges, and those that stay in the row.
interface BackfillPagePart {
	readonly row: ContinuationRow;
	readonly entries: readonly PurgeEntry[];
	readonly remaining: readonly PurgeEntry[];
}

// What recording a purged request did to its continuation row: kept it with
// the remaining entries, deleted it after the last entry, or found it already
// deleted by an aborted rotation.
type ContinuationSettlement =
	| { readonly kind: 'kept'; readonly retry: CachePurgeRowRetry }
	| { readonly kind: 'deleted' }
	| { readonly kind: 'missing' };

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class SigningKeysService {
	private keysPromise: Promise<readonly SigningKey[]> | undefined;
	private publicKeyBody: TextBody | undefined;
	private readonly purgeBackoff: CachePurgeBackoff;

	constructor(
		private readonly context: ServerContext,
		private readonly narInfoObjects: NarInfoObjectsService,
		purgeRetryPolicy: CachePurgeRetryPolicy = new CachePurgeRetryPolicy(),
		private readonly now: () => number = () => Date.now(),
		private readonly purgePace: BackfillPurgePace = new BackfillPurgePace(
			context
		)
	) {
		this.purgeBackoff = new CachePurgeBackoff(
			context.ctx.storage,
			context.db,
			purgeRetryPolicy
		);
	}

	private loadedKeys(): Promise<readonly SigningKey[]> {
		this.keysPromise ??= this.loadOrCreateKeysTracked();

		return this.keysPromise;
	}

	private async loadOrCreateKeysTracked(): Promise<readonly SigningKey[]> {
		try {
			return await this.loadOrCreateKeys();
		} catch (error: unknown) {
			this.keysPromise = undefined;
			throw error;
		}
	}

	private async instanceName(): Promise<InstanceName> {
		const configured = await this.context.d1
			.select({ name: d1Schema.instanceConfig.name })
			.from(d1Schema.instanceConfig)
			.get();

		if (configured === undefined) {
			throw new SigningKeyInstanceMissingError();
		}

		return instanceNameSchema.parse(configured.name);
	}

	private ensureSequence(keys: readonly SigningKey[]): void {
		const nextGeneration = signingKeyGenerationSchema.parse(
			Math.max(0, ...keys.map((key) => key.generation)) + 1
		);
		const existing = this.context.db
			.select()
			.from(schema.signingKeySequence)
			.where(eq(schema.signingKeySequence.id, sequenceId))
			.get();

		if (existing !== undefined) {
			return;
		}

		this.context.db
			.insert(schema.signingKeySequence)
			.values({ id: sequenceId, nextGeneration })
			.run();
	}

	private reconcileLegacyGenerations(
		rows: readonly (typeof schema.signingKeys.$inferSelect)[]
	): (typeof schema.signingKeys.$inferSelect)[] {
		const ordered = rows.toSorted((left, right) => {
			const byCreatedAt = left.createdAt.localeCompare(right.createdAt);

			return byCreatedAt === 0
				? left.publicKey.localeCompare(right.publicKey)
				: byCreatedAt;
		});
		const reserved = new Set(
			ordered
				.map((row) => row.generation)
				.filter((generation) => generation > 0)
		);
		const assigned = new Set<SigningKeyGeneration>();
		let next = signingKeyGenerationSchema.parse(1);

		return ordered.map((row) => {
			let generation = row.generation;

			if (generation === 0 || assigned.has(generation)) {
				const keyName = new NixPublicKey(row.publicKey).name;
				const suffix = /-(\d+)$/u.exec(keyName)?.[1];
				const parsedSuffix =
					suffix === undefined
						? undefined
						: signingKeyGenerationSchema.safeParse(Number(suffix));

				while (reserved.has(next) || assigned.has(next)) {
					next = signingKeyGenerationSchema.parse(next + 1);
				}

				generation =
					parsedSuffix?.success === true &&
					parsedSuffix.data > 0 &&
					!reserved.has(parsedSuffix.data) &&
					!assigned.has(parsedSuffix.data)
						? parsedSuffix.data
						: signingKeyGenerationSchema.parse(next);
			}

			assigned.add(generation);
			next = signingKeyGenerationSchema.parse(Math.max(next, generation + 1));

			if (generation !== row.generation) {
				this.context.db
					.update(schema.signingKeys)
					.set({ generation })
					.where(eq(schema.signingKeys.id, row.id))
					.run();
			}

			return { ...row, generation };
		});
	}

	private async loadOrCreateKeys(): Promise<readonly SigningKey[]> {
		const storedRows = this.context.db.select().from(schema.signingKeys).all();

		if (storedRows.length > 0) {
			const keys = this.reconcileLegacyGenerations(storedRows)
				.map((row) => signingKeyFromRow(row))
				.toSorted(byPublicKey);
			this.ensureSequence(keys);
			this.reconcileLegacyBackfill(keys);
			await this.ensureBackfillAlarm();

			return keys;
		}

		const generation = signingKeyGenerationSchema.parse(1);
		const name = signingKeyName(
			await this.instanceName(),
			this.context.requireTenant(),
			generation
		);
		const generated = await generateSigningKey(name);
		const createdAt = isoTimestamp(new Date());

		this.context.db.transaction((tx) => {
			tx.insert(schema.signingKeys)
				.values({
					id: bootstrapKeyId,
					privateJwkJson: JSON.stringify(generated.privateJwk),
					publicKey: generated.publicKey.value,
					signing: true,
					published: true,
					generation,
					createdAt
				})
				.run();
			tx.insert(schema.signingKeySequence)
				.values({
					id: sequenceId,
					nextGeneration: signingKeyGenerationSchema.parse(2)
				})
				.run();
		});

		return [
			{
				id: bootstrapKeyId,
				privateJwk: generated.privateJwk,
				publicKey: generated.publicKey,
				signing: true,
				published: true,
				generation,
				createdAt
			}
		];
	}

	private async publishedKeys(): Promise<readonly SigningKey[]> {
		const keys = await this.loadedKeys();

		return keys.filter((key) => key.published);
	}

	private async publishedKeysText(): Promise<string> {
		const keys = await this.publishedKeys();

		return keys.map((key) => key.publicKey.value).join('\n');
	}

	private remaining(generation: SigningKeyGeneration): number {
		return (
			this.context.db
				.select({ value: count() })
				.from(schema.narInfos)
				.where(
					and(
						lt(schema.narInfos.signatureGeneration, generation),
						narInfoOfLiveCache()
					)
				)
				.get()?.value ?? 0
		);
	}

	private hasRemaining(generation: SigningKeyGeneration): boolean {
		return (
			this.context.db
				.select({ cache: schema.narInfos.cacheId })
				.from(schema.narInfos)
				.where(
					and(
						lt(schema.narInfos.signatureGeneration, generation),
						narInfoOfLiveCache()
					)
				)
				.limit(1)
				.get() !== undefined
		);
	}

	private reconcileLegacyBackfill(keys: readonly SigningKey[]): void {
		const target = keys
			.filter((key) => key.signing)
			.toSorted((left, right) => right.generation - left.generation)[0];

		if (target === undefined || !this.hasRemaining(target.generation)) {
			return;
		}

		const existing = this.context.db
			.select()
			.from(schema.signingKeyBackfills)
			.where(eq(schema.signingKeyBackfills.keyId, target.id))
			.get();

		if (existing === undefined) {
			const startedAt = isoTimestamp(new Date());
			this.context.db
				.insert(schema.signingKeyBackfills)
				.values({
					keyId: target.id,
					generation: target.generation,
					state: 'running',
					startedAt,
					updatedAt: startedAt,
					resigned: 0
				})
				.run();

			return;
		}

		if (existing.state !== 'complete') {
			return;
		}

		const updatedAt = isoTimestamp(new Date());
		this.context.db
			.update(schema.signingKeyBackfills)
			.set({
				state: 'running',
				updatedAt,
				completedAt: sql`null`
			})
			.where(eq(schema.signingKeyBackfills.keyId, target.id))
			.run();
	}

	private async ensureBackfillAlarm(): Promise<void> {
		const unfinished = this.context.db
			.select({ keyId: schema.signingKeyBackfills.keyId })
			.from(schema.signingKeyBackfills)
			.where(ne(schema.signingKeyBackfills.state, 'complete'))
			.limit(1)
			.get();
		const continuation = this.context.db
			.select({ id: schema.cachePurgeContinuations.id })
			.from(schema.cachePurgeContinuations)
			.where(eq(schema.cachePurgeContinuations.kind, 'backfill'))
			.limit(1)
			.get();

		if (unfinished !== undefined || continuation !== undefined) {
			await armAlarmNoLaterThan(this.context.ctx.storage, Date.now());
		}
	}

	private async armBackfillAlarm(): Promise<void> {
		const now = this.now();

		await armAlarmNoLaterThan(
			this.context.ctx.storage,
			(await this.backfillWorkAt(now)) ?? now
		);
	}

	private backfillStatus(row: BackfillRow): BackfillStatusInput {
		if (row.state === 'complete' && row.completedAt !== null) {
			return {
				state: 'complete',
				startedAt: row.startedAt,
				completedAt: row.completedAt,
				resigned: row.resigned
			};
		}

		const common = {
			startedAt: row.startedAt,
			updatedAt: row.updatedAt,
			resigned: row.resigned,
			remaining: this.remaining(row.generation)
		};

		if (
			row.state === 'retrying' &&
			row.failureOperation !== null &&
			row.failedAt !== null &&
			row.failureMessage !== null
		) {
			return {
				state: 'retrying',
				...common,
				failure: {
					operation: row.failureOperation,
					failedAt: row.failedAt,
					message: row.failureMessage
				}
			};
		}

		return { state: 'running', ...common };
	}

	private entries(keys: readonly SigningKey[]): SigningKeyEntryInput[] {
		const backfills = new Map(
			this.context.db
				.select()
				.from(schema.signingKeyBackfills)
				.all()
				.map((row) => [row.keyId, this.backfillStatus(row)] as const)
		);

		return keys.map((key) => keyEntry(key, backfills.get(key.id)));
	}

	private completeCoverage(key: SigningKey): boolean {
		return !this.hasRemaining(key.generation);
	}

	private async signaturesFor(
		fingerprint: NixFingerprint,
		existing: readonly string[],
		keys: readonly SigningKey[]
	): Promise<string[]> {
		const publishedNames = new Set(
			keys.filter((key) => key.published).map((key) => key.publicKey.name)
		);
		const signatures = new Map(
			NixSignature.parseAll(existing)
				.filter((signature) => publishedNames.has(signature.name))
				.map((signature) => [signature.name, signature.value] as const)
		);
		const signing = keys.filter((key) => key.signing);
		const generated = await Promise.all(
			signing.map((key) =>
				signNixFingerprint(key.privateJwk, fingerprint, key.publicKey.name)
			)
		);

		for (const signature of generated) {
			signatures.set(signature.name, signature.value);
		}

		return [...signatures]
			.toSorted(([left], [right]) => byCodeUnit(left, right))
			.map(([, value]) => value);
	}

	// Stages batches until enough rows are queued to fill one purge request.
	// Staging more than that would grow the backlog faster than the requests
	// can drain it.
	private async stageBackfills(row: BackfillRow): Promise<void> {
		while (this.backfillRowCount() < backfillRowsPerRequest) {
			if ((await this.stageBackfill(row)) === 0) {
				return;
			}
		}
	}

	private backfillRowCount(): number {
		return (
			this.context.db
				.select({ rows: count() })
				.from(schema.cachePurgeContinuations)
				.where(eq(schema.cachePurgeContinuations.kind, 'backfill'))
				.all()
				.at(0)?.rows ?? 0
		);
	}

	private async stageBackfill(row: BackfillRow): Promise<number> {
		return this.context.criticalSection(async () => {
			const rows = this.context.db
				.select()
				.from(schema.narInfos)
				.where(
					and(
						lt(schema.narInfos.signatureGeneration, row.generation),
						isNull(schema.narInfos.pendingSignatureGeneration),
						narInfoOfLiveCache()
					)
				)
				.orderBy(
					schema.narInfos.signatureGeneration,
					schema.narInfos.cacheId,
					schema.narInfos.storePathHash
				)
				.limit(backfillBatchSize)
				.all();

			if (rows.length === 0) {
				return 0;
			}

			const keys = await this.loadedKeys();
			const rendered: { row: (typeof rows)[number]; sigs: string[] }[] = [];

			for (const narInfoRow of rows) {
				const references = storedReferencesSchema.parse(
					JSON.parse(narInfoRow.referencesJson) as unknown
				);
				const existing = storedSignaturesSchema.parse(
					JSON.parse(narInfoRow.sigsJson) as unknown
				);
				const fingerprint = narFingerprint(
					new StorePath(narInfoRow.storePath),
					narInfoRow.narHash,
					narInfoRow.narSize,
					references
				);
				const sigs = await this.signaturesFor(fingerprint, existing, keys);
				rendered.push({ row: narInfoRow, sigs });
			}

			const createdAt = isoTimestamp(new Date(this.now()));
			const expiresAt = isoTimestamp(
				new Date(this.now() + narInfoCacheTtlSeconds * 1000)
			);
			const continuationId = crypto.randomUUID();
			const entries: PurgeEntry[] = [];

			this.context.db.transaction((tx) => {
				for (const item of rendered) {
					const cache = this.context.cacheRepository.resolvedForId(
						item.row.cacheId
					);
					const updated = tx
						.update(schema.narInfos)
						.set({
							sigsJson: JSON.stringify(item.sigs),
							pendingSignatureGeneration: row.generation
						})
						.where(
							and(
								eq(schema.narInfos.cacheId, cache.id),
								eq(schema.narInfos.storePathHash, item.row.storePathHash),
								eq(schema.narInfos.generation, item.row.generation),
								isNull(schema.narInfos.pendingSignatureGeneration)
							)
						)
						.returning({
							storePathHash: schema.narInfos.storePathHash,
							generation: schema.narInfos.generation
						})
						.all()[0];

					if (updated === undefined) {
						continue;
					}

					entries.push({
						cacheId: cache.id,
						storePathHash: updated.storePathHash,
						narInfoGeneration: updated.generation,
						targetGeneration: row.generation,
						tag: narInfoCacheTag(
							this.context.requireTenant(),
							cache.scope,
							updated.storePathHash
						)
					});
				}

				if (entries.length > 0) {
					tx.insert(schema.cachePurgeContinuations)
						.values({
							id: continuationId,
							kind: 'backfill',
							signingKeyId: row.keyId,
							entriesJson: JSON.stringify(entries),
							createdAt,
							expiresAt
						})
						.run();
				}

				tx.update(schema.signingKeyBackfills)
					.set({
						state: 'running',
						updatedAt: createdAt,
						failureOperation: sql`null`,
						failedAt: sql`null`,
						failureMessage: sql`null`
					})
					.where(eq(schema.signingKeyBackfills.keyId, row.keyId))
					.run();
			});

			return entries.length;
		});
	}

	private async publishContinuationEntries(
		entries: readonly PurgeEntry[]
	): Promise<void> {
		for (const entry of entries) {
			const cache = this.context.cacheRepository.resolvedForId(entry.cacheId);
			const row = this.context.db
				.select()
				.from(schema.narInfos)
				.where(
					and(
						eq(schema.narInfos.cacheId, entry.cacheId),
						eq(schema.narInfos.storePathHash, entry.storePathHash),
						eq(schema.narInfos.generation, entry.narInfoGeneration),
						eq(
							schema.narInfos.pendingSignatureGeneration,
							entry.targetGeneration
						)
					)
				)
				.get();

			if (row === undefined) {
				continue;
			}

			const narInfo = await this.narInfoObjects.narInfoFromRow(row);

			if (narInfo === undefined) {
				continue;
			}

			await this.narInfoObjects.publishNarInfoObject(
				cache,
				entry.storePathHash,
				entry.narInfoGeneration,
				row.narHash,
				narInfo
			);
		}
	}

	/**
	Records the entries this pass published and removes them from the
	continuation. The continuation row survives while `remaining` holds the
	entries a later pass still has to publish. Reports `deleted` when no entry
	remains, and otherwise `missing` if `abortKeyRotation` has deleted the
	row. The abort also clears the pending generation of the narinfo rows and
	deletes the backfill row in the same transaction, so the earlier writes
	then match no row.
	*/
	private settleContinuation(
		continuation: typeof schema.cachePurgeContinuations.$inferSelect,
		entries: readonly PurgeEntry[],
		remaining: readonly PurgeEntry[],
		now: IsoTimestamp
	): ContinuationSettlement {
		return this.context.db.transaction((tx) => {
			let resigned = 0;

			for (const entry of entries) {
				const updated = tx
					.update(schema.narInfos)
					.set({
						signatureGeneration: signingKeyGenerationSchema.parse(
							entry.targetGeneration
						),
						pendingSignatureGeneration: sql`null`
					})
					.where(
						and(
							eq(schema.narInfos.cacheId, entry.cacheId),
							eq(schema.narInfos.storePathHash, entry.storePathHash),
							eq(schema.narInfos.generation, entry.narInfoGeneration),
							eq(
								schema.narInfos.pendingSignatureGeneration,
								entry.targetGeneration
							)
						)
					)
					.returning({
						cacheId: schema.narInfos.cacheId,
						storePathHash: schema.narInfos.storePathHash
					})
					.all();

				resigned += updated.length;
			}

			if (continuation.signingKeyId !== null) {
				const backfill = tx
					.select({ resigned: schema.signingKeyBackfills.resigned })
					.from(schema.signingKeyBackfills)
					.where(
						eq(schema.signingKeyBackfills.keyId, continuation.signingKeyId)
					)
					.get();

				if (backfill !== undefined) {
					tx.update(schema.signingKeyBackfills)
						.set({
							state: 'running',
							updatedAt: now,
							resigned: backfill.resigned + resigned,
							failureOperation: sql`null`,
							failedAt: sql`null`,
							failureMessage: sql`null`
						})
						.where(
							eq(schema.signingKeyBackfills.keyId, continuation.signingKeyId)
						)
						.run();
				}
			}

			if (remaining.length === 0) {
				tx.delete(schema.cachePurgeContinuations)
					.where(eq(schema.cachePurgeContinuations.id, continuation.id))
					.run();

				return { kind: 'deleted' };
			}

			// An update that matched nothing returns no row, although `get` is
			// typed as always returning one.
			const retry = tx
				.update(schema.cachePurgeContinuations)
				.set({
					entriesJson: JSON.stringify(remaining),
					nextAttemptAt: sql`null`,
					failedAttempts: 0
				})
				.where(eq(schema.cachePurgeContinuations.id, continuation.id))
				.returning({
					nextAttemptAt: schema.cachePurgeContinuations.nextAttemptAt,
					failedAttempts: schema.cachePurgeContinuations.failedAttempts
				})
				.all()
				.at(0);

			return retry === undefined
				? { kind: 'missing' }
				: { kind: 'kept', retry };
		});
	}

	// The entries of one continuation row that a pass publishes and purges, and
	// the entries that stay in the row for a later pass.
	private backfillPagePart(
		row: ContinuationRow,
		room: number
	): BackfillPagePart {
		const queued = purgeEntriesSchema.parse(
			JSON.parse(row.entriesJson) as unknown
		);

		return {
			row,
			entries: queued.slice(0, room),
			remaining: queued.slice(room)
		};
	}

	// Fills one purge request. The page starts with the head row and continues
	// with the rows after it in sending order. A head with a recorded failure
	// count is purged alone, so a row that joined it cannot keep its retries
	// failing. A row with a recorded failure count joins no head's page, because
	// it might fail a request that would succeed without it. The rows behind a
	// failing head wait until the head's purge succeeds.
	private backfillPage(head: ContinuationRow): BackfillPagePart[] {
		// A publication that fails removes no entry from the continuation, so the
		// page must be one that the invocation's allowance covers in full.
		// Otherwise the entry that the binding refused would fail the same page on
		// every pass.
		const limit = Math.min(
			backfillEntriesPerPass(this.context.subrequestsPerInvocation),
			affordableSubrequestOperations(
				subrequestsPerBackfillEntry,
				subrequestsPerBackfillPurge
			),
			tagsPerPurgeRequest
		);
		const first = this.backfillPagePart(head, limit);
		const page = [first];

		if (head.failedAttempts > 0 || first.entries.length >= limit) {
			return page;
		}

		const table = schema.cachePurgeContinuations;
		let room = limit - first.entries.length;
		const rows = this.context.db
			.select()
			.from(table)
			.where(
				and(
					eq(table.kind, 'backfill'),
					ne(table.id, head.id),
					eq(table.failedAttempts, 0)
				)
			)
			.orderBy(table.priority, table.createdAt)
			.limit(room)
			.all();

		for (const row of rows) {
			if (room === 0) {
				break;
			}

			const part = this.backfillPagePart(row, room);
			page.push(part);
			room -= part.entries.length;
		}

		return page;
	}

	private hasBackfillContinuation(): boolean {
		return (
			this.context.db
				.select({ id: schema.cachePurgeContinuations.id })
				.from(schema.cachePurgeContinuations)
				.where(eq(schema.cachePurgeContinuations.kind, 'backfill'))
				.limit(1)
				.get() !== undefined
		);
	}

	/**
	Sends one purge request for the oldest backfill continuation rows, and
	records the entries that it purged.

	The pass first claims the deployment's next backfill purge request from
	{@link BackfillPurgePace}. It reports `paced` when the deployment's last
	claim is less than one interval old, and it neither publishes nor purges
	until a claim succeeds. A D1 error in the claim is a failed attempt, and the
	pass reports `retrying`.

	With the claim, the pass publishes the entries of one page and purges their
	tags in one request. The page is the head row and, up to the request's limit
	of 100 tags, the rows after it. The pass records the entries of each row as
	signed and removes them from the row. It reports `partial` while a backfill
	row remains, and `runBackfillOnce` then arms the alarm for that row's next
	request.

	If publication fails, the pass removes none of the selected entries from
	their rows. A later pass retries the same leading page and may publish the
	same objects again. After a purge failure, {@link CachePurgeBackoff}
	decides the earliest time for the next attempt, and the pass reports
	`waiting` until then without publishing. The claim stays used, so the next
	request still waits for its interval.
	*/
	private async processContinuation(): Promise<
		'none' | 'settled' | 'partial' | 'retrying' | 'waiting' | 'paced'
	> {
		const continuation = this.headBackfillContinuation();

		if (continuation === undefined) {
			return 'none';
		}

		const dueAt = await this.purgeBackoff.dueAt(continuation, this.now());

		if (dueAt > this.now()) {
			await armAlarmNoLaterThan(this.context.ctx.storage, dueAt);

			return 'waiting';
		}

		const knownNextAt = await this.purgePace.knownNextAt();

		if (knownNextAt !== undefined && knownNextAt > this.now()) {
			return 'paced';
		}

		const now = isoTimestamp(new Date(this.now()));
		let claim: BackfillPurgeClaim;

		try {
			claim = await this.purgePace.claim(this.now());
		} catch (error) {
			await this.recordClaimFailure(continuation, error, now);

			return 'retrying';
		}

		if (claim.kind === 'waiting') {
			return 'paced';
		}

		const page = this.backfillPage(continuation);
		const entries = page.flatMap((part) => part.entries);

		try {
			await withDeadlineBudget(criticalSectionBudgetMs, () =>
				this.publishContinuationEntries(entries)
			);
		} catch (error) {
			await this.recordFailure(continuation, error, 'resigning', now);

			return 'retrying';
		}

		try {
			await this.context.purgeCacheTags(entries.map((entry) => entry.tag));
		} catch (error) {
			await this.recordFailure(continuation, error, 'cache-purge', now);

			return 'retrying';
		}

		await this.purgeBackoff.recordSuccess();

		// `abortKeyRotation` can delete a row while the request is in flight. The
		// settlement of that row matches nothing, and the other rows still need
		// theirs.
		for (const part of page) {
			this.settleContinuation(part.row, part.entries, part.remaining, now);
		}

		return this.hasBackfillContinuation() ? 'partial' : 'settled';
	}

	// A D1 error in the claim is a failed attempt that has used no slot of the
	// pace. The row records the error, the backfill reports a retry, and the
	// alarm is armed for the usual delay after a failed pass.
	private async recordClaimFailure(
		continuation: ContinuationRow,
		error: unknown,
		now: IsoTimestamp
	): Promise<void> {
		const message = errorMessage(error);
		this.context.db
			.update(schema.cachePurgeContinuations)
			.set({ lastAttemptAt: now, lastError: message })
			.where(eq(schema.cachePurgeContinuations.id, continuation.id))
			.run();

		if (continuation.signingKeyId !== null) {
			this.markRetrying(continuation.signingKeyId, 'cache-purge', now, message);
		}

		await armAlarmNoLaterThan(
			this.context.ctx.storage,
			this.now() + noProgressRetryMs
		);
	}

	// A publication or a purge that fails has used its claim. The head row backs
	// off with the retry state of the purge queue, which grows with each failure.
	// A row that fails on every attempt therefore uses one slot of the pace for
	// each retry, not one for each pass.
	private async recordFailure(
		continuation: ContinuationRow,
		error: unknown,
		operation: 'resigning' | 'cache-purge',
		now: IsoTimestamp
	): Promise<void> {
		const failedAt = this.now();
		const retry = await this.purgeBackoff.recordFailure(
			error,
			continuation,
			failedAt
		);
		const message = errorMessage(error);
		this.context.db
			.update(schema.cachePurgeContinuations)
			.set({
				lastAttemptAt: isoTimestamp(new Date(failedAt)),
				lastError: message,
				...retry
			})
			.where(eq(schema.cachePurgeContinuations.id, continuation.id))
			.run();

		if (continuation.signingKeyId !== null) {
			this.markRetrying(continuation.signingKeyId, operation, now, message);
		}

		await armAlarmNoLaterThan(
			this.context.ctx.storage,
			await this.purgeBackoff.dueAt(retry, failedAt)
		);
	}

	private headBackfillContinuation():
		typeof schema.cachePurgeContinuations.$inferSelect | undefined {
		return (
			this.context.db
				.select()
				.from(schema.cachePurgeContinuations)
				.where(eq(schema.cachePurgeContinuations.kind, 'backfill'))
				// Every backfill row has the same priority. Ordering by it as well
				// lets SQLite read the rows in index order without sorting them.
				.orderBy(
					schema.cachePurgeContinuations.priority,
					schema.cachePurgeContinuations.createdAt
				)
				.get()
		);
	}

	private markRetrying(
		keyId: string,
		operation: 'resigning' | 'cache-purge',
		failedAt: IsoTimestamp,
		message: string
	): void {
		this.context.db
			.update(schema.signingKeyBackfills)
			.set({
				state: 'retrying',
				updatedAt: failedAt,
				failureOperation: operation,
				failedAt,
				failureMessage: message
			})
			.where(eq(schema.signingKeyBackfills.keyId, keyId))
			.run();
	}

	private completeIfDrained(row: BackfillRow): boolean {
		if (this.hasRemaining(row.generation)) {
			return false;
		}

		const pending = this.context.db
			.select({ id: schema.cachePurgeContinuations.id })
			.from(schema.cachePurgeContinuations)
			.where(eq(schema.cachePurgeContinuations.signingKeyId, row.keyId))
			.get();

		if (pending !== undefined) {
			return false;
		}

		const completedAt = isoTimestamp(new Date());
		this.context.db
			.update(schema.signingKeyBackfills)
			.set({
				state: 'complete',
				updatedAt: completedAt,
				completedAt,
				failureOperation: sql`null`,
				failedAt: sql`null`,
				failureMessage: sql`null`
			})
			.where(eq(schema.signingKeyBackfills.keyId, row.keyId))
			.run();

		return true;
	}

	resetKeyCaches(): void {
		this.keysPromise = undefined;
		this.publicKeyBody = undefined;
	}

	async rotateKey(): Promise<KeyRotateResponseInput> {
		const material = await generateSigningKeyMaterial();
		const instance = await this.instanceName();

		const response = await this.context.criticalSection(async () => {
			await this.loadedKeys();
			const unfinished = this.context.db
				.select({ keyId: schema.signingKeyBackfills.keyId })
				.from(schema.signingKeyBackfills)
				.where(ne(schema.signingKeyBackfills.state, 'complete'))
				.get();

			if (unfinished !== undefined) {
				await this.ensureBackfillAlarm();
				throw new SigningKeyRotationInProgressError(
					signingKeyIdSchema.parse(unfinished.keyId)
				);
			}

			const sequence = this.context.db
				.select()
				.from(schema.signingKeySequence)
				.where(eq(schema.signingKeySequence.id, sequenceId))
				.get();

			if (sequence === undefined) {
				throw new SigningKeySequenceMissingError();
			}

			const generation = sequence.nextGeneration;
			const publicKey = NixPublicKey.of(
				signingKeyName(instance, this.context.requireTenant(), generation),
				material.publicRaw
			);
			const id = signingKeyIdSchema.parse(crypto.randomUUID());
			const startedAt = isoTimestamp(new Date());

			this.context.db.transaction((tx) => {
				tx.insert(schema.signingKeys)
					.values({
						id,
						privateJwkJson: JSON.stringify(material.privateJwk),
						publicKey: publicKey.value,
						signing: true,
						published: true,
						generation,
						createdAt: startedAt
					})
					.run();
				tx.update(schema.signingKeySequence)
					.set({
						nextGeneration: signingKeyGenerationSchema.parse(generation + 1)
					})
					.where(eq(schema.signingKeySequence.id, sequenceId))
					.run();
				tx.insert(schema.signingKeyBackfills)
					.values({
						keyId: id,
						generation,
						state: 'running',
						startedAt,
						updatedAt: startedAt,
						resigned: 0
					})
					.run();
			});

			this.resetKeyCaches();
			const keys = await this.loadedKeys();
			const rotated = keys.find((key) => key.id === id);

			if (rotated === undefined) {
				throw new SigningKeyVanishedError(id);
			}

			const entries = this.entries(keys);
			const rotatedEntry = entries.find((entry) => entry.key.id === id);

			if (rotatedEntry?.state !== 'signing') {
				throw new SigningKeyVanishedError(id);
			}

			const { backfill } = rotatedEntry;

			if (backfill?.state !== 'running') {
				throw new SigningKeyVanishedError(id);
			}

			return {
				rotated: { ...rotatedEntry, backfill },
				keys: entries
			};
		});

		await armAlarmNoLaterThan(this.context.ctx.storage, Date.now());

		return response;
	}

	async retireKey(id: SigningKeyId): Promise<KeyRetireResponseInput> {
		const outcome = await this.context.criticalSection(async () => {
			const keys = await this.loadedKeys();
			const key = keys.find((candidate) => candidate.id === id);

			if (key === undefined) {
				return { state: 'absent' as const };
			}

			if (key.signing) {
				const otherSigning = keys.filter(
					(candidate) => candidate.id !== id && candidate.signing
				);

				if (otherSigning.length === 0) {
					throw new LastSigningKeyError(id);
				}

				if (
					!this.completeCoverage(key) ||
					otherSigning.every((candidate) => !this.completeCoverage(candidate))
				) {
					throw new SigningKeyBackfillIncompleteError(id);
				}

				this.context.db
					.update(schema.signingKeys)
					.set({ signing: false })
					.where(eq(schema.signingKeys.id, id))
					.run();
				this.resetKeyCaches();

				return { state: 'published-only' as const };
			}

			const isCovered = keys.some(
				(candidate) => candidate.signing && this.completeCoverage(candidate)
			);

			if (!isCovered) {
				throw new SigningKeyBackfillIncompleteError(id);
			}

			this.context.db
				.delete(schema.signingKeys)
				.where(eq(schema.signingKeys.id, id))
				.run();
			this.resetKeyCaches();

			return { state: 'absent' as const };
		});

		return { id, state: outcome.state };
	}

	async abortKeyRotation(id: SigningKeyId): Promise<KeyAbortResponseInput> {
		const state = await this.context.criticalSection(async () => {
			const keys = await this.loadedKeys();
			const key = keys.find((candidate) => candidate.id === id);

			if (key === undefined) {
				return 'absent' as const;
			}

			const backfill = this.context.db
				.select()
				.from(schema.signingKeyBackfills)
				.where(eq(schema.signingKeyBackfills.keyId, id))
				.get();
			const hasAnotherCompleteSigner = keys.some(
				(candidate) =>
					candidate.id !== id &&
					candidate.signing &&
					this.completeCoverage(candidate)
			);

			if (
				backfill === undefined ||
				!hasAnotherCompleteSigner ||
				!key.signing ||
				backfill.state === 'complete'
			) {
				throw new SigningKeyRotationAbortNotAllowedError(id);
			}

			this.context.db.transaction((tx) => {
				tx.delete(schema.cachePurgeContinuations)
					.where(eq(schema.cachePurgeContinuations.signingKeyId, id))
					.run();
				tx.update(schema.narInfos)
					.set({ pendingSignatureGeneration: sql`null` })
					.where(
						eq(schema.narInfos.pendingSignatureGeneration, backfill.generation)
					)
					.run();
				tx.delete(schema.signingKeyBackfills)
					.where(eq(schema.signingKeyBackfills.keyId, id))
					.run();
				tx.delete(schema.signingKeys)
					.where(eq(schema.signingKeys.id, id))
					.run();
			});
			this.resetKeyCaches();

			return 'absent' as const;
		});

		return { id, state };
	}

	async keyList(): Promise<KeyListResponseInput> {
		const keys = await this.loadedKeys();
		await this.ensureBackfillAlarm();

		return { keys: this.entries(keys) };
	}

	async signingKeys(): Promise<readonly SigningKey[]> {
		const keys = await this.loadedKeys();

		return keys.filter((key) => key.signing);
	}

	async publishedKeysBody(): Promise<TextBody> {
		this.publicKeyBody ??= new CachedTextBody(
			`${await this.publishedKeysText()}\n`
		);

		return this.publicKeyBody;
	}

	/**
	Returns when the re-signing backfill next has work: `now` while a backfill
	needs staging, the time of the next purge request while a queued cache-tag
	purge waits, or `undefined` when nothing remains. A purge waits for its
	retry time and for the deployment's backfill pace, as far as this object has
	learned it.

	The alarm calls this before running the backfill. It reads only this
	object's local storage, so it makes no D1 call.
	*/
	async backfillWorkAt(now: number): Promise<number | undefined> {
		const continuation = this.context.db
			.select({
				nextAttemptAt: schema.cachePurgeContinuations.nextAttemptAt,
				failedAttempts: schema.cachePurgeContinuations.failedAttempts
			})
			.from(schema.cachePurgeContinuations)
			.where(eq(schema.cachePurgeContinuations.kind, 'backfill'))
			.orderBy(
				schema.cachePurgeContinuations.priority,
				schema.cachePurgeContinuations.createdAt
			)
			.get();

		if (continuation !== undefined) {
			return Math.max(
				await this.purgeBackoff.dueAt(continuation, now),
				(await this.purgePace.knownNextAt()) ?? now
			);
		}

		const backfill = this.context.db
			.select({ keyId: schema.signingKeyBackfills.keyId })
			.from(schema.signingKeyBackfills)
			.where(ne(schema.signingKeyBackfills.state, 'complete'))
			.limit(1)
			.get();

		return backfill === undefined ? undefined : now;
	}

	async runBackfillOnce(): Promise<MaintenanceProgress> {
		const purge = await this.processContinuation();

		if (purge === 'retrying' || purge === 'waiting') {
			return 'stalled';
		}

		// Waiting for the pace is the scheduled rhythm of the backfill. The alarm
		// is armed for the end of the wait, and the pass reports no stall.
		if (purge === 'paced') {
			await this.armBackfillAlarm();

			return 'progressed';
		}

		const row = this.context.db
			.select()
			.from(schema.signingKeyBackfills)
			.where(ne(schema.signingKeyBackfills.state, 'complete'))
			.orderBy(schema.signingKeyBackfills.startedAt)
			.get();

		if (row === undefined || this.completeIfDrained(row)) {
			// Rows that remain wait for the next request.
			if (purge === 'partial') {
				await this.armBackfillAlarm();
			}

			return 'progressed';
		}

		try {
			await this.stageBackfills(row);
		} catch (error) {
			const failedAt = isoTimestamp(new Date(this.now()));
			this.markRetrying(row.keyId, 'resigning', failedAt, errorMessage(error));
			await armAlarmNoLaterThan(
				this.context.ctx.storage,
				this.now() + noProgressRetryMs
			);
			return 'stalled';
		}

		await this.armBackfillAlarm();

		return 'progressed';
	}
}
