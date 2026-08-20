import {
	NixStorePathNotFoundError,
	type NixValidPathInfo
} from '@cupboard/nix';
import type { StorePathString } from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import {
	commitBatchMaxEntries,
	type ParsedUploadDecision,
	type UploadAttachRoot
} from '@cupboard/protocol/upload';

import type { CommitOptions } from '../client/client.ts';
import type { CommitSession } from '../client/commit-socket.ts';
import { commitOverSession } from '../client/commit-via.ts';
import { PushNarMetadataMismatchError } from '../errors.ts';
import { compressNarToStream } from '../nix/blob.ts';
import { NarArchive, type NarDigest } from '../nix/nar.ts';
import { prepareStorePathNegotiation } from '../nix/nix-store.ts';
import { exactUploadDecisions } from '../push/negotiation.ts';
import type { CompressNar, PushClient, PushNarArchive } from '../push/push.ts';

// How long accepted paths accumulate before a flush. A batch is sent once it
// reaches the commit batch size or this wait elapses, and each flush goes
// through the ordinary batched negotiation. Cachix batches narinfos at one
// hundred paths or half a second, and Attic uses session timers of the same
// order.
export const flushMaxWaitMs = 500;

/**
The store operations a batch can perform while its paths are protected.
*/
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
	| { readonly outcome: 'published'; readonly storePath: StorePathString }
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
	/**
	The run root every flush's negotiation binds, exactly as a push does.
	*/
	readonly runRoot?: UploadAttachRoot;
	readonly commitOptions?: CommitOptions;
	/**
	 * The run's shared commit session. When it is present, every flush commits
	 * over it, so the whole publication holds one socket and the server paces it
	 * as one run.
	 */
	readonly session?: CommitSession;
	readonly createNarArchive?: (storePath: string) => PushNarArchive;
	readonly compressNar?: CompressNar;
	readonly maxEntries?: number;
	readonly maxWaitMs?: number;
	readonly onOutcome?: (outcome: BatchPathOutcome) => void;
	readonly onFailure?: (failure: BatchPathFailure) => void;
}

type PublishableDecision = Extract<
	ParsedUploadDecision,
	{ action: 'upload' | 'commit' }
>;

interface CommitCandidate {
	readonly decision: PublishableDecision;
	readonly info: NixValidPathInfo;
}

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
 * then negotiates, uploads and commits through the ordinary push client. The
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
		const compressNar = this.options.compressNar ?? compressNarToStream;
		const createNarArchive =
			this.options.createNarArchive ??
			((storePath: string) => new NarArchive(storePath));

		try {
			const commits = await this.options.store.withProtectedPaths(
				async (session) => {
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

					if (infos.length === 0) {
						return [];
					}

					const paths = infos.map((info) => prepareStorePathNegotiation(info));
					const negotiation = await this.options.client.negotiate({
						paths,
						...(this.options.runRoot !== undefined && {
							attachRoot: this.options.runRoot
						})
					});
					const decisions = exactUploadDecisions(paths, negotiation.uploads);
					const infoByHash = new Map(
						infos.map((info) => [StorePath.hash(info.storePath), info])
					);
					const candidates: CommitCandidate[] = [];

					for (const decision of decisions) {
						const info = infoByHash.get(decision.storePathHash);

						if (info === undefined) {
							continue;
						}

						if (decision.action === 'skip') {
							remaining.delete(info.storePath);
							this.recordOutcome({
								outcome: 'destination-served',
								storePath: info.storePath
							});
							continue;
						}

						if (decision.action === 'commit') {
							candidates.push({ decision, info });
							continue;
						}

						// The NAR read streams into the upload inside the protected
						// session, so the path remains available until all its bytes
						// have been sent.
						try {
							const upload = compressNar(createNarArchive(info.storePath));

							await this.options.client.uploadNar(decision.r2Key, upload.body);
							assertNarMetadata(info, upload.digest());
							candidates.push({ decision, info });
						} catch (error) {
							this.settlePath(info.storePath, error, remaining);
						}
					}

					return candidates;
				}
			);

			// The callback has finished reading the paths. The cache commit below
			// uses upload metadata and does not read the store path.
			for (const { decision, info } of commits) {
				try {
					await commitOverSession(this.options, {
						uploadId: decision.uploadId,
						storePathHash: decision.storePathHash,
						narHash: decision.narHash
					});
					remaining.delete(info.storePath);
					this.recordOutcome({
						outcome: 'published',
						storePath: info.storePath
					});
				} catch (error) {
					this.settlePath(info.storePath, error, remaining);
				}
			}
		} catch (error) {
			// A batch-level failure (the connection, the negotiation): every path
			// not settled individually returns to the candidate set for the next
			// flush.
			for (const storePath of remaining) {
				this.recordFailure(storePath, error);
			}

			remaining.clear();
		}
	}

	/**
	The terminal per-path outcomes recorded so far.
	*/
	get outcomes(): ReadonlyMap<StorePathString, BatchPathOutcome> {
		return this.recorded;
	}

	/**
	The paths awaiting a flush, including any returned by a failure.
	*/
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
