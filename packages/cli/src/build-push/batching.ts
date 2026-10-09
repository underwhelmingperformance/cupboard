import {
	NixStorePathNotFoundError,
	type NixValidPathInfo
} from '@cupboard/nix';
import type { StorePathString } from '@cupboard/nix-store/scalars';
import {
	commitBatchMaxEntries,
	type CommitBlobDeclaration,
	type UploadAttachRootInput,
	type UploadDecision
} from '@cupboard/protocol/upload';

import type { CommitOptions } from '../client/client.ts';
import type { CommitSession } from '../client/commit-socket.ts';
import { commitOverSession } from '../client/commit-via.ts';
import { PushNarMetadataMismatchError } from '../errors.ts';
import { compressNarToStream } from '../nix/blob.ts';
import { NarArchive, type NarDigest } from '../nix/nar.ts';
import type { NarSource } from '../nix/nar-source.ts';
import { prepareStorePathNegotiation } from '../nix/nix-store.ts';
import { type NegotiatedPath, publishJustInTime } from '../push/negotiation.ts';
import {
	type CompressNar,
	defaultUploadConcurrency,
	type PushClient
} from '../push/push.ts';
import {
	systemUploadClock,
	type UploadClock,
	uploadNarFromSource,
	type UploadReport
} from '../push/upload-transfer.ts';

import { requireMatchingBuildOutput } from './divergence.ts';

export const flushMaxWaitMs = 500;

export interface BatchSession {
	protectPath(storePath: StorePathString): Promise<void>;
	queryPathInfo(storePath: StorePathString): Promise<NixValidPathInfo>;
}

/**
 * Provides store access while paths are protected from garbage collection. The
 * implementation can open a connection for one batch or retain a connection
 * for the full streamed run. For a daemonless build, the hook has already
 * registered GC roots.
 */
export interface BatchStore {
	withProtectedPaths<T>(use: (session: BatchSession) => Promise<T>): Promise<T>;
}

/**
 * One path's terminal state in the streaming session: published by this run,
 * already served by the destination, or collected locally before its NAR
 * could be read. The command layer decides which paths are targets and what a
 * collected target means for the run; this module only reports the outcome.
 */
export type BatchPathOutcome =
	| {
			readonly outcome: 'published';
			readonly storePath: StorePathString;
	  }
	| {
			readonly outcome: 'destination-served';
			readonly storePath: StorePathString;
	  }
	| { readonly outcome: 'collected'; readonly storePath: StorePathString };

export interface BatchPathFailure {
	readonly storePath: StorePathString;
	readonly reason: unknown;
}

export interface BuildOutputBatcherOptions {
	readonly store: BatchStore;
	readonly client: PushClient;
	readonly runRoot?: UploadAttachRootInput;
	readonly commitOptions?: CommitOptions;
	/**
	 * The run's shared commit session. When it is present, every flush commits
	 * over it. The server then applies one credit budget to the whole run.
	 */
	readonly session?: CommitSession;
	readonly createNarArchive?: (storePath: string) => NarSource;
	readonly compressNar?: CompressNar;
	readonly maxEntries?: number;
	readonly maxWaitMs?: number;
	readonly uploadConcurrency?: number;
	/**
	Times uploads and schedules their renewals. Defaults to the system clock.
	*/
	readonly uploadClock?: UploadClock;
	readonly uploadReport?: UploadReport;
	readonly onOutcome?: (outcome: BatchPathOutcome) => void;
	readonly onFailure?: (failure: BatchPathFailure) => void;
}

type PublishableDecision = Extract<
	UploadDecision,
	{ action: 'upload' | 'commit' }
>;

function assertNarMetadata(info: NixValidPathInfo, digest: NarDigest): void {
	const expected = info.narHash.toString();
	const actual = digest.narHash.toString();

	if (expected === actual && info.narSize === digest.narSize) {
		return;
	}

	throw new PushNarMetadataMismatchError(
		info.storePath,
		expected,
		actual,
		info.narSize,
		digest.narSize
	);
}

/**
 * Debounces accepted build outputs into streamed publication. Accepted paths
 * accumulate in an unbounded candidate set and flush in bounded batches. Each
 * flush protects its paths before checking their validity, resolves metadata,
 * then negotiates, uploads and commits through the ordinary push client. Paths
 * are negotiated in small groups as upload workers become free, and each upload
 * worker waits for its commit acknowledgement before taking another path. The
 * store implementation controls how long protection remains in place.
 *
 * The batcher records only terminal outcomes. If publication fails, the path
 * returns to the candidate set for the next flush or final reconciliation. A
 * path that vanished from the local store produces a typed `collected` outcome
 * instead of failing the batch.
 */
export class BuildOutputBatcher {
	private readonly waiting = new Set<StorePathString>();
	private readonly inFlight = new Set<StorePathString>();
	private readonly recorded = new Map<StorePathString, BatchPathOutcome>();
	private timer: NodeJS.Timeout | undefined;
	private chain: Promise<void> = Promise.resolve();

	constructor(private readonly options: BuildOutputBatcherOptions) {}

	private maxEntries(): number {
		return this.options.maxEntries ?? commitBatchMaxEntries;
	}

	private clearTimer(): void {
		if (this.timer === undefined) {
			return;
		}

		clearTimeout(this.timer);
		this.timer = undefined;
	}

	private startFlush(): void {
		this.clearTimer();

		const batch = [...this.waiting].slice(0, this.maxEntries());

		if (batch.length === 0) {
			return;
		}

		for (const storePath of batch) {
			this.waiting.delete(storePath);
			this.inFlight.add(storePath);
		}

		const previous = this.chain;

		this.chain = (async () => {
			await previous;
			await this.flushBatch(batch);
		})();
	}

	private recordOutcome(outcome: BatchPathOutcome): void {
		this.inFlight.delete(outcome.storePath);
		this.recorded.set(outcome.storePath, outcome);
		this.options.onOutcome?.(outcome);
	}

	private recordFailure(storePath: StorePathString, reason: unknown): void {
		this.inFlight.delete(storePath);
		this.waiting.add(storePath);
		this.options.onFailure?.({ storePath, reason });
	}

	private settlePath(
		storePath: StorePathString,
		error: unknown,
		remaining: Set<StorePathString>
	): void {
		remaining.delete(storePath);

		if (error instanceof NixStorePathNotFoundError) {
			this.recordOutcome({ outcome: 'collected', storePath });
			return;
		}

		this.recordFailure(storePath, error);
	}

	private async flushBatch(batch: readonly StorePathString[]): Promise<void> {
		const remaining = new Set(batch);

		try {
			await this.options.store.withProtectedPaths(async (session) => {
				// Protect each path before checking validity. Checking first would
				// leave time for garbage collection before the NAR read begins.
				for (const storePath of batch) {
					await session.protectPath(storePath);
				}

				const infos: NixValidPathInfo[] = [];

				// Settling deletes only the path under iteration, which a Set
				// iterator tolerates.
				for (const storePath of remaining) {
					try {
						infos.push(await session.queryPathInfo(storePath));
					} catch (error) {
						this.settlePath(storePath, error, remaining);
					}
				}

				// The NAR reads stream into the uploads inside the protected session,
				// so each path remains available until all its bytes have been sent.
				await publishJustInTime(
					{
						paths: infos,
						concurrency:
							this.options.uploadConcurrency ?? defaultUploadConcurrency,
						negotiationOf: (info) => prepareStorePathNegotiation(info),
						negotiate: async (paths) => {
							const negotiation = await this.options.client.negotiate({
								paths: [...paths],
								...(this.options.runRoot !== undefined && {
									attachRoot: this.options.runRoot
								})
							});

							return {
								uploads: negotiation.uploads,
								hasUploadGraceFacts: negotiation.hasUploadGraceFacts ?? true
							};
						}
					},
					(item) => this.publishNegotiated(item, remaining)
				);
			});
		} catch (error) {
			// A batch-level failure (the connection, the protected session): every
			// path not settled individually returns to the candidate set for the
			// next flush.
			for (const storePath of remaining) {
				this.recordFailure(storePath, error);
			}

			remaining.clear();
		}
	}

	private async publishNegotiated(
		item: NegotiatedPath<NixValidPathInfo, UploadDecision>,
		remaining: Set<StorePathString>
	): Promise<void> {
		const { storePath } = item.path;

		if (item.kind === 'refused') {
			this.settlePath(storePath, item.error, remaining);
			return;
		}

		const { decision } = item;

		if (decision.action === 'skip') {
			try {
				requireMatchingBuildOutput(item.path, decision);
			} catch (error) {
				this.settlePath(storePath, error, remaining);
				return;
			}

			remaining.delete(storePath);
			this.recordOutcome({ outcome: 'destination-served', storePath });
			return;
		}

		try {
			await this.uploadAndCommit(decision, item.path);
		} catch (error) {
			this.settlePath(storePath, error, remaining);
			return;
		}

		remaining.delete(storePath);
		this.recordOutcome({ outcome: 'published', storePath });
	}

	private async uploadAndCommit(
		decision: PublishableDecision,
		info: NixValidPathInfo
	): Promise<void> {
		let blob: CommitBlobDeclaration | undefined;

		if (decision.action === 'upload') {
			const compressNar = this.options.compressNar ?? compressNarToStream;
			const createNarArchive =
				this.options.createNarArchive ??
				((storePath: string) => new NarArchive(storePath));
			const upload = await uploadNarFromSource(
				{
					client: this.options.client,
					session: this.options.session,
					clock: this.options.uploadClock ?? systemUploadClock,
					compressNar,
					observer: this.options.uploadReport?.observe(info.storePath) ?? {}
				},
				decision,
				createNarArchive(info.storePath),
				info.narSize
			);
			assertNarMetadata(info, upload.digest);
			blob = upload.blob;
			this.options.uploadReport?.completed(info.storePath, upload);
		}

		await commitOverSession(this.options, {
			uploadId: decision.uploadId,
			storePathHash: decision.storePathHash,
			narHash: decision.narHash,
			...(blob !== undefined && { blob })
		});
	}

	get outcomes(): ReadonlyMap<StorePathString, BatchPathOutcome> {
		return this.recorded;
	}

	get candidates(): readonly StorePathString[] {
		return [...this.waiting];
	}

	/**
	 * Accepts one path into the candidate set. It ignores a path that already has
	 * an outcome or is waiting or being published. The set flushes when it reaches
	 * the batch bound or when the debounce window lapses.
	 */
	enqueue(storePath: StorePathString): void {
		if (
			this.recorded.has(storePath) ||
			this.waiting.has(storePath) ||
			this.inFlight.has(storePath)
		) {
			return;
		}

		this.waiting.add(storePath);

		if (this.waiting.size >= this.maxEntries()) {
			this.startFlush();
			return;
		}

		this.timer ??= setTimeout(() => {
			this.timer = undefined;
			this.startFlush();
		}, this.options.maxWaitMs ?? flushMaxWaitMs);
	}

	/**
	Resolves once every flush started so far has finished.
	*/
	async settled(): Promise<void> {
		await this.chain;
	}

	/**
	Stops the debounce timer and waits for every started flush to finish.
	*/
	async stop(): Promise<void> {
		this.clearTimer();
		await this.chain;
	}

	/**
	 * Flushes what remains and waits for every started flush to finish. Each
	 * remaining candidate is attempted once; a path that fails here stays in
	 * the candidate set for final reconciliation to publish through the
	 * ordinary push path.
	 */
	async drain(): Promise<void> {
		this.clearTimer();
		await this.chain;

		const snapshot = [...this.waiting];

		for (let index = 0; index < snapshot.length; index += this.maxEntries()) {
			const batch = snapshot
				.slice(index, index + this.maxEntries())
				.filter((storePath) => this.waiting.has(storePath));

			if (batch.length === 0) {
				continue;
			}

			for (const storePath of batch) {
				this.waiting.delete(storePath);
				this.inFlight.add(storePath);
			}

			await this.flushBatch(batch);
		}
	}
}
