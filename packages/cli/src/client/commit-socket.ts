import {
	type NixSha256HashString,
	type StorePathHash
} from '@cupboard/nix-store/scalars';
import {
	commitBatchCapability,
	commitBatchMaxEntries,
	commitCapabilitiesHeader,
	commitSessionFrameSchema,
	type CommitSessionRequest,
	type ParsedUploadGraceFact,
	retentionMarkerAttribute,
	retentionMarkerAttributeValue,
	subscribeIdentityCapability
} from '@cupboard/protocol/upload';
import { chunk } from '@cupboard/shared/collections';
import { z } from 'zod';

import { abortReason } from '../abort.ts';
import {
	CommitSocketProtocolError,
	CupboardHttpError,
	UploadVerificationFailedError,
	UploadWaitTimeoutError
} from '../errors.ts';

/** A received frame or body chunk; `ws` hands these over as `Buffer`s. */
export interface CommitSocketData {
	toString(): string;
}

/** The HTTP response a refused upgrade carries (a `ws` `IncomingMessage`). */
export interface UpgradeFailure {
	readonly statusCode?: number;
	on(event: 'data', listener: (chunk: CommitSocketData) => void): unknown;
	on(event: 'end', listener: () => void): unknown;
}

/**
 * The accepted upgrade's 101 response (a `ws` `IncomingMessage`), carrying the
 * headers the server advertises its optional ops in.
 */
export interface UpgradeResponse {
	readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/**
 * The client half of a commit WebSocket. Structurally a subset of `ws`'s
 * `WebSocket`, so the real client and test fakes plug in alike.
 */
export interface CommitSocket {
	on(event: 'open', listener: () => void): unknown;
	on(event: 'upgrade', listener: (response: UpgradeResponse) => void): unknown;
	on(event: 'message', listener: (data: CommitSocketData) => void): unknown;
	on(
		event: 'close',
		listener: (code: number, reason: CommitSocketData) => void
	): unknown;
	on(event: 'error', listener: (error: Error) => void): unknown;
	on(
		event: 'unexpected-response',
		listener: (request: unknown, response: UpgradeFailure) => void
	): unknown;
	send(data: string): void;
	close(): void;
}

/** Opens a commit WebSocket carrying the bearer token on the upgrade request. */
export type CommitSocketConnect = (
	url: URL,
	headers: Readonly<Record<string, string>>
) => CommitSocket;

/**
 * A path to commit over the session, with the identity from negotiation.
 * `retention`, true only when this upload negotiated a retention plan, lets a
 * reconnect that resolves a gone row by identity ask the server for the
 * path's durable grace fact instead of none.
 */
export interface CommitSessionTarget {
	readonly uploadId: string;
	readonly storePathHash: StorePathHash;
	readonly narHash: NixSha256HashString;
	readonly retention?: boolean;
}

/**
 * Parsed attributes for one capability token from the server's 101 response.
 * A bare token (no semicolons) maps to an empty record.
 */
export type CapabilityAttributes = Readonly<Record<string, string>>;

/**
 * The capabilities the server advertised on a connection, keyed by token name.
 */
export type AdvertisedCapabilities = ReadonlyMap<string, CapabilityAttributes>;

export interface CommitSessionOptions {
	/** The route path the socket was opened on, for error messages. */
	readonly path: string;
	/** Bounds how long a deferred upload's `settled` waits for its verdict. */
	readonly timeoutSeconds: number;
	readonly signal?: AbortSignal;
	readonly keepaliveMs?: number;
	/** How many times a dropped socket is re-established before the push fails. */
	readonly maxReconnects?: number;
	/** Base back-off before the first reconnect; doubles, jittered, then capped. */
	readonly reconnectBackoffMs?: number;
	/**
	 * Called on each connection with the capabilities the server advertised in
	 * the 101 response. Useful for logging the negotiated mode.
	 */
	readonly onCapabilities?: (capabilities: AdvertisedCapabilities) => void;
}

/**
 * A committed path's prompt disposition plus the promise of its eventual
 * verdict. `commit` resolves this as soon as the server acknowledges the path
 * (its row is reserved), so retention can be recorded before any wait; `settled`
 * resolves once the path is servable and rejects on a failed verdict. For a
 * reuse or inline commit (`committed`) `settled` is already resolved.
 */
export interface CommitOutcome {
	readonly storePathHash: StorePathHash;
	readonly narHash: NixSha256HashString;
	readonly status: 'committed' | 'pending' | 'already-present';
	readonly settled: Promise<void>;
	// The retention grace fact this outcome's frame carried, present only when
	// the negotiation sent a retention plan: a deadline for a settled path, the
	// captured grace for one still pending.
	readonly grace?: ParsedUploadGraceFact;
	// The grace fact of the terminal frame, readable once `settled` resolves: a
	// deferred path's deadline arrives with its verdict, not its ack.
	readonly settledGrace?: () => ParsedUploadGraceFact | undefined;
}

/** A push's commit session: many paths commit over one socket. */
export interface CommitSession {
	commit(target: CommitSessionTarget): Promise<CommitOutcome>;
	/** Closes the socket; safe once every commit has settled. */
	close(): void;
}

interface SessionEntry {
	readonly target: CommitSessionTarget;
	readonly resolveAck: (outcome: CommitOutcome) => void;
	readonly rejectAck: (error: Error) => void;
	readonly settled: Promise<void>;
	readonly settleServable: () => void;
	readonly settleFailed: (error: Error) => void;
	// A `deferred` frame has arrived, so the server holds a durable row for this
	// upload. A reconnect resumes such an id with `subscribe`, where a since-gone
	// row safely means it committed; an un-acked id is re-sent as `commit`
	// instead, since its op may never have reached the server.
	acked: boolean;
	deadline?: NodeJS.Timeout;
	// How many times this entry has been retried after a retryable error frame,
	// and the timer of a retry not yet sent, cleared with the deadline.
	retryAttempts: number;
	retryTimer?: NodeJS.Timeout;
	// The grace fact of the last settled or verdict frame, exposed through the
	// outcome's `settledGrace` once the entry settles.
	verdictGrace?: ParsedUploadGraceFact;
}

const defaultKeepaliveMs = 30_000;
const defaultMaxReconnects = 5;
const defaultReconnectBackoffMs = 500;
const maxReconnectBackoffMs = 5000;
const keepaliveRequest = 'ping';
const keepaliveResponse = 'pong';
// WebSocket close code for a server-side protocol rejection. Retrying cannot
// heal it, so the session fails immediately on this code.
const nonRetryableCloseCode = 1002;

// Maximum number of commit-batch messages in flight at once. Once this many
// are outstanding, further chunks queue until any frame for an in-flight chunk
// arrives (the ANY-frame rule: one frame means the server parsed the message
// and is processing its entries concurrently, so it counts as done for windowing
// purposes).
const maxInFlightBatchMessages = 2;

// Status codes that indicate a transient server overload: a short per-entry
// backoff and re-send may succeed where an immediate retry would not.
const retryableErrorStatuses = new Set([429, 503]);
// How many times one entry is re-sent before its error is treated as terminal.
const maxEntryRetries = 3;
// Base delay in ms before the first entry retry; doubles per attempt (no jitter,
// so the retry fires promptly in tests that use fake timers).
const entryRetryBaseMs = 500;

// The ev values whose frames carry mandatory fields the schema validates; an ev
// absent from this set is treated as unknown and ignored for forward
// compatibility with new server frame kinds.
const knownEvs = new Set([
	'settled',
	'deferred',
	'verdict',
	'error',
	'unsupported'
]);

// Awaits a promise solely to observe a rejection no caller did, so an unawaited
// `settled` never surfaces as an unhandled rejection.
async function ignoreRejection(promise: Promise<unknown>): Promise<void> {
	try {
		await promise;
	} catch {
		// Intentionally ignored: the caller sees the rejection if it awaits.
	}
}

// A verdict promise with its resolver and rejecter, the `settled` half of a
// commit outcome.
function deferredSettle(): {
	readonly settled: Promise<void>;
	readonly settleServable: () => void;
	readonly settleFailed: (error: Error) => void;
} {
	const { promise, resolve, reject } = Promise.withResolvers<undefined>();

	return {
		settled: promise,
		settleServable: () => {
			resolve(undefined);
		},
		settleFailed: reject
	};
}

const frameEnvelopeSchema = z.looseObject({ ev: z.string() });

function parseTokenAttributes(parts: readonly string[]): CapabilityAttributes {
	const attributes: Record<string, string> = {};

	for (const part of parts) {
		const eqIndex = part.indexOf('=');

		if (eqIndex === -1) {
			continue;
		}

		const key = part.slice(0, eqIndex);
		const value = part.slice(eqIndex + 1);

		if (key !== '') {
			attributes[key] = value;
		}
	}

	return attributes;
}

/**
 * Parses the value of the `x-cupboard-commit-capabilities` header into a map
 * from token name to its attributes. Tokens are separated by commas or
 * whitespace; each token is `name` or `name;key=value;...`. A bare token maps
 * to an empty attributes record.
 */
export function parseCapabilities(header: string): AdvertisedCapabilities {
	const result = new Map<string, CapabilityAttributes>();

	for (const token of header.split(/[\s,]+/u)) {
		if (token === '') {
			continue;
		}

		const parts = token.split(';');
		const name = parts[0];

		if (name === undefined || name === '') {
			continue;
		}

		result.set(name, parseTokenAttributes(parts.slice(1)));
	}

	return result;
}

// Resolves the effective batch size for a connection from its advertised
// capabilities. Returns `undefined` when `commit-batch` was not advertised. A
// non-numeric, non-positive, or absent `max` attribute uses the protocol default;
// an advertised max larger than the protocol bound is capped.
function resolvedBatchSize(
	capabilities: AdvertisedCapabilities
): number | undefined {
	const attributes = capabilities.get(commitBatchCapability);

	if (attributes === undefined) {
		return undefined;
	}

	const maxAttribute = attributes.max;

	if (maxAttribute === undefined) {
		return commitBatchMaxEntries;
	}

	const parsed = Number(maxAttribute);

	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		return commitBatchMaxEntries;
	}

	return Math.min(parsed, commitBatchMaxEntries);
}

// Whether the server advertised the retention-marker attribute on the given
// capability token, so a client can set `retention: true` on an entry of the
// op that token names without risking a `strictObject` rejection from a
// server that predates the marker. The attribute's exact advertised value is
// required, so an unrecognised variant reads as no marker at all.
function hasRetentionMarker(
	capabilities: AdvertisedCapabilities,
	capability: string
): boolean {
	return (
		capabilities.get(capability)?.[retentionMarkerAttribute] ===
		retentionMarkerAttributeValue
	);
}

/**
 * Runs a push's commit session over one socket. Each `commit` registers a path,
 * sends a `commit` op, and resolves when the path's per-id frame settles it: a
 * settled or already-present reply straight away, a `deferred` upload's verdict
 * once verification answers (or `pending` when `wait` is off). A frame names its
 * upload, so many commits multiplex over the one connection. The server answers
 * the keepalive pings without waking the Durable Object, so a long park survives
 * idle timeouts.
 *
 * A transient drop does not fail the push: the session reconnects with a capped
 * back-off and replays the outstanding work onto the fresh socket, so one blip
 * costs at most a brief pause.
 */
export function runCommitSession(
	connect: CommitSocketConnect,
	url: URL,
	headers: Readonly<Record<string, string>>,
	options: CommitSessionOptions
): CommitSession {
	const outstanding = new Map<string, SessionEntry>();
	const maxReconnects = options.maxReconnects ?? defaultMaxReconnects;
	const backoffBase = options.reconnectBackoffMs ?? defaultReconnectBackoffMs;

	let socket: CommitSocket | undefined;
	let isOpened = false;
	let isClosed = false;
	let failure: Error | undefined;
	let keepalive: NodeJS.Timeout | undefined;
	let reconnectTimer: NodeJS.Timeout | undefined;
	let reconnectsLeft = maxReconnects;
	// Effective batch size for the current connection: a positive integer when the
	// server advertised `commit-batch` (possibly with a `max` attribute), or
	// `undefined` when it did not.
	let effectiveBatchSize: number | undefined;
	// Whether the current connection's server advertised `subscribe-identity`.
	// When true, reconnect replays send acked ids through the identity-carrying
	// op, so a row that settled and cleared during the drop resolves by identity.
	let hasSubscribeIdentity = false;
	// Whether the current connection's server accepts the `retention` marker on
	// a `commit-batch` or `subscribe-identity` entry, respectively. A target
	// negotiated with a retention plan sets the marker on an entry of that op
	// only when the connection supports it, so a plan-carrying reconnect answers
	// with the path's durable grace fact rather than none.
	let hasBatchRetentionMarker = false;
	let hasIdentityRetentionMarker = false;

	const sendNow = (request: CommitSessionRequest): void => {
		socket?.send(JSON.stringify(request));
	};

	// Window state for the batch path. Each in-flight chunk is tracked by a set
	// of its uploadIds; any frame for a member of that set counts as an ack (the
	// ANY-frame rule), removing the chunk from the window and releasing the next
	// queued chunk. Per-id ops are not windowed.
	//
	// Both structures are cleared on reconnect (openConnection resets them), so
	// replayOutstanding sends through a fresh window each time.
	const inFlightChunks = new Map<string, Set<string>>();
	const uploadIdToChunkKey = new Map<string, string>();
	let pendingBatchChunks: CommitSessionTarget[][] = [];

	const sendBatchChunk = (batch: readonly CommitSessionTarget[]): void => {
		const chunkKey = batch[0]?.uploadId ?? '';
		const ids = new Set(batch.map((t) => t.uploadId));
		inFlightChunks.set(chunkKey, ids);

		for (const id of ids) {
			uploadIdToChunkKey.set(id, chunkKey);
		}

		sendNow({
			op: 'commit-batch',
			commits: batch.map((target) => ({
				uploadId: target.uploadId,
				storePathHash: target.storePathHash,
				narHash: target.narHash,
				...(target.retention === true &&
					hasBatchRetentionMarker && { retention: true as const })
			}))
		});
	};

	const releaseChunkForUploadId = (uploadId: string): void => {
		const chunkKey = uploadIdToChunkKey.get(uploadId);

		if (chunkKey === undefined) {
			return;
		}

		const ids = inFlightChunks.get(chunkKey);

		if (ids === undefined) {
			return;
		}

		for (const id of ids) {
			uploadIdToChunkKey.delete(id);
		}

		inFlightChunks.delete(chunkKey);

		const next = pendingBatchChunks.shift();

		if (next !== undefined && isOpened && !isClosed) {
			sendBatchChunk(next);
		}
	};

	// Sends a set of commits in the shape this connection speaks: one
	// `commit-batch` op per bounded chunk when the server offered it, a per-id
	// `commit` op each otherwise.
	//
	// On a reconnect without `commit-batch`, a bare re-sent op may try to commit
	// a row that already settled and cleared between the drop and the replay. The
	// server answers with an error frame for such an id. There is no way to supply
	// identity to the plain op against a server that does not advertise
	// `commit-batch`, so this asymmetry is inherent to the non-batching path.
	// Entry deadlines bound the window in which it can occur.
	const sendCommits = (targets: readonly CommitSessionTarget[]): void => {
		if (effectiveBatchSize === undefined) {
			for (const target of targets) {
				sendNow({ op: 'commit', uploadId: target.uploadId });
			}

			return;
		}

		for (const batch of chunk(targets, effectiveBatchSize)) {
			if (inFlightChunks.size < maxInFlightBatchMessages) {
				sendBatchChunk(batch);
			} else {
				pendingBatchChunks.push(batch);
			}
		}
	};

	// Commits registered while the socket is up coalesce over a microtask, so a
	// burst issued in one tick (the reuse commits of a large push) lands in a
	// handful of batch ops. A target whose entry settled or vanished before the
	// flush is skipped; a drop before the flush discards the queue, since the
	// reconnect replays every outstanding entry anyway.
	let sendQueue: CommitSessionTarget[] = [];
	let isFlushScheduled = false;

	const flushSendQueue = (): void => {
		isFlushScheduled = false;
		const targets = sendQueue.filter((target) =>
			outstanding.has(target.uploadId)
		);
		sendQueue = [];

		if (!isOpened || isClosed || targets.length === 0) {
			return;
		}

		sendCommits(targets);
	};

	const enqueueSend = (target: CommitSessionTarget): void => {
		sendQueue.push(target);

		if (isFlushScheduled) {
			return;
		}

		isFlushScheduled = true;
		queueMicrotask(flushSendQueue);
	};

	const clearKeepalive = (): void => {
		if (keepalive === undefined) {
			return;
		}

		clearInterval(keepalive);
		keepalive = undefined;
	};

	const teardown = (): void => {
		clearKeepalive();

		if (reconnectTimer !== undefined) {
			clearTimeout(reconnectTimer);
			reconnectTimer = undefined;
		}

		for (const entry of outstanding.values()) {
			if (entry.deadline !== undefined) {
				clearTimeout(entry.deadline);
			}

			if (entry.retryTimer !== undefined) {
				clearTimeout(entry.retryTimer);
			}
		}

		options.signal?.removeEventListener('abort', onAbort);
		socket?.close();
	};

	// A failure the session cannot recover from (a refused upgrade, exhausted
	// reconnects, an abort, a bad frame): every outstanding commit rejects, since
	// the one socket carried them all.
	const failSession = (error: Error): void => {
		if (isClosed) {
			return;
		}

		isClosed = true;
		failure = error;
		const entries = outstanding.values().toArray();
		outstanding.clear();
		teardown();

		for (const entry of entries) {
			// An acked entry's caller already holds its `settled`; an un-acked one is
			// still awaiting the commit reply, so its ack rejects instead.
			if (entry.acked) {
				entry.settleFailed(error);
			} else {
				entry.rejectAck(error);
			}
		}
	};

	const finishEntry = (
		uploadId: string,
		settle: (entry: SessionEntry) => void
	): void => {
		const entry = outstanding.get(uploadId);

		// A frame for an unknown id is a stale duplicate (a verdict after the entry
		// already settled, or a reply from a socket a reconnect superseded); ignore
		// it.
		if (entry === undefined) {
			return;
		}

		if (entry.deadline !== undefined) {
			clearTimeout(entry.deadline);
		}

		if (entry.retryTimer !== undefined) {
			clearTimeout(entry.retryTimer);
		}

		outstanding.delete(uploadId);
		settle(entry);
	};

	const onFrame = (text: string): void => {
		const json = safeJsonParse(text);
		const envelope = frameEnvelopeSchema.safeParse(json);

		if (!envelope.success) {
			failSession(
				new CommitSocketProtocolError(options.path, `unexpected frame: ${text}`)
			);

			return;
		}

		// An ev not in the known set is from a future server version; ignore it.
		// Entry deadlines bound the risk of a missed verdict.
		if (!knownEvs.has(envelope.data.ev)) {
			return;
		}

		const parsed = commitSessionFrameSchema.safeParse(json);

		if (!parsed.success) {
			failSession(
				new CommitSocketProtocolError(options.path, `unexpected frame: ${text}`)
			);

			return;
		}

		// A valid frame is progress, so a later drop gets the full reconnect budget
		// again; only a run of drops with nothing in between exhausts it.
		reconnectsLeft = maxReconnects;
		const frame = parsed.data;

		// Any frame for an upload id counts as an ack for that chunk's window slot,
		// releasing the next queued batch chunk. The unsupported ev carries no id.
		if ('uploadId' in frame) {
			releaseChunkForUploadId(frame.uploadId);
		}

		switch (frame.ev) {
			case 'settled': {
				// An immediate commit (a reuse or an inline verify) is already
				// servable, so its verdict settles at once.
				finishEntry(frame.uploadId, (entry) => {
					entry.verdictGrace = frame.grace;
					entry.settleServable();
					entry.resolveAck({
						storePathHash: frame.response.storePathHash,
						narHash: frame.response.narHash,
						status: frame.response.status,
						settled: entry.settled,
						...(frame.grace !== undefined && { grace: frame.grace }),
						settledGrace: () => entry.verdictGrace
					});
				});

				return;
			}

			case 'deferred': {
				const entry = outstanding.get(frame.uploadId);

				if (entry === undefined) {
					return;
				}

				// The server holds a durable row now: ack the disposition so the
				// caller can record retention, and keep the entry to carry the
				// verdict its `settled` promise resolves on.
				entry.acked = true;
				entry.deadline ??= armDeadline(frame.uploadId);
				entry.resolveAck({
					storePathHash: frame.storePathHash,
					narHash: frame.narHash,
					status: 'pending',
					settled: entry.settled,
					...(frame.grace !== undefined && { grace: frame.grace }),
					settledGrace: () => entry.verdictGrace
				});

				return;
			}

			case 'verdict': {
				const entry = outstanding.get(frame.uploadId);

				if (entry === undefined) {
					return;
				}

				if (frame.status === 'pending') {
					failSession(
						new CommitSocketProtocolError(
							options.path,
							`unexpected verdict frame: ${text}`
						)
					);

					return;
				}

				if (frame.status === 'servable') {
					finishEntry(frame.uploadId, (settling) => {
						settling.verdictGrace = frame.grace;
						settling.settleServable();

						// A verdict can race ahead of the deferred frame; with no ack
						// yet, resolve it now from the target's identity: servable is
						// committed.
						if (!settling.acked) {
							settling.resolveAck({
								storePathHash: settling.target.storePathHash,
								narHash: settling.target.narHash,
								status: 'committed',
								settled: settling.settled,
								...(frame.grace !== undefined && { grace: frame.grace }),
								settledGrace: () => settling.verdictGrace
							});
						}
					});

					return;
				}

				const status = frame.status;
				finishEntry(frame.uploadId, (settling) => {
					const error = new UploadVerificationFailedError(
						frame.uploadId,
						status
					);
					settling.settleFailed(error);

					// A failure racing ahead of the deferred frame has no `pending`
					// disposition to report, so the ack itself rejects.
					if (!settling.acked) {
						settling.rejectAck(error);
					}
				});

				return;
			}

			case 'error': {
				const { uploadId: errorUploadId, status, message } = frame;
				const entry = outstanding.get(errorUploadId);

				if (entry === undefined) {
					return;
				}

				if (
					retryableErrorStatuses.has(status) &&
					entry.retryAttempts < maxEntryRetries
				) {
					entry.retryAttempts += 1;
					const attempt = entry.retryAttempts;
					const delay = entryRetryBaseMs * 2 ** (attempt - 1);
					entry.retryTimer = setTimeout(() => {
						entry.retryTimer = undefined;

						if (isOpened && !isClosed && outstanding.has(errorUploadId)) {
							sendCommits([entry.target]);
						}
					}, delay);
					entry.retryTimer.unref();
					return;
				}

				finishEntry(errorUploadId, (finishing) => {
					const error = new CupboardHttpError(
						'GET',
						options.path,
						status,
						message
					);

					if (finishing.acked) {
						finishing.settleFailed(error);
					} else {
						finishing.rejectAck(error);
					}
				});

				return;
			}

			case 'unsupported': {
				// The session only sends ops the server advertised, so a rejection
				// names a broken server; the whole session rode on that op landing.
				failSession(
					new CommitSocketProtocolError(
						options.path,
						`the server rejected the ${frame.op} op it advertised`
					)
				);
			}
		}
	};

	// On every open (the first connect and each reconnect), drive the outstanding
	// work onto the fresh socket: an acked id resumes with `subscribe` (or
	// `subscribe-identity` when advertised), an un-acked id is re-sent as a commit.
	// On the first open this is just the registered paths' commits. The re-sent
	// commits carry the path identity when batching, so an id whose reply was lost
	// on the drop still resolves via the path identity.
	const replayOutstanding = (): void => {
		const ackedTargets: CommitSessionTarget[] = [];
		const unacked: CommitSessionTarget[] = [];

		for (const [, entry] of outstanding) {
			if (entry.acked) {
				ackedTargets.push(entry.target);
				continue;
			}

			unacked.push(entry.target);
		}

		sendCommits(unacked);

		if (ackedTargets.length === 0) {
			return;
		}

		if (hasSubscribeIdentity) {
			for (const batch of chunk(ackedTargets, commitBatchMaxEntries)) {
				sendNow({
					op: 'subscribe-identity',
					entries: batch.map((target) => ({
						uploadId: target.uploadId,
						storePathHash: target.storePathHash,
						narHash: target.narHash,
						...(target.retention === true &&
							hasIdentityRetentionMarker && { retention: true as const })
					}))
				});
			}
		} else {
			sendNow({
				op: 'subscribe',
				uploadIds: ackedTargets.map((target) => target.uploadId)
			});
		}
	};

	// A drop on an established socket is treated as transient: reconnect and
	// replay, so a network blip does not lose the whole push. Code 1002 means the
	// server rejected the request deliberately; reconnecting cannot fix it. A
	// refused upgrade is handled separately, as it will not heal on retry.
	const onDrop = (code: number, error: Error): void => {
		if (isClosed) {
			return;
		}

		isOpened = false;
		clearKeepalive();

		// The server closes the socket once nothing is outstanding; that is a clean
		// end, not a drop to recover from.
		if (outstanding.size === 0) {
			isClosed = true;
			teardown();

			return;
		}

		if (code === nonRetryableCloseCode) {
			failSession(error);

			return;
		}

		if (options.signal?.aborted === true) {
			failSession(abortReason(options.signal));

			return;
		}

		if (reconnectsLeft <= 0) {
			failSession(error);

			return;
		}

		reconnectsLeft -= 1;
		reconnectTimer = setTimeout(
			() => {
				reconnectTimer = undefined;
				openConnection();
			},
			reconnectDelay(maxReconnects - reconnectsLeft, backoffBase)
		);
		reconnectTimer.unref();
	};

	function armDeadline(uploadId: string): NodeJS.Timeout {
		const deadline = setTimeout(() => {
			finishEntry(uploadId, (entry) => {
				entry.settleFailed(
					new UploadWaitTimeoutError(1, options.timeoutSeconds)
				);
			});
		}, options.timeoutSeconds * 1000);
		deadline.unref();

		return deadline;
	}

	function onAbort(): void {
		if (options.signal !== undefined) {
			failSession(abortReason(options.signal));
		}
	}

	function openConnection(): void {
		isOpened = false;
		effectiveBatchSize = undefined;
		hasSubscribeIdentity = false;
		hasBatchRetentionMarker = false;
		hasIdentityRetentionMarker = false;
		// Window state from the previous connection is stale; replayOutstanding
		// sends all outstanding work afresh through the new window.
		inFlightChunks.clear();
		uploadIdToChunkKey.clear();
		pendingBatchChunks = [];
		// Captured per connection, so `onCapabilities` reports the negotiation of
		// the connection whose `open` fired.
		let connectionCaps: AdvertisedCapabilities = new Map();
		socket = connect(url, headers);

		// The upgrade response precedes the open, so the capability is known
		// before anything is sent on this connection.
		socket.on('upgrade', (response) => {
			const raw = response.headers[commitCapabilitiesHeader];
			const headerValue = Array.isArray(raw) ? raw.join(',') : (raw ?? '');
			connectionCaps = parseCapabilities(headerValue);
			effectiveBatchSize = resolvedBatchSize(connectionCaps);
			hasSubscribeIdentity = connectionCaps.has(subscribeIdentityCapability);
			hasBatchRetentionMarker = hasRetentionMarker(
				connectionCaps,
				commitBatchCapability
			);
			hasIdentityRetentionMarker = hasRetentionMarker(
				connectionCaps,
				subscribeIdentityCapability
			);
		});

		socket.on('open', () => {
			isOpened = true;
			options.onCapabilities?.(connectionCaps);
			replayOutstanding();

			keepalive = setInterval(() => {
				socket?.send(keepaliveRequest);
			}, options.keepaliveMs ?? defaultKeepaliveMs);
			keepalive.unref();
		});

		socket.on('message', (data) => {
			const text = data.toString();

			if (text === keepaliveResponse) {
				return;
			}

			onFrame(text);
		});

		socket.on('close', (code, reason) => {
			const message =
				code === nonRetryableCloseCode
					? `server closed the connection: ${String(code)} ${reason.toString()}`
					: 'the socket closed before every commit settled';
			onDrop(code, new CommitSocketProtocolError(options.path, message));
		});

		socket.on('error', (error) => {
			onDrop(0, error);
		});

		socket.on('unexpected-response', (_request, response) => {
			const chunks: string[] = [];

			response.on('data', (chunk) => {
				chunks.push(chunk.toString());
			});
			response.on('end', () => {
				failSession(
					new CupboardHttpError(
						'GET',
						options.path,
						response.statusCode ?? 0,
						chunks.join('')
					)
				);
			});
		});
	}

	if (options.signal?.aborted === true) {
		onAbort();
	} else {
		options.signal?.addEventListener('abort', onAbort, { once: true });
		openConnection();
	}

	const commit = (target: CommitSessionTarget): Promise<CommitOutcome> => {
		if (failure !== undefined) {
			return Promise.reject(failure);
		}

		if (isClosed) {
			return Promise.reject(
				new CommitSocketProtocolError(options.path, 'the session is closed')
			);
		}

		return new Promise<CommitOutcome>((resolveAck, rejectAck) => {
			const { settled, settleServable, settleFailed } = deferredSettle();
			// A caller that never awaits `settled` (a `--no-wait` push, or an ack
			// that never lands) must not surface its rejection as unhandled.
			void ignoreRejection(settled);

			outstanding.set(target.uploadId, {
				target,
				resolveAck,
				rejectAck,
				settled,
				settleServable,
				settleFailed,
				acked: false,
				retryAttempts: 0
			});

			// An open socket enqueues onto the coalescing flush; before the first
			// open (or mid-reconnect) the op waits and `replayOutstanding` sends it
			// when the socket comes up.
			if (isOpened) {
				enqueueSend(target);
			}
		});
	};

	const close = (): void => {
		if (isClosed) {
			return;
		}

		isClosed = true;
		teardown();
	};

	return { commit, close };
}

// Exponential back-off with full jitter, capped. The jittered delay never
// exceeds the cap, so a test can fire any pending reconnect by advancing a fake
// clock past `maxReconnectBackoffMs`.
function reconnectDelay(attempt: number, base: number): number {
	const ceiling = Math.min(base * 2 ** (attempt - 1), maxReconnectBackoffMs);

	return ceiling / 2 + Math.random() * (ceiling / 2);
}

function safeJsonParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}
