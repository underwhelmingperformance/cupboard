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
import { PushNarMetadataMismatchError } from '../errors.ts';
import { compressNarToStream } from '../nix/blob.ts';
import { NarArchive, type NarDigest } from '../nix/nar.ts';
import { prepareStorePathNegotiation } from '../nix/nix-store.ts';
import type { CompressNar, PushClient, PushNarArchive } from '../push/push.ts';

// Cachix's narinfo batcher (one hundred paths or half a second) and Attic's
// session timers corroborate the debounce shape: accepted paths accumulate
// behind a short window, bounded by the commit batch size and this maximum
// wait, and each flush enters the ordinary batched negotiation.
export const flushMaxWaitMs = 500;

/** The daemon operations one flush performs over its own connection. */
export interface BatchSession {
	addTempRoot(storePath: StorePathString): Promise<void>;
	queryPathInfo(storePath: StorePathString): Promise<NixValidPathInfo>;
}

/**
 * A store that runs a callback against a session bound to one connection. A
 * temporary root taken through the session lives exactly as long as that
 * connection, so the callback's extent is the unit of pinning.
 */
export interface BatchStore {
	withConnection<T>(use: (session: BatchSession) => Promise<T>): Promise<T>;
}

/**
 * One path's terminal state in the streaming session: published by this run,
 * already served by the destination, or collected locally before its NAR
 * could be read. Which paths are targets, and what a collected target means
 * for the run, is the command layer's judgement; the outcome data stays
 * generic here.
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
	/** The run root every flush's negotiation binds, exactly as a push does. */
	readonly runRoot?: UploadAttachRoot;
	readonly commitOptions?: CommitOptions;
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
 * accumulate in an unbounded candidate set and flush in bounded batches; each
 * flush pins its batch with temporary roots on one daemon connection (root,
 * then validity, then read, Nix's documented ordering), resolves metadata over
 * that session, then negotiates, uploads and commits through the ordinary push
 * client, with the session closing as the batch's reads complete. The
 * session-wide dedup records outcomes, never enqueuings: a path whose
 * publication fails returns to the candidate set for the next flush or for
 * final reconciliation, and a path that vanished from the local store is a
 * typed `collected` outcome, never a batch failure.
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
			const commits = await this.options.store.withConnection(
				async (session) => {
					// Nix's documented ordering: take the root first, then check
					// validity, then read.
					for (const storePath of batch) {
						await session.addTempRoot(storePath);
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

					const negotiation = await this.options.client.negotiate({
						paths: infos.map((info) => prepareStorePathNegotiation(info)),
						...(this.options.runRoot !== undefined && {
							attachRoot: this.options.runRoot
						})
					});
					const infoByHash = new Map(
						infos.map((info) => [StorePath.hash(info.storePath), info])
					);
					const candidates: CommitCandidate[] = [];

					for (const decision of negotiation.uploads) {
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

						// The NAR read streams into the upload here, inside the session,
						// so the temporary root protects the path until its bytes are
						// fully away.
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

			// The session is closed here: the batch's reads are complete and its
			// temporary roots released with the connection.
			for (const { decision, info } of commits) {
				try {
					await this.options.client.commit(
						{
							uploadId: decision.uploadId,
							storePathHash: decision.storePathHash,
							narHash: decision.narHash
						},
						this.options.commitOptions ?? {}
					);
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
			// not individually settled returns to candidacy for the next flush.
			for (const storePath of remaining) {
				this.recordFailure(storePath, error);
			}

			remaining.clear();
		}
	}

	/** The terminal per-path outcomes recorded so far. */
	get outcomes(): ReadonlyMap<StorePathString, BatchPathOutcome> {
		return this.recorded;
	}

	/** The paths awaiting a flush, including any returned by a failure. */
	get candidates(): readonly StorePathString[] {
		return [...this.waiting];
	}

	/**
	 * Accepts one path into the candidate set. A path with a recorded outcome,
	 * or already waiting or publishing, is not enqueued again; the set flushes
	 * when it reaches the batch bound or when the debounce window lapses.
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

	/** Resolves once every flush started so far has finished. */
	async settled(): Promise<void> {
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
