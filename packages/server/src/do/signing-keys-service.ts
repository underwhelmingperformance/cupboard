import { narFingerprint } from '@cupboard/nix-store/narinfo';
import { NixPublicKey } from '@cupboard/nix-store/public-key';
import {
	narInfoGenerationSchema,
	type NixFingerprint,
	referencesSchema,
	type SigningKeyGeneration,
	signingKeyGenerationSchema,
	type SigningKeyId,
	signingKeyIdSchema,
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

import { armAlarmNoLaterThan, noProgressRetryMs } from './alarm.ts';
import { type ServerContext } from './context.ts';
import { criticalSectionBudgetMs, withDeadlineBudget } from './deadline.ts';
import { maintenancePassStatements } from './maintenance-eligibility-service.ts';
import { type NarInfoObjectsService } from './narinfo-objects-service.ts';
import {
	bootstrapKeyId,
	byPublicKey,
	keyEntry,
	type SigningKey,
	signingKeyFromRow,
	signingKeyName,
	storedSignaturesSchema
} from './signing-keys.ts';
import { affordableOperations } from './statement-scope.ts';

const sequenceId = 'singleton';

// Staging re-signs rows and writes them to the Durable Object's local SQLite
// database. Its size is independent of the D1 statement calculations below.
const backfillBatchSize = 32;

// Publishing one continuation entry reads the shared blob row from which its
// narinfo is rendered. The publish then re-renders the entry if the row changed
// while that read was in flight, reads the shared blob row again to confirm the
// written object, probes the path's committed reference edge, and renders the
// narinfo once more.
const statementsPerBackfillEntry = 5;

/**
 * How many entries of a continuation one backfill pass publishes.
 *
 * The alarm runs one D1-issuing maintenance pass per invocation, so the pass may
 * spend the whole per-invocation allowance on publication. A pass that reaches
 * this many entries settles them, keeps the rest in the continuation, and wakes
 * the alarm for another pass.
 *
 * This value is a page limit. The D1 binding enforces the invocation allowance
 * if an entry requires more statements than the estimate, and the pass then
 * publishes fewer entries.
 */
export const backfillEntriesPerPass = Math.floor(
	maintenancePassStatements / statementsPerBackfillEntry
);

const purgeEntrySchema = z.strictObject({
	cacheId: cacheIdSchema,
	storePathHash: storePathHashSchema,
	narInfoGeneration: narInfoGenerationSchema,
	targetGeneration: signingKeyGenerationSchema,
	tag: z.string()
});
type PurgeEntry = z.output<typeof purgeEntrySchema>;

const purgeEntriesSchema = z.array(purgeEntrySchema).min(1).max(100);

type BackfillRow = typeof schema.signingKeyBackfills.$inferSelect;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class SigningKeysService {
	private keysPromise: Promise<readonly SigningKey[]> | undefined;
	private publicKeyBody: TextBody | undefined;

	constructor(
		private readonly context: ServerContext,
		private readonly narInfoObjects: NarInfoObjectsService
	) {}

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
				.where(lt(schema.narInfos.signatureGeneration, generation))
				.get()?.value ?? 0
		);
	}

	private hasRemaining(generation: SigningKeyGeneration): boolean {
		return (
			this.context.db
				.select({ cache: schema.narInfos.cacheId })
				.from(schema.narInfos)
				.where(lt(schema.narInfos.signatureGeneration, generation))
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

		if (existing.state === 'complete') {
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

	private async stageBackfill(row: BackfillRow): Promise<number> {
		return this.context.criticalSection(async () => {
			const rows = this.context.db
				.select()
				.from(schema.narInfos)
				.where(
					and(
						lt(schema.narInfos.signatureGeneration, row.generation),
						isNull(schema.narInfos.pendingSignatureGeneration)
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
				const references = referencesSchema.parse(
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

			const createdAt = isoTimestamp(new Date());
			const expiresAt = isoTimestamp(
				new Date(Date.now() + narInfoCacheTtlSeconds * 1000)
			);
			const continuationId = crypto.randomUUID();
			const entries: PurgeEntry[] = [];

			this.context.db.transaction((tx) => {
				for (const item of rendered) {
					const updated = tx
						.update(schema.narInfos)
						.set({
							sigsJson: JSON.stringify(item.sigs),
							pendingSignatureGeneration: row.generation
						})
						.where(
							and(
								eq(schema.narInfos.cacheId, item.row.cacheId),
								eq(schema.narInfos.storePathHash, item.row.storePathHash),
								eq(schema.narInfos.generation, item.row.generation),
								isNull(schema.narInfos.pendingSignatureGeneration)
							)
						)
						.returning({
							cacheId: schema.narInfos.cacheId,
							storePathHash: schema.narInfos.storePathHash,
							generation: schema.narInfos.generation
						})
						.all()[0];

					if (updated === undefined) {
						continue;
					}

					const cache = this.context.cacheRepository.resolvedForId(
						updated.cacheId
					);
					entries.push({
						cacheId: updated.cacheId,
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
	 * Records the entries this pass published and removes them from the
	 * continuation. The continuation row survives while `remaining` holds the
	 * entries a later pass still has to publish.
	 */
	private settleContinuation(
		continuation: typeof schema.cachePurgeContinuations.$inferSelect,
		entries: readonly PurgeEntry[],
		remaining: readonly PurgeEntry[],
		now: IsoTimestamp
	): void {
		this.context.db.transaction((tx) => {
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

			if (remaining.length > 0) {
				tx.update(schema.cachePurgeContinuations)
					.set({ entriesJson: JSON.stringify(remaining) })
					.where(eq(schema.cachePurgeContinuations.id, continuation.id))
					.run();

				return;
			}

			tx.delete(schema.cachePurgeContinuations)
				.where(eq(schema.cachePurgeContinuations.id, continuation.id))
				.run();
		});
	}

	/**
	 * Publishes as many entries of the oldest backfill continuation as one
	 * invocation's D1 allowance covers, purges their cache tags, and records them.
	 *
	 * Reports `partial` when entries remain, so the caller wakes the alarm for
	 * another pass rather than staging more work on top of them.
	 *
	 * If publication or cache-tag purging fails, the pass removes none of the
	 * selected entries from the continuation. A later pass retries the same
	 * leading page and may publish the same objects again.
	 */
	private async processContinuation(): Promise<
		'none' | 'settled' | 'partial' | 'retrying'
	> {
		const continuation = this.context.db
			.select()
			.from(schema.cachePurgeContinuations)
			.where(eq(schema.cachePurgeContinuations.kind, 'backfill'))
			.orderBy(schema.cachePurgeContinuations.createdAt)
			.get();

		if (continuation === undefined) {
			return 'none';
		}

		const queued = purgeEntriesSchema.parse(
			JSON.parse(continuation.entriesJson) as unknown
		);
		// A publication that fails removes no entry from the continuation, so the
		// page must be one the invocation's allowance covers in full. Otherwise
		// the entry the binding refused would fail the same page on every pass.
		const affordable = Math.min(
			backfillEntriesPerPass,
			affordableOperations(statementsPerBackfillEntry)
		);
		const entries = queued.slice(0, affordable);
		const remaining = queued.slice(affordable);
		const now = isoTimestamp(new Date());

		try {
			await withDeadlineBudget(criticalSectionBudgetMs, () =>
				this.publishContinuationEntries(entries)
			);
		} catch (error) {
			const message = errorMessage(error);
			this.context.db
				.update(schema.cachePurgeContinuations)
				.set({ lastAttemptAt: now, lastError: message })
				.where(eq(schema.cachePurgeContinuations.id, continuation.id))
				.run();

			if (continuation.signingKeyId !== null) {
				this.markRetrying(continuation.signingKeyId, 'resigning', now, message);
			}

			await armAlarmNoLaterThan(
				this.context.ctx.storage,
				Date.now() + noProgressRetryMs
			);
			return 'retrying';
		}

		try {
			await this.context.purgeCacheTags(entries.map((entry) => entry.tag));
			this.settleContinuation(continuation, entries, remaining, now);

			return remaining.length > 0 ? 'partial' : 'settled';
		} catch (error) {
			const message = errorMessage(error);
			this.context.db
				.update(schema.cachePurgeContinuations)
				.set({ lastAttemptAt: now, lastError: message })
				.where(eq(schema.cachePurgeContinuations.id, continuation.id))
				.run();

			if (continuation.signingKeyId !== null) {
				this.markRetrying(
					continuation.signingKeyId,
					'cache-purge',
					now,
					message
				);
			}

			await armAlarmNoLaterThan(
				this.context.ctx.storage,
				Date.now() + noProgressRetryMs
			);
			return 'retrying';
		}
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
	 * Whether a re-signing backfill or one of its queued cache-tag purges
	 * remains outstanding.
	 *
	 * The alarm calls this before running the backfill. Both queries use the
	 * Durable Object's local SQLite database.
	 */
	hasBackfillWork(): boolean {
		const continuation = this.context.db
			.select({ id: schema.cachePurgeContinuations.id })
			.from(schema.cachePurgeContinuations)
			.where(eq(schema.cachePurgeContinuations.kind, 'backfill'))
			.limit(1)
			.get();

		if (continuation !== undefined) {
			return true;
		}

		const backfill = this.context.db
			.select({ keyId: schema.signingKeyBackfills.keyId })
			.from(schema.signingKeyBackfills)
			.where(ne(schema.signingKeyBackfills.state, 'complete'))
			.limit(1)
			.get();

		return backfill !== undefined;
	}

	async runBackfillOnce(): Promise<void> {
		const purge = await this.processContinuation();

		if (purge === 'retrying') {
			return;
		}

		// Staging another batch while entries are still queued would grow the
		// backlog faster than the passes drain it.
		if (purge === 'partial') {
			await this.context.ctx.storage.setAlarm(Date.now());

			return;
		}

		const row = this.context.db
			.select()
			.from(schema.signingKeyBackfills)
			.where(ne(schema.signingKeyBackfills.state, 'complete'))
			.orderBy(schema.signingKeyBackfills.startedAt)
			.get();

		if (row === undefined) {
			return;
		}

		if (this.completeIfDrained(row)) {
			return;
		}

		try {
			await this.stageBackfill(row);
		} catch (error) {
			const failedAt = isoTimestamp(new Date());
			this.markRetrying(row.keyId, 'resigning', failedAt, errorMessage(error));
			await armAlarmNoLaterThan(
				this.context.ctx.storage,
				Date.now() + noProgressRetryMs
			);
			return;
		}

		await this.context.ctx.storage.setAlarm(Date.now());
	}
}
