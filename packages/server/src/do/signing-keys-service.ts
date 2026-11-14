import {
	InvalidNixSha256HashError,
	InvalidStorePathError
} from '@cupboard/nix-store/errors';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { narFingerprint, type NarInfo } from '@cupboard/nix-store/narinfo';
import { NixPublicKey } from '@cupboard/nix-store/public-key';
import {
	type CacheScope,
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
	BackfillEntryDefect,
	BackfillStatusInput,
	KeyAbortResponseInput,
	KeyListResponseInput,
	KeyRetireResponseInput,
	KeyRotateResponseInput,
	SigningKeyEntryInput,
	UnpublishableStorePathsInput
} from '@cupboard/protocol/keys';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import {
	and,
	count,
	eq,
	gt,
	gte,
	isNull,
	lt,
	ne,
	type SQL,
	sql
} from 'drizzle-orm';
import type { SQLiteUpdateSetSource } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';

import {
	generateSigningKey,
	generateSigningKeyMaterial,
	signNixFingerprint
} from '../crypto/crypto.ts';
import {
	type CacheId,
	cacheIdSchema,
	type ResolvedCache
} from '../db/cache.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import {
	BackfillEntryInvalidError,
	CacheIdentityMissingError,
	LastSigningKeyError,
	SigningKeyBackfillIncompleteError,
	SigningKeyInstanceMissingError,
	SigningKeyRotationAbortNotAllowedError,
	SigningKeyRotationInProgressError,
	SigningKeySequenceMissingError,
	SigningKeyVanishedError,
	StoredReferencesInvalidError,
	StoredSignaturesInvalidError
} from '../errors.ts';
import { narInfoCacheTag } from '../http/cache-tags.ts';
import {
	narInfoCacheTtlSeconds,
	TextBody as CachedTextBody,
	type TextBody
} from '../http/http.ts';
import { parseStored } from '../http/parse.ts';

import {
	armAlarmNoLaterThan,
	type MaintenanceProgress,
	noProgressRetryMs
} from './alarm.ts';
import {
	type BackfillPurgeClaim,
	BackfillPurgePace
} from './backfill-purge-pace.ts';
import { CachePurgeBackoff } from './cache-purge-backoff.ts';
import {
	cachePurgeBackoffCapMs,
	CachePurgeRetryPolicy,
	isRateLimitedPurgeFailure
} from './cache-purge-retry.ts';
import {
	type SchemaWriter,
	type ServerContext,
	tagsPerPurgeRequest
} from './context.ts';
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
// keeps this many rows without a recorded failure queued, so the request is
// full when the pace allows it. A row with a recorded failure joins only the
// requests of other rows with failures, so it does not count.
const backfillRowsPerRequest = Math.ceil(
	tagsPerPurgeRequest / backfillBatchSize
);

// The `priority` of a backfill row. The index on `(kind, priority,
// created_at)` lists the rows without a failure first and the rows with
// failures after them, each oldest first. Each failure writes the failed
// entries to a new row, so of the rows with failures, the oldest failed least
// recently.
const unfailedBackfillPriority = 1;
const failingBackfillPriority = 2;

// The storage key of the earliest time at which this tenant may send the
// request of another row with a recorded failure.
const failingRowTurnKey = 'cache-purge:backfill-failing-turn';

const failingRowTurnSchema = z.strictObject({ notBefore: z.number() });

// A tenant sends at most one request for rows with a recorded failure in this
// time, however many of its rows have failures. The rows that keep failing use
// at most one slot of the deployment's backfill pace every 5 minutes for each
// tenant.
const failingRowTurnMs = cachePurgeBackoffCapMs;

// The failed attempt at which the backfill sets an entry aside instead of
// moving it to another row with failures. The second attempt comes at the
// tenant's next turn, which can be the next pass, and the third comes a turn
// later, so an entry is set aside about 5 minutes after its first failure.
const backfillEntryAttemptLimit = 3;

// The most set-aside store paths that the status of one key lists.
const listedUnpublishableStorePaths = 100;

// The storage key of the backfill's wait after a failure of a whole attempt,
// and the number of consecutive such failures.
const attemptRetryKey = 'cache-purge:backfill-retry';

const attemptRetrySchema = z.strictObject({
	notBefore: z.number(),
	failures: z.number().int().positive()
});

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

type NarInfoRow = typeof schema.narInfos.$inferSelect;

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
	| { readonly kind: 'kept' }
	| { readonly kind: 'deleted' }
	| { readonly kind: 'missing' };

// An entry that its stored row keeps from being published, and the error.
interface PublicationFailure {
	readonly entry: PurgeEntry;
	readonly error: BackfillEntryInvalidError;
}

// The entries of one row that their stored rows keep from being published,
// and the number of failed attempts that includes this one. Below
// `backfillEntryAttemptLimit` they move to a new row with the failure
// recorded, and at the limit they are set aside.
interface FailedEntries {
	readonly failures: readonly PublicationFailure[];
	readonly failedAttempts: number;
}

// The backfill row whose request is sent next, and the earliest time at which
// it may be sent, before the shared rate-limit wait and the pace.
interface NextBackfillRow {
	readonly row: ContinuationRow;
	readonly dueAt: number;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// The fields of a narinfo, as rendering names them when it rejects one.
const narInfoFields = [
	'storePath',
	'url',
	'compression',
	'fileHash',
	'fileSize',
	'narHash',
	'narSize',
	'references',
	'deriver',
	'ca',
	'sigs'
] as const satisfies readonly BackfillEntryDefect[];

// The part of a stored narinfo row that `error` shows to be invalid. Building
// parses the references, the signatures, the store path and the hashes, and
// rendering validates every field and names the first that it rejects. A hash
// that does not parse is attributed to the NAR hash or the file hash when
// `hashes` contains the value, because the two are stored in different rows.
function narInfoDefect(
	error: unknown,
	hashes?: { readonly narHash: string; readonly fileHash?: string }
): BackfillEntryDefect {
	if (error instanceof StoredReferencesInvalidError) {
		return 'references';
	}

	if (error instanceof StoredSignaturesInvalidError) {
		return 'sigs';
	}

	if (error instanceof InvalidStorePathError) {
		return 'storePath';
	}

	if (error instanceof InvalidNixSha256HashError) {
		if (error.value === hashes?.fileHash) {
			return 'fileHash';
		}

		return error.value === hashes?.narHash ? 'narHash' : 'hash';
	}

	if (!(error instanceof z.ZodError)) {
		return 'unknown';
	}

	const field = error.issues.at(0)?.path.at(0);

	return narInfoFields.find((name) => name === field) ?? 'unknown';
}

// The failed entries of one row, or undefined when none of them failed.
function failedEntries(
	row: ContinuationRow,
	failures: readonly PublicationFailure[]
): FailedEntries | undefined {
	if (failures.length === 0) {
		return undefined;
	}

	return { failures, failedAttempts: row.failedAttempts + 1 };
}

function isSetAside(failed: FailedEntries): boolean {
	return failed.failedAttempts >= backfillEntryAttemptLimit;
}

/**
A condition on `narinfo` that is false for a narinfo that the backfill of
`generation`, or of a later generation, set aside. The backfill neither stages
such a narinfo again nor counts it as remaining. A later backfill tried the
narinfo again, so its set-aside row is the current one, and the rows of
earlier generations are deleted when it completes. A set-aside row applies
only to the narinfo generation that it records, so a re-commit of the path is
counted again.
*/
function notSetAside(generation: SigningKeyGeneration): SQL {
	const table = schema.backfillUnpublishableNarInfos;

	return sql`NOT EXISTS (SELECT 1 FROM ${table} WHERE ${table.cacheId} = ${schema.narInfos.cacheId} AND ${table.storePathHash} = ${schema.narInfos.storePathHash} AND ${table.targetGeneration} >= ${generation} AND ${table.narInfoGeneration} = ${schema.narInfos.generation})`;
}

// The backfill fields of a key whose backfill has just recorded a failure.
function retryingProgress(
	operation: 'resigning' | 'cache-purge',
	failedAt: IsoTimestamp,
	message: string
): SQLiteUpdateSetSource<typeof schema.signingKeyBackfills> {
	return {
		state: 'retrying',
		updatedAt: failedAt,
		failureOperation: operation,
		failedAt,
		failureMessage: message
	};
}

export class SigningKeysService {
	private keysPromise: Promise<readonly SigningKey[]> | undefined;
	private publicKeyBody: TextBody | undefined;
	private readonly purgeBackoff: CachePurgeBackoff;

	constructor(
		private readonly context: ServerContext,
		private readonly narInfoObjects: NarInfoObjectsService,
		private readonly purgeRetryPolicy: CachePurgeRetryPolicy = new CachePurgeRetryPolicy(),
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
						narInfoOfLiveCache(),
						notSetAside(generation)
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
						narInfoOfLiveCache(),
						notSetAside(generation)
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
		const unpublishable = this.unpublishable(row.generation);
		const unpublishableField =
			unpublishable === undefined ? {} : { unpublishable };

		if (row.state === 'complete' && row.completedAt !== null) {
			return {
				state: 'complete',
				startedAt: row.startedAt,
				completedAt: row.completedAt,
				resigned: row.resigned,
				...unpublishableField
			};
		}

		const common = {
			startedAt: row.startedAt,
			updatedAt: row.updatedAt,
			resigned: row.resigned,
			remaining: this.remaining(row.generation),
			...unpublishableField
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

	// The narinfos that the backfill of `generation` set aside and that still
	// lack its signature, or undefined when there are none. A narinfo that has
	// been re-committed or deleted since then is not listed.
	private unpublishable(
		generation: SigningKeyGeneration
	): UnpublishableStorePathsInput | undefined {
		const table = schema.backfillUnpublishableNarInfos;
		const condition = and(
			eq(table.targetGeneration, generation),
			lt(schema.narInfos.signatureGeneration, generation),
			narInfoOfLiveCache()
		);
		const joined = and(
			eq(schema.narInfos.cacheId, table.cacheId),
			eq(schema.narInfos.storePathHash, table.storePathHash),
			eq(schema.narInfos.generation, table.narInfoGeneration)
		);
		const total =
			this.context.db
				.select({ value: count() })
				.from(table)
				.innerJoin(schema.narInfos, joined)
				.where(condition)
				.get()?.value ?? 0;

		if (total === 0) {
			return undefined;
		}

		const rows = this.context.db
			.select({
				storePath: schema.narInfos.storePath,
				cacheId: table.cacheId,
				defect: table.defect,
				setAsideAt: table.setAsideAt
			})
			.from(table)
			.innerJoin(schema.narInfos, joined)
			.where(condition)
			.orderBy(schema.narInfos.storePath)
			.limit(listedUnpublishableStorePaths)
			.all();

		return {
			total,
			storePaths: rows.map((row) => ({
				storePath: row.storePath,
				...this.cacheOf(row.cacheId),
				defect: row.defect,
				setAsideAt: row.setAsideAt
			}))
		};
	}

	// The scope of a cache for a status listing. A narinfo whose cache is
	// missing from the cache registry is listed without one.
	private cacheOf(cacheId: CacheId): { cache?: CacheScope } {
		const cache = this.registeredCache(cacheId);

		return cache === undefined ? {} : { cache: cache.scope };
	}

	private entries(keys: readonly SigningKey[]): SigningKeyEntryInput[] {
		const backfills = new Map(
			this.context.db
				.select()
				.from(schema.signingKeyBackfills)
				.all()
				.map((row) => [row.keyId, this.backfillStatus(row)] as const)
		);

		return keys.map((key) =>
			keyEntry(key, backfills.get(key.id), this.unpublishableSignedBy(key))
		);
	}

	// The number of set-aside narinfos whose published narinfo has `key`'s
	// signature. Each narinfo counts once, also while the rows of two
	// backfills set it aside. Staging writes the signatures of the current
	// signing keys into a row before it is published, so the stored
	// signatures also include those that were never published. A narinfo was
	// last published at its signature generation, so only a key of that
	// generation or earlier can have signed the published narinfo.
	private unpublishableSignedBy(key: SigningKey): number {
		const table = schema.backfillUnpublishableNarInfos;
		const narInfos = schema.narInfos;

		return (
			this.context.db
				.select({
					value: sql<number>`count(distinct ${table.cacheId} || ':' || ${table.storePathHash})`
				})
				.from(table)
				.innerJoin(
					narInfos,
					and(
						eq(narInfos.cacheId, table.cacheId),
						eq(narInfos.storePathHash, table.storePathHash),
						eq(narInfos.generation, table.narInfoGeneration)
					)
				)
				.where(
					and(
						lt(narInfos.signatureGeneration, table.targetGeneration),
						gte(narInfos.signatureGeneration, key.generation),
						sql`instr(${narInfos.sigsJson}, ${`"${key.publicKey.name}:`}) > 0`,
						narInfoOfLiveCache()
					)
				)
				.get()?.value ?? 0
		);
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
	// can drain it. A batch of narinfos that all fail adds no row without a
	// failure, so the pass also stops after as many batches as fill one
	// request, and `backfillWorkAt` makes the next pass due at once.
	private async stageBackfills(row: BackfillRow): Promise<void> {
		for (let batch = 0; batch < backfillRowsPerRequest; batch += 1) {
			if (
				this.unfailedBackfillRowCount() >= backfillRowsPerRequest ||
				(await this.stageBackfill(row)) === 0
			) {
				return;
			}
		}
	}

	// Whether staging would add rows: fewer rows without a failure are queued
	// than fill one request, and a narinfo remains to be staged.
	private isStagingDue(generation: SigningKeyGeneration): boolean {
		if (this.unfailedBackfillRowCount() >= backfillRowsPerRequest) {
			return false;
		}

		return (
			this.context.db
				.select({ cache: schema.narInfos.cacheId })
				.from(schema.narInfos)
				.where(
					and(
						lt(schema.narInfos.signatureGeneration, generation),
						isNull(schema.narInfos.pendingSignatureGeneration),
						narInfoOfLiveCache(),
						notSetAside(generation)
					)
				)
				.limit(1)
				.get() !== undefined
		);
	}

	private unfailedBackfillRowCount(): number {
		const table = schema.cachePurgeContinuations;

		return (
			this.context.db
				.select({ rows: count() })
				.from(table)
				.where(
					and(
						eq(table.kind, 'backfill'),
						eq(table.priority, unfailedBackfillPriority)
					)
				)
				.all()
				.at(0)?.rows ?? 0
		);
	}

	// The fields that record progress on a key's backfill. The failure stays
	// reported while a row of the key has a recorded failure, because that
	// row's entries remain unsigned until one of its retries succeeds.
	private backfillProgress(
		tx: SchemaWriter,
		keyId: string,
		now: IsoTimestamp
	): SQLiteUpdateSetSource<typeof schema.signingKeyBackfills> {
		const table = schema.cachePurgeContinuations;
		const failing = tx
			.select({ id: table.id })
			.from(table)
			.where(
				and(
					eq(table.kind, 'backfill'),
					eq(table.priority, failingBackfillPriority),
					eq(table.signingKeyId, keyId)
				)
			)
			.limit(1)
			.get();

		if (failing !== undefined) {
			return { updatedAt: now };
		}

		return {
			state: 'running',
			updatedAt: now,
			failureOperation: sql`null`,
			failedAt: sql`null`,
			failureMessage: sql`null`
		};
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
						narInfoOfLiveCache(),
						notSetAside(row.generation)
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
			const rendered: { row: NarInfoRow; sigs?: string[] }[] = [];
			const invalid = new Map<NarInfoRow, BackfillEntryInvalidError>();

			for (const narInfoRow of rows) {
				const parsed = this.signatureInputs(narInfoRow);

				if (parsed instanceof BackfillEntryInvalidError) {
					invalid.set(narInfoRow, parsed);
					rendered.push({ row: narInfoRow });
					continue;
				}

				const sigs = await this.signaturesFor(
					parsed.fingerprint,
					parsed.existing,
					keys
				);
				rendered.push({ row: narInfoRow, sigs });
			}

			const createdAt = isoTimestamp(new Date(this.now()));
			const expiresAt = isoTimestamp(
				new Date(this.now() + narInfoCacheTtlSeconds * 1000)
			);
			const continuationId = crypto.randomUUID();
			const entries: PurgeEntry[] = [];
			const failures: PublicationFailure[] = [];
			let unregistered = 0;

			this.context.db.transaction((tx) => {
				for (const item of rendered) {
					const cache = this.registeredCache(item.row.cacheId);

					// The entry's purge tag needs the cache's scope, and no code
					// path restores a cache identity, so the narinfo is set
					// aside at once.
					if (cache === undefined) {
						this.insertUnpublishable(tx, {
							cacheId: item.row.cacheId,
							storePathHash: item.row.storePathHash,
							targetGeneration: row.generation,
							narInfoGeneration: item.row.generation,
							defect: 'cacheIdentity',
							failedAttempts: 1,
							setAsideAt: createdAt
						});
						unregistered += 1;
						continue;
					}

					// A narinfo that cannot be re-signed keeps its signatures. It
					// is still marked as pending, so staging does not read it
					// again while its entry waits in a row with failures.
					// Publication signs it before it publishes it.
					const updated = tx
						.update(schema.narInfos)
						.set({
							...(item.sigs !== undefined && {
								sigsJson: JSON.stringify(item.sigs)
							}),
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

					const entry = {
						cacheId: cache.id,
						storePathHash: updated.storePathHash,
						narInfoGeneration: updated.generation,
						targetGeneration: row.generation,
						tag: narInfoCacheTag(
							this.context.requireTenant(),
							cache.scope,
							updated.storePathHash
						)
					};
					const error = invalid.get(item.row);

					if (error === undefined) {
						entries.push(entry);
					} else {
						failures.push({ entry, error });
					}
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

				// A failure at staging is the entry's first, so its entry goes to a
				// row with failures.
				const firstFailure = failures.at(0);
				this.recordFailedEntries(
					tx,
					row.keyId,
					expiresAt,
					{ failures, failedAttempts: 1 },
					createdAt
				);

				tx.update(schema.signingKeyBackfills)
					.set(
						firstFailure === undefined
							? this.backfillProgress(tx, row.keyId, createdAt)
							: retryingProgress(
									'resigning',
									createdAt,
									firstFailure.error.message
								)
					)
					.where(eq(schema.signingKeyBackfills.keyId, row.keyId))
					.run();
			});

			return entries.length + failures.length + unregistered;
		});
	}

	// The cache of a narinfo row, or undefined when the cache is missing from
	// the cache registry.
	private registeredCache(cacheId: CacheId): ResolvedCache | undefined {
		try {
			return this.context.cacheRepository.resolvedForId(cacheId);
		} catch (error) {
			if (error instanceof CacheIdentityMissingError) {
				return undefined;
			}

			throw error;
		}
	}

	// The fingerprint and the stored signatures of a narinfo row, or the
	// defect that keeps the row from being re-signed.
	private signatureInputs(
		row: NarInfoRow
	):
		| BackfillEntryInvalidError
		| { readonly fingerprint: NixFingerprint; readonly existing: string[] } {
		try {
			const references = parseStored(
				storedReferencesSchema,
				row.referencesJson,
				(cause) => new StoredReferencesInvalidError(row.storePathHash, cause)
			);
			const existing = parseStored(
				storedSignaturesSchema,
				row.sigsJson,
				(cause) => new StoredSignaturesInvalidError(row.storePathHash, cause)
			);
			// The fingerprint takes the NAR hash as text and does not check it.
			// Parsing it here reports a hash that does not parse as a defect of
			// the narinfo row, not as a missing blob row.
			NixSha256Hash.parse(row.narHash);
			const fingerprint = narFingerprint(
				new StorePath(row.storePath),
				row.narHash,
				row.narSize,
				references
			);

			return { fingerprint, existing };
		} catch (error) {
			return new BackfillEntryInvalidError(
				row.storePathHash,
				narInfoDefect(error, { narHash: row.narHash })
			);
		}
	}

	/**
	Records the entries of `failed`. Below `backfillEntryAttemptLimit` they
	move to a new row with failures, which records the first entry's error.
	At the limit each entry is set aside: its narinfo is no longer pending,
	and a `backfill_unpublishable_narinfo` row records its defect. An entry
	whose narinfo has changed since it was staged is not set aside, because
	staging reads the changed narinfo again if it still lacks the signature.
	*/
	private recordFailedEntries(
		tx: SchemaWriter,
		signingKeyId: string | null,
		expiresAt: IsoTimestamp,
		failed: FailedEntries,
		now: IsoTimestamp
	): void {
		const first = failed.failures.at(0);

		if (first === undefined) {
			return;
		}

		if (!isSetAside(failed)) {
			tx.insert(schema.cachePurgeContinuations)
				.values({
					id: crypto.randomUUID(),
					kind: 'backfill',
					signingKeyId,
					entriesJson: JSON.stringify(
						failed.failures.map((failure) => failure.entry)
					),
					createdAt: now,
					expiresAt,
					lastAttemptAt: now,
					lastError: first.error.message,
					failedAttempts: failed.failedAttempts,
					priority: failingBackfillPriority
				})
				.run();

			return;
		}

		for (const { entry, error } of failed.failures) {
			const released = tx
				.update(schema.narInfos)
				.set({ pendingSignatureGeneration: sql`null` })
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
				.returning({ generation: schema.narInfos.generation })
				.all();

			if (released.length === 0) {
				continue;
			}

			this.insertUnpublishable(tx, {
				cacheId: entry.cacheId,
				storePathHash: entry.storePathHash,
				targetGeneration: entry.targetGeneration,
				narInfoGeneration: entry.narInfoGeneration,
				defect: error.defect,
				failedAttempts: failed.failedAttempts,
				setAsideAt: now
			});
		}
	}

	private insertUnpublishable(
		tx: SchemaWriter,
		values: typeof schema.backfillUnpublishableNarInfos.$inferInsert
	): void {
		const table = schema.backfillUnpublishableNarInfos;
		tx.insert(table)
			.values(values)
			.onConflictDoUpdate({
				target: [table.cacheId, table.storePathHash, table.targetGeneration],
				set: {
					narInfoGeneration: values.narInfoGeneration,
					defect: values.defect,
					failedAttempts: values.failedAttempts,
					setAsideAt: values.setAsideAt
				}
			})
			.run();
	}

	// Publishes every entry, and returns the entries that their stored rows
	// keep from being published. Such an entry does not keep the others from
	// being published and signed. A read or a write that fails throws, and so
	// does a deadline that expires during the loop, in `withDeadlineBudget`:
	// those are failures of the whole attempt. The entries in `failedBefore`
	// come from rows with failures, and are signed again before they are
	// published.
	private async publishContinuationEntries(
		entries: readonly PurgeEntry[],
		failedBefore: ReadonlySet<PurgeEntry>
	): Promise<PublicationFailure[]> {
		const failures: PublicationFailure[] = [];

		for (const entry of entries) {
			const failure = await this.publishContinuationEntry(
				entry,
				failedBefore.has(entry)
			);

			if (failure !== undefined) {
				failures.push(failure);
			}
		}

		return failures;
	}

	private async publishContinuationEntry(
		entry: PurgeEntry,
		hasFailedBefore: boolean
	): Promise<PublicationFailure | undefined> {
		const row = this.context.db
			.select()
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cacheId, entry.cacheId),
					eq(schema.narInfos.storePathHash, entry.storePathHash),
					eq(schema.narInfos.generation, entry.narInfoGeneration),
					eq(schema.narInfos.pendingSignatureGeneration, entry.targetGeneration)
				)
			)
			.get();

		if (row === undefined) {
			return undefined;
		}

		const cache = this.registeredCache(entry.cacheId);

		if (cache === undefined) {
			return {
				entry,
				error: new BackfillEntryInvalidError(
					entry.storePathHash,
					'cacheIdentity'
				)
			};
		}

		const signed = hasFailedBefore ? await this.signedRow(row, entry) : row;

		if (signed === undefined) {
			return undefined;
		}

		if (signed instanceof BackfillEntryInvalidError) {
			return { entry, error: signed };
		}

		const blob = await this.narInfoObjects.blobFields(signed.narHash);

		// Without the blob row the pass cannot write the narinfo object, so the
		// object that readers are served keeps its old signatures. Recording
		// the entry as signed would hide it from the key's status.
		if (blob === undefined) {
			return {
				entry,
				error: new BackfillEntryInvalidError(entry.storePathHash, 'blobState')
			};
		}

		let narInfo: NarInfo;

		try {
			narInfo = this.narInfoObjects.buildNarInfo(signed, blob);
			narInfo.render();
		} catch (error) {
			return {
				entry,
				error: new BackfillEntryInvalidError(
					entry.storePathHash,
					narInfoDefect(error, {
						narHash: signed.narHash,
						fileHash: blob.fileHash
					})
				)
			};
		}

		await this.narInfoObjects.publishNarInfoObject(
			cache,
			entry.storePathHash,
			entry.narInfoGeneration,
			signed.narHash,
			narInfo
		);

		return undefined;
	}

	/**
	The pending narinfo row of `entry` with the signatures of every signing key
	over its current fingerprint, or the defect that keeps it from being signed.
	Publication calls this for the entries of rows with failures. Staging keeps
	the old signatures of a row that does not parse, and a repair of a row
	between attempts changes its fingerprint, so the signatures that staging
	wrote cannot be relied on for such an entry. A settled entry is recorded as
	signed by the target key. Returns undefined when the row changed while it
	was being signed.
	*/
	private async signedRow(
		row: NarInfoRow,
		entry: PurgeEntry
	): Promise<BackfillEntryInvalidError | NarInfoRow | undefined> {
		const inputs = this.signatureInputs(row);

		if (inputs instanceof BackfillEntryInvalidError) {
			return inputs;
		}

		const sigsJson = JSON.stringify(
			await this.signaturesFor(
				inputs.fingerprint,
				inputs.existing,
				await this.loadedKeys()
			)
		);

		if (sigsJson === row.sigsJson) {
			return row;
		}

		const updated = this.context.db
			.update(schema.narInfos)
			.set({ sigsJson })
			.where(
				and(
					eq(schema.narInfos.cacheId, entry.cacheId),
					eq(schema.narInfos.storePathHash, entry.storePathHash),
					eq(schema.narInfos.generation, entry.narInfoGeneration),
					eq(schema.narInfos.pendingSignatureGeneration, entry.targetGeneration)
				)
			)
			.returning({ generation: schema.narInfos.generation })
			.all();

		return updated.length === 0 ? undefined : { ...row, sigsJson };
	}

	/**
	Records the entries this pass published and removes them from the
	continuation. The continuation row remains while `remaining` contains
	entries that a later pass still has to publish. `failed` moves the entries
	whose publication failed to a new row with the failure recorded. Reports
	`deleted` when no entry remains, and otherwise `missing` if
	`abortKeyRotation` has deleted the row. The abort also clears the pending
	generation of the narinfo rows and deletes the backfill row in the same
	transaction, so the earlier writes then match no row, and no new row is
	written for the failed entries.
	*/
	private settleContinuation(
		continuation: ContinuationRow,
		entries: readonly PurgeEntry[],
		remaining: readonly PurgeEntry[],
		failed: FailedEntries | undefined,
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

			// The settled row is deleted or shortened, and the row of failed
			// entries is written, before the backfill row is updated. Otherwise
			// `backfillProgress` would see the failure that this request
			// resolved and miss the failure that it recorded.
			const settlement = this.settleContinuationRow(
				tx,
				continuation.id,
				remaining
			);

			if (failed !== undefined && settlement.kind !== 'missing') {
				this.recordFailedEntries(
					tx,
					continuation.signingKeyId,
					continuation.expiresAt,
					failed,
					now
				);
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
							...this.backfillProgress(tx, continuation.signingKeyId, now),
							resigned: backfill.resigned + resigned
						})
						.where(
							eq(schema.signingKeyBackfills.keyId, continuation.signingKeyId)
						)
						.run();
				}
			}

			return settlement;
		});
	}

	private settleContinuationRow(
		tx: SchemaWriter,
		id: string,
		remaining: readonly PurgeEntry[]
	): ContinuationSettlement {
		const table = schema.cachePurgeContinuations;

		if (remaining.length === 0) {
			const deleted = tx
				.delete(table)
				.where(eq(table.id, id))
				.returning({ id: table.id })
				.all();

			return { kind: deleted.length === 0 ? 'missing' : 'deleted' };
		}

		const kept = tx
			.update(table)
			.set({ entriesJson: JSON.stringify(remaining) })
			.where(eq(table.id, id))
			.returning({ id: table.id })
			.all();

		return { kind: kept.length === 0 ? 'missing' : 'kept' };
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

	// Fills one purge request. The page starts with `head`, the row from
	// `nextBackfillRow`, and continues with the rows of the same priority after
	// it, oldest first. Each entry is published separately, so an entry that
	// fails does not keep the others from being purged. A row with failures
	// joins only the requests of other rows with failures, because its turn
	// decides when it is sent.
	private backfillPage(head: ContinuationRow): BackfillPagePart[] {
		// The page must be one that the invocation's allowance covers in full.
		// Otherwise the binding would refuse a call part of the way through every
		// attempt at the same page, and each attempt would fail as a whole.
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

		if (first.entries.length >= limit) {
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
					eq(table.priority, head.priority),
					ne(table.id, head.id)
				)
			)
			.orderBy(table.createdAt)
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
	Sends one purge request for backfill continuation rows, and records the
	entries that it purged.

	{@link nextBackfillRow} chooses the row that starts the request. The pass
	reports `turn` without publishing when only rows with failures remain and
	the tenant's turn for them has not come. It reports `waiting` while a
	rate-limit refusal or a failed attempt of the whole backfill delays every
	request. It then claims the deployment's next backfill purge request from
	{@link BackfillPurgePace}. It reports `paced` when the deployment's last
	claim is less than one interval old, and it neither publishes nor purges
	until a claim succeeds. A D1 error in the claim is a failed attempt, and
	the pass reports `retrying`.

	With the claim, the pass publishes the entries of one page and purges the
	tags of the published entries in one request. The page starts with the
	chosen row and, up to the request's limit of 100 tags, continues with the
	rows of the same priority after it. An entry is not published when its
	narinfo cannot be built or rendered from its stored fields, when its cache
	is missing from the cache registry, or when its blob row is missing. The
	third failure sets the entry aside. The pass records the published
	entries of each row as signed, and moves the entries that it could not
	publish to a new row with a `BackfillEntryInvalidError` recorded. It reports `partial`
	while a backfill row remains, and `runBackfillOnce` then stages more rows
	and arms the alarm.

	Any other failure is a failure of the whole attempt: a D1 read or an R2
	write that fails for any entry, a deadline that expires during publication,
	or a purge request that fails. The pass then records no entry as signed and
	moves no entry. The row that started the page records the error, the key's
	backfill reports it, and the backfill as a whole waits for a retry time that
	grows with each consecutive failure of this kind. The pass reports
	`retrying`. The claim stays used, so the next request still waits for its
	interval.
	*/
	private async processContinuation(): Promise<
		'none' | 'turn' | 'settled' | 'partial' | 'retrying' | 'waiting' | 'paced'
	> {
		this.reclassifyEarlierFailedRows();
		const next = await this.nextBackfillRow(this.now());

		if (next === undefined) {
			return 'none';
		}

		if (next.dueAt > this.now()) {
			return 'turn';
		}

		const continuation = next.row;
		const dueAt = await this.attemptDueAt(this.now());

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

		if (continuation.priority === failingBackfillPriority) {
			await this.context.ctx.storage.put(failingRowTurnKey, {
				notBefore: this.now() + failingRowTurnMs
			});
		}

		const page = this.backfillPage(continuation);
		const entries = page.flatMap((part) => part.entries);
		const failedBefore = new Set(
			page
				.filter((part) => part.row.failedAttempts > 0)
				.flatMap((part) => part.entries)
		);
		let failures: PublicationFailure[];

		try {
			failures = await withDeadlineBudget(criticalSectionBudgetMs, () =>
				this.publishContinuationEntries(entries, failedBefore)
			);
		} catch (error) {
			await this.recordAttemptFailure(continuation, error, 'resigning', now);

			return 'retrying';
		}

		const failed = new Set(failures.map((failure) => failure.entry));
		const published = entries.filter((entry) => !failed.has(entry));

		if (published.length > 0) {
			try {
				await this.context.purgeCacheTags(published.map((entry) => entry.tag));
			} catch (error) {
				await this.recordAttemptFailure(
					continuation,
					error,
					'cache-purge',
					now
				);

				return 'retrying';
			}

			await this.purgeBackoff.recordSuccess();
			await this.forgetAttemptFailures();
		}

		this.settlePage(page, failures, now);

		if (this.hasBackfillContinuation()) {
			return 'partial';
		}

		await this.forgetBackfillWaits();

		return 'settled';
	}

	// Records a purged page. `abortKeyRotation` can delete a row while the
	// request is in flight. The settlement of that row matches nothing, and the
	// other rows still need theirs.
	private settlePage(
		page: readonly BackfillPagePart[],
		failures: readonly PublicationFailure[],
		now: IsoTimestamp
	): void {
		for (const part of page) {
			const partFailures = failures.filter((failure) =>
				part.entries.includes(failure.entry)
			);
			const failed = failedEntries(part.row, partFailures);
			const published = part.entries.filter((entry) =>
				partFailures.every((failure) => failure.entry !== entry)
			);
			const settlement = this.settleContinuation(
				part.row,
				published,
				part.remaining,
				failed,
				now
			);

			const firstFailure = failed?.failures.at(0);

			if (
				failed !== undefined &&
				firstFailure !== undefined &&
				!isSetAside(failed) &&
				settlement.kind !== 'missing' &&
				part.row.signingKeyId !== null
			) {
				this.markRetrying(
					part.row.signingKeyId,
					'resigning',
					now,
					firstFailure.error.message
				);
			}
		}
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

	// A failure of a whole attempt changes no row's entries, failure count or
	// order. The row that started the page records the error. A rate-limit
	// refusal sets the wait that the purge queue shares. Any other failure sets
	// the backfill's own wait, which grows with each consecutive failure of a
	// whole attempt, so every row waits and none of them moves.
	private async recordAttemptFailure(
		continuation: ContinuationRow,
		error: unknown,
		operation: 'resigning' | 'cache-purge',
		now: IsoTimestamp
	): Promise<void> {
		const failedAt = this.now();
		const message = errorMessage(error);
		this.context.db
			.update(schema.cachePurgeContinuations)
			.set({
				lastAttemptAt: isoTimestamp(new Date(failedAt)),
				lastError: message
			})
			.where(eq(schema.cachePurgeContinuations.id, continuation.id))
			.run();

		if (isRateLimitedPurgeFailure(error)) {
			await this.purgeBackoff.recordFailure(error, continuation, failedAt);
		} else {
			const previous = await this.attemptRetry();
			const failures = (previous?.failures ?? 0) + 1;
			await this.context.ctx.storage.put(attemptRetryKey, {
				notBefore: this.purgeRetryPolicy.nextAttemptAt(
					error,
					failures,
					failedAt
				),
				failures
			});
		}

		if (continuation.signingKeyId !== null) {
			this.markRetrying(continuation.signingKeyId, operation, now, message);
		}

		await armAlarmNoLaterThan(
			this.context.ctx.storage,
			await this.attemptDueAt(failedAt)
		);
	}

	private async attemptRetry(): Promise<
		z.infer<typeof attemptRetrySchema> | undefined
	> {
		const stored = await this.context.ctx.storage.get(attemptRetryKey);

		return stored === undefined ? undefined : attemptRetrySchema.parse(stored);
	}

	// The earliest time at which a backfill request may be sent: after the
	// shared rate-limit wait and after the backfill's own wait. A backfill row
	// has no retry time of its own, so a retry time that an earlier build wrote
	// on a row delays nothing.
	private async attemptDueAt(now: number): Promise<number> {
		const retry = await this.attemptRetry();

		return Math.max(
			await this.purgeBackoff.sharedDueAt(now),
			retry?.notBefore ?? now
		);
	}

	private async forgetAttemptFailures(): Promise<void> {
		if ((await this.attemptRetry()) === undefined) {
			return;
		}

		await this.context.ctx.storage.delete(attemptRetryKey);
	}

	private async forgetBackfillWaits(): Promise<void> {
		await this.context.ctx.storage.delete([failingRowTurnKey, attemptRetryKey]);
	}

	// An earlier build gave a row with a failure count priority 1 and a retry
	// time of its own. Such a row follows the rule of the rows with failures:
	// priority 2, and no retry time apart from the tenant's turn.
	private reclassifyEarlierFailedRows(): void {
		const table = schema.cachePurgeContinuations;
		this.context.db
			.update(table)
			.set({ priority: failingBackfillPriority, nextAttemptAt: sql`null` })
			.where(
				and(
					eq(table.kind, 'backfill'),
					eq(table.priority, unfailedBackfillPriority),
					gt(table.failedAttempts, 0)
				)
			)
			.run();
	}

	/**
	Chooses the backfill row whose request is sent next, and when it is due,
	before the shared waits and the pace.

	The oldest row with a recorded failure goes first when the tenant's turn
	has come: the tenant has sent no request for rows with failures in the last
	{@link failingRowTurnMs}. Otherwise the oldest row without a failure goes.
	When no such row remains, the oldest row with a failure goes at the next
	turn. Each failure writes the failed entries to a new row, so the rows with
	failures take their turns least recently failed first, and a row that
	always fails goes to the back after each attempt.

	However many rows have failures, they use at most one slot of the pace in
	each turn. Each query reads one row through the index on `(kind, priority,
	created_at)`.
	*/
	private async nextBackfillRow(
		now: number
	): Promise<NextBackfillRow | undefined> {
		const failing =
			this.oldestBackfillRow(failingBackfillPriority, 'any') ??
			this.oldestBackfillRow(unfailedBackfillPriority, 'failed');
		const turnAt =
			failing === undefined
				? undefined
				: Math.max(now, (await this.failingRowTurnAt()) ?? now);

		if (failing !== undefined && turnAt === now) {
			return { row: failing, dueAt: now };
		}

		const unfailed = this.oldestBackfillRow(
			unfailedBackfillPriority,
			'unfailed'
		);

		if (unfailed !== undefined) {
			return { row: unfailed, dueAt: now };
		}

		return failing === undefined || turnAt === undefined
			? undefined
			: { row: failing, dueAt: turnAt };
	}

	// The oldest backfill row of `priority` whose failure count matches
	// `failures`. Rows of priority 1 with a failure count come from an earlier
	// build until a pass gives them priority 2, so the choice of row reads them
	// as rows with failures. There are few rows of priority 1, so the filter on
	// the failure count reads few rows beyond the index.
	private oldestBackfillRow(
		priority: number,
		failures: 'any' | 'failed' | 'unfailed'
	): ContinuationRow | undefined {
		const table = schema.cachePurgeContinuations;
		const failureFilter = {
			any: undefined,
			failed: gt(table.failedAttempts, 0),
			unfailed: eq(table.failedAttempts, 0)
		}[failures];

		return this.context.db
			.select()
			.from(table)
			.where(
				and(
					eq(table.kind, 'backfill'),
					eq(table.priority, priority),
					failureFilter
				)
			)
			.orderBy(table.createdAt)
			.get();
	}

	private async failingRowTurnAt(): Promise<number | undefined> {
		const stored = await this.context.ctx.storage.get(failingRowTurnKey);

		return stored === undefined
			? undefined
			: failingRowTurnSchema.parse(stored).notBefore;
	}

	private markRetrying(
		keyId: string,
		operation: 'resigning' | 'cache-purge',
		failedAt: IsoTimestamp,
		message: string
	): void {
		this.context.db
			.update(schema.signingKeyBackfills)
			.set(retryingProgress(operation, failedAt, message))
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
		this.context.db.transaction((tx) => {
			tx.update(schema.signingKeyBackfills)
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
			// This backfill signed or set aside every narinfo that an earlier
			// backfill set aside, and `notSetAside` reads its rows for the
			// earlier generations too.
			tx.delete(schema.backfillUnpublishableNarInfos)
				.where(
					lt(
						schema.backfillUnpublishableNarInfos.targetGeneration,
						row.generation
					)
				)
				.run();
		});

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

			// A pass that ran while the previous rotation was aborted can have
			// written its turn or its wait after the abort removed them.
			await this.forgetBackfillWaits();
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

			this.context.db.transaction((tx) => {
				tx.delete(schema.signingKeys)
					.where(eq(schema.signingKeys.id, id))
					.run();
				tx.delete(schema.backfillUnpublishableNarInfos)
					.where(
						eq(
							schema.backfillUnpublishableNarInfos.targetGeneration,
							key.generation
						)
					)
					.run();
			});
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
				tx.delete(schema.backfillUnpublishableNarInfos)
					.where(
						eq(
							schema.backfillUnpublishableNarInfos.targetGeneration,
							backfill.generation
						)
					)
					.run();
				tx.delete(schema.signingKeyBackfills)
					.where(eq(schema.signingKeyBackfills.keyId, id))
					.run();
				tx.delete(schema.signingKeys)
					.where(eq(schema.signingKeys.id, id))
					.run();
			});
			await this.forgetBackfillWaits();
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
	purge waits, or `undefined` when nothing remains. A purge waits until the
	row from {@link nextBackfillRow} is due, for the shared rate-limit wait and
	the backfill's own wait after a failed attempt, and for the deployment's
	backfill pace, as far as this object has learned it. Staging that a pass
	left unfinished is due at once, or after the backfill's waits, because a
	pass that waits for them does not stage.

	The alarm calls this before running the backfill. It reads only this
	object's local storage, so it makes no D1 call.
	*/
	async backfillWorkAt(now: number): Promise<number | undefined> {
		const backfill = this.context.db
			.select({ generation: schema.signingKeyBackfills.generation })
			.from(schema.signingKeyBackfills)
			.where(ne(schema.signingKeyBackfills.state, 'complete'))
			.orderBy(schema.signingKeyBackfills.startedAt)
			.get();
		const next = await this.nextBackfillRow(now);

		if (next === undefined) {
			return backfill === undefined ? undefined : now;
		}

		if (backfill !== undefined && this.isStagingDue(backfill.generation)) {
			return Math.max(now, await this.attemptDueAt(now));
		}

		return Math.max(
			next.dueAt,
			await this.attemptDueAt(now),
			(await this.purgePace.knownNextAt()) ?? now
		);
	}

	async runBackfillOnce(): Promise<MaintenanceProgress> {
		const purge = await this.processContinuation();

		if (purge === 'retrying' || purge === 'waiting') {
			return 'stalled';
		}

		// Waiting for the pace is the scheduled rhythm of the backfill, so a
		// paced pass reports no stall. It still stages, because `backfillWorkAt`
		// makes a pass due at once while staging is due.
		const row = this.context.db
			.select()
			.from(schema.signingKeyBackfills)
			.where(ne(schema.signingKeyBackfills.state, 'complete'))
			.orderBy(schema.signingKeyBackfills.startedAt)
			.get();

		if (row === undefined || this.completeIfDrained(row)) {
			// Rows that remain wait for the next request.
			if (['partial', 'turn', 'paced'].includes(purge)) {
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
