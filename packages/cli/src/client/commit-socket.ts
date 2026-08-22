import {
	type NixSha256HashString,
	type StorePathHash
} from '@cupboard/nix-store/scalars';
import {
	commitAcceptCapabilitiesHeader,
	commitAuthenticationExpiredCloseCode,
	commitAuthenticationExpiredCloseReason,
	commitBatchCapability,
	commitBatchMaxEntries,
	commitCapabilitiesHeader,
	commitCreditCapability,
	commitCreditGrantAttribute,
	commitSessionFrameSchema,
	type CommitSessionRequest,
	type ParsedUploadGraceFact,
	retentionMarkerAttribute,
	retentionMarkerAttributeValue,
	subscribeIdentityCapability,
	type UploadId
} from '@cupboard/protocol/upload';
import { chunk } from '@cupboard/shared/collections';
import { BoundedBodyCollector } from '@cupboard/shared/response-body';
import { retryAfterDelayMs } from '@cupboard/shared/retry';
import { z } from 'zod';

import { abortReason } from '../abort.ts';
import {
	CommitCapacityQueuedError,
	CommitCapacityTimeoutError,
	CommitSocketProtocolError,
	CupboardHttpError,
	TokenProviderError,
	UploadVerificationFailedError,
	UploadWaitTimeoutError
} from '../errors.ts';

import type { BearerAttempt } from './credentials.ts';

/**
A received WebSocket frame; `ws` hands it over as a `Buffer`.
*/
export interface CommitSocketData {
	toString(): string;
}

/**
A refused upgrade body chunk; Node hands it over as a `Buffer`.
*/
export interface UpgradeBodyChunk extends Uint8Array {
	toString(): string;
}

/**
 * The HTTP response returned when the server refuses an upgrade (a `ws`
 * `IncomingMessage`). `ws` hands a refused connection to the listener but does
 * not consume the response, so the session calls `destroy` after reading it.
 */
export interface UpgradeFailure {
	readonly statusCode?: number;
	readonly headers: Readonly<Record<string, string | string[] | undefined>>;
	on(event: 'data', listener: (chunk: UpgradeBodyChunk) => void): unknown;
	on(event: 'end', listener: () => void): unknown;
	destroy(): void;
}

export interface UpgradeResponse {
	readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

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

export type CommitSocketConnect = (
	url: URL,
	headers: Readonly<Record<string, string>>
) => CommitSocket;

/**
 * Supplies authentication for the first commit connection and every reconnect.
 * The session requests a new attempt after an expiry close. If an upgrade
 * returns 401, it refreshes the current attempt once.
 */
export interface CommitSocketCredentials {
	readonly initial: BearerAttempt;
	authorise(): Promise<BearerAttempt>;
}

/**
 * The path identity supports recovery when a reconnect finds that the pending
 * row was already cleared. `retention` is set when the original negotiation
 * response acknowledged `upload-grace-facts`. On an identity-based reconnect,
 * it asks a capable server to return the stored grace fact.
 */
export interface CommitSessionTarget {
	readonly uploadId: UploadId;
	readonly storePathHash: StorePathHash;
	readonly narHash: NixSha256HashString;
	readonly retention?: boolean;
}

/**
A bare capability token, with no semicolons, maps to an empty record.
*/
export type CapabilityAttributes = Readonly<Record<string, string>>;

export type AdvertisedCapabilities = ReadonlyMap<string, CapabilityAttributes>;

export interface CommitSessionOptions {
	readonly path: string;
	/**
	Bounds both a deferred verdict and the wait for commit capacity.
	*/
	readonly timeoutSeconds: number;
	readonly signal?: AbortSignal;
	readonly keepaliveMs?: number;
	readonly maxReconnects?: number;
	readonly reconnectBackoffMs?: number;
	readonly onCapabilities?: (capabilities: AdvertisedCapabilities) => void;
	/**
	 * Called when the session starts waiting for the server to grant commit
	 * capacity, and again when it stops. It reports only the state transition:
	 * queue position can change whenever another tenant entry settles, so the
	 * client has no stable position or completion estimate.
	 */
	readonly onWaiting?: (isWaitingForCapacity: boolean) => void;
}

/**
 * Separates the server's durable acknowledgement from the final verification
 * result. `commit` returns after the pending row exists, which allows retention
 * to be recorded immediately. `settled` completes when the path is servable or
 * verification fails. Reuse and inline verification complete both stages in
 * the same frame.
 */
export interface CommitOutcome {
	readonly storePathHash: StorePathHash;
	readonly narHash: NixSha256HashString;
	readonly status: 'committed' | 'pending' | 'already-present';
	readonly settled: Promise<void>;
	// The acknowledgement reports the captured policy decision for a pending
	// outcome and the stored deadline for a final outcome.
	readonly grace?: ParsedUploadGraceFact;
	// Reads the final grace fact after `settled`. Deferred paths receive their
	// deadline in the verdict rather than the acknowledgement.
	readonly verdictGrace?: () => ParsedUploadGraceFact | undefined;
}

export interface CommitSession {
	commit(target: CommitSessionTarget): Promise<CommitOutcome>;
	/**
	Closes the socket; safe once every commit has settled.
	*/
	close(): void;
}

interface SessionEntry {
	readonly target: CommitSessionTarget;
	readonly resolveAck: (outcome: CommitOutcome) => void;
	readonly rejectAck: (error: Error) => void;
	readonly settled: Promise<void>;
	readonly settleServable: () => void;
	readonly settleFailed: (error: Error) => void;
	// Records whether the server created a durable pending row. Reconnects
	// subscribe to acknowledged entries, but resend unacknowledged entries because
	// their original commit might not have reached the server.
	acked: boolean;
	deadline?: NodeJS.Timeout;
	retryAttempts: number;
	retryTimer?: NodeJS.Timeout;
	// The grace fact of the last `settled` or `verdict` frame, exposed through
	// the outcome's `verdictGrace` once the entry has its verdict.
	verdictGrace?: ParsedUploadGraceFact;
}

type DropCause =
	| { readonly kind: 'connection' }
	| { readonly kind: 'authentication-expired' }
	| { readonly kind: 'refusal'; readonly minimumDelayMs?: number };

const connectionDrop: DropCause = { kind: 'connection' };

const defaultKeepaliveMs = 30_000;
const defaultMaxReconnects = 5;
const defaultReconnectBackoffMs = 500;
const maxReconnectBackoffMs = 5000;
const keepaliveRequest = 'ping';
const keepaliveResponse = 'pong';
// WebSocket close code for a server-side protocol rejection. Retrying cannot
// heal it, so the session fails immediately on this code.
const nonRetryableCloseCode = 1002;

// Maximum number of commit-batch messages in flight at once, for a server that
// does not pace the session itself. Once this many are outstanding, further
// chunks queue until any frame for an in-flight chunk arrives (the ANY-frame
// rule: one frame means the server parsed the message and is processing its
// entries concurrently, so it counts as done for windowing purposes).
//
// A server advertising `commit-credit` grants the session what it may send, and
// that replaces this window entirely for the connection.
const maxInFlightBatchMessages = 2;

// Node.js truncates timer delays above this value to one millisecond. Longer
// deadlines therefore use instalments that recalculate the remaining delay.
const maxTimerDelayMs = 2 ** 31 - 1;

// Status codes that indicate a transient server overload: a short per-entry
// backoff and re-send may succeed where an immediate retry would not. An error
// frame is written by the tenant's own object, which reports every transient
// condition of its own as one of these two.
const retryableErrorStatuses = new Set([429, 503]);

// Cap `Retry-After` above the reconnect back-off ceiling so valid server delays
// still take effect, but an unbounded value cannot consume the whole capacity
// deadline.
const maxRetryAfterMs = 60_000;

// Bound refusal-body reads when a peer truncates and half-closes the body or
// declares a length it never sends. Without this timer, either case could leave
// the session waiting indefinitely.
const refusalDrainMs = 5000;
const maximumRefusalBodyBytes = 64 * 1024;
// How many times one entry is re-sent before its error is treated as terminal.
const maxEntryRetries = 3;
const entryRetryBaseMs = 500;

// Validate every recognised event against its complete frame schema. Unknown
// event kinds are ignored so a newer server can add advisory frames.
const knownEvs = new Set([
	'settled',
	'deferred',
	'verdict',
	'error',
	'unsupported',
	'credit',
	'queued'
]);

// Observe `settled` when the caller chooses not to wait, preventing a later
// verification failure from becoming an unhandled rejection.
async function ignoreRejection(promise: Promise<unknown>): Promise<void> {
	try {
		await promise;
	} catch {
		// The caller still observes the rejection if it awaits `settled`.
	}
}

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

// Without `commit-batch`, use the per-entry protocol. An invalid or absent
// `max` attribute uses the protocol default, and a larger value is capped at
// the protocol bound.
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

// Without `commit-credit`, use the local window. An unreadable grant starts at
// zero and requires a `request-credit` before the client sends entries.
function resolvedOpeningGrant(
	capabilities: AdvertisedCapabilities
): number | undefined {
	const attributes = capabilities.get(commitCreditCapability);

	if (attributes === undefined) {
		return undefined;
	}

	const grant = Number(attributes[commitCreditGrantAttribute]);

	if (!Number.isSafeInteger(grant) || grant < 0) {
		return 0;
	}

	return grant;
}

// The server decides to pace a session from the request declaration alone and
// closes it for overdrawing. A session that declares the token must therefore
// pace itself even when the 101 comes back without it: an intermediary that
// answers the upgrade itself can drop the response header.
function isCommitCreditDeclared(
	headers: Readonly<Record<string, string>>
): boolean {
	for (const [name, value] of Object.entries(headers)) {
		if (name.toLowerCase() !== commitAcceptCapabilitiesHeader) {
			continue;
		}

		return parseCapabilities(value).has(commitCreditCapability);
	}

	return false;
}

// Set `retention: true` only when the relevant operation advertises the exact
// marker value. Older servers validate operation bodies strictly and reject
// this field.
function hasRetentionMarker(
	capabilities: AdvertisedCapabilities,
	capability: string
): boolean {
	return (
		capabilities.get(capability)?.[retentionMarkerAttribute] ===
		retentionMarkerAttributeValue
	);
}

// Keepalives preserve deferred waits without waking the Durable Object.
// Transient drops reconnect with bounded back-off and replay work according to
// whether the server had already acknowledged it.
export function runCommitSession(
	connect: CommitSocketConnect,
	url: URL,
	credentials: CommitSocketCredentials,
	options: CommitSessionOptions
): CommitSession {
	const outstanding = new Map<UploadId, SessionEntry>();
	const maxReconnects = options.maxReconnects ?? defaultMaxReconnects;
	const backoffBase = options.reconnectBackoffMs ?? defaultReconnectBackoffMs;
	const isCreditDeclared = isCommitCreditDeclared(credentials.initial.headers);

	let socket: CommitSocket | undefined;
	// Events from superseded sockets must not mutate current session state. Each
	// handler captures this generation and ignores events after it changes.
	let connectionGeneration = 0;
	let isOpened = false;
	let isClosed = false;
	// When the server closes an idle socket with no outstanding work, keep the
	// session dormant. The next commit can open a fresh connection.
	let isDormant = false;
	let failure: Error | undefined;
	let keepalive: NodeJS.Timeout | undefined;
	let reconnectTimer: NodeJS.Timeout | undefined;
	let isAuthorising = false;
	let connectionAttempt = credentials.initial;
	// Store the refusal-body timer at session scope so teardown or a superseding
	// connection can clear it.
	let refusalDrainTimer: NodeJS.Timeout | undefined;
	// Preserve `Retry-After` across dormancy. The next commit often triggers the
	// connection attempt to which the delay applies.
	let earliestDialAt = 0;
	let reconnectsLeft = maxReconnects;
	// Count reconnects since the server last answered an entry. Back-off uses this
	// count because some reconnects preserve the retry budget but must still dial
	// less frequently.
	let reconnectAttempt = 0;
	let effectiveBatchSize: number | undefined;
	// Use `subscribe-identity` for acknowledged entries only when the current
	// connection advertises it. The server can then resolve a row that settled
	// and cleared during the drop.
	let hasSubscribeIdentity = false;
	// Mark a grace-aware upload only when the current connection advertises the
	// `retention` marker for `commit-batch` or `subscribe-identity`. After a
	// reconnect, the server can then return the stored grace fact.
	let hasBatchRetentionMarker = false;
	let hasIdentityRetentionMarker = false;
	// Credit and declared demand belong to one connection. A new 101 supplies a
	// new grant, and closing the old connection clears its demand on the server.
	// `undefined` selects the client-side batch window instead of server pacing.
	let creditAvailable: number | undefined;
	let declaredDemand = 0;
	// Initialise credit pacing from the upgrade request because the server enforces
	// that declaration even if the response token is stripped. The capacity clock
	// therefore runs before a connection opens. Only an `unsupported` response to
	// `request-credit` disables pacing, and only for that connection.
	let isCreditPaced = isCreditDeclared;
	// Entries the caller has committed that the server has not acknowledged with
	// a durable row. An acked entry is bounded by its own verdict deadline
	// instead. Kept as a count because the capacity wait consults it on every
	// frame.
	let unackedEntries = 0;

	// Track the current capacity wait separately from total wait time across the
	// session. See {@link isWaitingForCapacity}.
	let accruedWaitMs = 0;
	let totalWaitedMs = 0;
	let waitingSince: number | undefined;
	let capacityTimer: NodeJS.Timeout | undefined;
	let isWaitingReported = false;
	// The latest server-reported queue position, retained only for timeout
	// diagnostics.
	let lastAhead: number | undefined;
	// Preserve the latest retryable refusal while one capacity wait remains in
	// progress. If that wait expires without progress, its error includes the
	// refusal's status and body. Progress, expiry, and dormancy all clear it so a
	// later wait cannot report stale server state.
	let lastRefusal: CupboardHttpError | undefined;

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
	const inFlightChunks = new Map<string, Set<UploadId>>();
	const uploadIdToChunkKey = new Map<UploadId, string>();
	let pendingBatchChunks: CommitSessionTarget[][] = [];

	const sendBatchMessage = (batch: readonly CommitSessionTarget[]): void => {
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

	const sendBatchChunk = (batch: readonly CommitSessionTarget[]): void => {
		const chunkKey = batch[0]?.uploadId ?? '';
		const ids = new Set(batch.map((t) => t.uploadId));
		inFlightChunks.set(chunkKey, ids);

		for (const id of ids) {
			uploadIdToChunkKey.set(id, chunkKey);
			inFlightEntries.add(id);
		}

		sendBatchMessage(batch);
	};

	const releaseChunkForUploadId = (uploadId: UploadId): void => {
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

	// This queue belongs to one connection. Reconnect discards it and rebuilds it
	// from `outstanding` under the new connection's grant.
	let queuedTargets: CommitSessionTarget[] = [];

	// Entries awaiting their first frame on this connection. Any first frame,
	// including `deferred`, returns the entry's credit. Reconnect rebuilds the set
	// when it replays outstanding work.
	const inFlightEntries = new Set<UploadId>();

	// A verdict can finish a retry while its target is still queued. Remove that
	// target so it no longer contributes to demand or the capacity wait.
	const removeQueuedTarget = (uploadId: UploadId): void => {
		const index = queuedTargets.findIndex(
			(target) => target.uploadId === uploadId
		);

		if (index === -1) {
			return;
		}

		queuedTargets.splice(index, 1);
	};

	// Capacity time runs while unacknowledged work exists and no sent entry can
	// return credit. Connection state is irrelevant, so a partition cannot reset
	// the deadline. Use session-wide `outstanding` state because reconnect replaces
	// the per-connection queue. A grant or first frame starts a new wait;
	// `totalWaitedMs` retains the complete history for diagnostics.
	const isWaitingForCapacity = (): boolean =>
		!isClosed &&
		isCreditPaced &&
		unackedEntries > 0 &&
		inFlightEntries.size === 0;

	const accrueCapacityWait = (): number => {
		if (waitingSince === undefined) {
			return accruedWaitMs;
		}

		const waited = Date.now() - waitingSince;
		accruedWaitMs += waited;
		totalWaitedMs += waited;
		waitingSince = undefined;

		return accruedWaitMs;
	};

	const clearCapacityDeadline = (): void => {
		if (capacityTimer === undefined) {
			return;
		}

		clearTimeout(capacityTimer);
		capacityTimer = undefined;
	};

	const waitedSoFar = (): number =>
		accruedWaitMs +
		(waitingSince === undefined ? 0 : Date.now() - waitingSince);

	// Arms the deadline for what is left of the budget. The runtime truncates a
	// delay past `maxTimerDelayMs` to one millisecond, so a longer budget is
	// armed in instalments and each instalment measures the wait again.
	const armCapacityDeadline = (): void => {
		const remaining = options.timeoutSeconds * 1000 - waitedSoFar();

		capacityTimer =
			remaining > maxTimerDelayMs
				? setTimeout(armCapacityDeadline, maxTimerDelayMs)
				: setTimeout(expireCapacityWait, Math.max(0, remaining));
		capacityTimer.unref();
	};

	// The cache granted capacity or answered an entry, so the next wait starts
	// from zero.
	const noteCapacityProgress = (): void => {
		accrueCapacityWait();
		accruedWaitMs = 0;
		clearCapacityDeadline();
		lastRefusal = undefined;
	};

	// Fail work that the server never admitted once the capacity budget expires.
	// This can happen while disconnected, so reject from `outstanding` rather than
	// the per-connection queue. Entries awaiting verdicts have durable server rows
	// and remain bounded by their own deadlines.
	const expireCapacityWait = (): void => {
		capacityTimer = undefined;
		const waited = accrueCapacityWait();
		queuedTargets = [];
		const error = new CommitCapacityTimeoutError(
			options.timeoutSeconds,
			Math.round(waited / 1000),
			new CommitCapacityQueuedError(lastAhead, { cause: lastRefusal }),
			Math.round(totalWaitedMs / 1000)
		);

		for (const [uploadId, entry] of outstanding) {
			if (entry.acked) {
				continue;
			}

			finishEntry(uploadId, (expiring) => {
				expiring.rejectAck(error);
			});
		}

		// Cancel the pending reconnect after the final unacknowledged entry times
		// out. This lets the process exit during a partition.
		if (outstanding.size === 0) {
			goDormant();
		} else {
			abandonConnection();
		}

		// A later commit waits from zero on whichever connection comes next.
		// `totalWaitedMs` keeps this wait, since it covers the whole session.
		accruedWaitMs = 0;
		lastRefusal = undefined;
		updateCapacityWait();
	};

	const updateCapacityWait = (): void => {
		const isWaiting = isWaitingForCapacity();

		if (isWaiting && waitingSince === undefined) {
			waitingSince = Date.now();
			armCapacityDeadline();
		}

		if (!isWaiting && waitingSince !== undefined) {
			accrueCapacityWait();
			clearCapacityDeadline();
		}

		if (isWaiting !== isWaitingReported) {
			isWaitingReported = isWaiting;
			options.onWaiting?.(isWaiting);
		}
	};

	// Tells the server how many entries are queued, so it can grant against a
	// real figure. The declaration is absolute and replaces the last one, and is
	// re-sent only when the queue has grown past it, so a steady drain sends one
	// declaration rather than one per path.
	const declareDemand = (): void => {
		if (creditAvailable === undefined || !isOpened || isClosed) {
			return;
		}

		if (
			queuedTargets.length === 0 ||
			creditAvailable > 0 ||
			queuedTargets.length <= declaredDemand
		) {
			return;
		}

		declaredDemand = queuedTargets.length;
		sendNow({ op: 'request-credit', entries: declaredDemand });
	};

	const drainCredit = (): void => {
		while (
			isOpened &&
			!isClosed &&
			creditAvailable !== undefined &&
			creditAvailable > 0 &&
			queuedTargets.length > 0
		) {
			const drained = queuedTargets.splice(
				0,
				Math.min(effectiveBatchSize ?? 1, creditAvailable)
			);
			const batch = drained.filter((target) =>
				outstanding.has(target.uploadId)
			);

			if (batch.length === 0) {
				continue;
			}

			creditAvailable -= batch.length;

			for (const target of batch) {
				inFlightEntries.add(target.uploadId);
			}

			if (effectiveBatchSize === undefined) {
				for (const target of batch) {
					sendNow({ op: 'commit', uploadId: target.uploadId });
				}
			} else {
				sendBatchMessage(batch);
			}
		}

		declareDemand();
		updateCapacityWait();
	};

	// Send commits with the protocol that this connection supports: one
	// `commit-batch` op per bounded chunk when the server offered it, a per-id
	// `commit` op otherwise. A paced server admits only the entries covered by its
	// grant; the remainder stay queued.
	//
	// On a reconnect without `commit-batch`, a bare re-sent op may try to commit
	// a row that already settled and cleared between the drop and the replay. The
	// server answers with an error frame for such an id. There is no way to supply
	// identity to the plain op against a server that does not advertise
	// `commit-batch`, so this asymmetry is inherent to the non-batching path.
	// Entry deadlines bound the window in which it can occur.
	const sendCommits = (targets: readonly CommitSessionTarget[]): void => {
		if (creditAvailable !== undefined) {
			queuedTargets.push(...targets);
			drainCredit();

			return;
		}

		if (effectiveBatchSize === undefined) {
			for (const target of targets) {
				inFlightEntries.add(target.uploadId);
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

	// Coalesce commits registered during one microtask so a burst, such as reuse
	// commits from a large push, uses only a few batch operations. Skip entries
	// that settle or vanish before the flush. A drop discards this queue because
	// reconnect replays every outstanding entry.
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

	const clearReconnectTimer = (): void => {
		if (reconnectTimer === undefined) {
			return;
		}

		clearTimeout(reconnectTimer);
		reconnectTimer = undefined;
	};

	const clearRefusalDrain = (): void => {
		if (refusalDrainTimer === undefined) {
			return;
		}

		clearTimeout(refusalDrainTimer);
		refusalDrainTimer = undefined;
	};

	const teardown = (): void => {
		clearKeepalive();
		clearCapacityDeadline();
		clearReconnectTimer();
		clearRefusalDrain();
		// Closing the session ends any reported capacity wait. Individual outcomes
		// distinguish successful admission from failure.
		updateCapacityWait();

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

	// Closing a socket releases its declared demand and granted credit on the
	// server. Keep the entries for replay after an automatic reconnect or the
	// next commit.
	const abandonConnection = (): void => {
		clearKeepalive();
		isOpened = false;
		creditAvailable = undefined;
		declaredDemand = 0;
		inFlightEntries.clear();
		socket?.close();
	};

	const goDormant = (): void => {
		clearReconnectTimer();
		isDormant = true;
		lastRefusal = undefined;
		abandonConnection();
	};

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
			// Acknowledged entries fail through `settled`; unacknowledged entries
			// fail the original commit call.
			if (entry.acked) {
				entry.settleFailed(error);
			} else {
				entry.rejectAck(error);
			}
		}
	};

	const finishEntry = (
		uploadId: UploadId,
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

		if (!entry.acked) {
			unackedEntries -= 1;
		}

		// No id is ever in flight and queued at once: the drain splices a target
		// out of the queue as it sends it, and the retry and deferred paths take
		// an id out of the in-flight set before it can be re-queued. The queue
		// scan therefore only runs for an entry that was never sent.
		if (!inFlightEntries.delete(uploadId)) {
			removeQueuedTarget(uploadId);
		}

		settle(entry);
		// The session may have been waiting on this entry's reply to bring credit
		// back, so a finished entry can start the capacity wait.
		updateCapacityWait();
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

		// An unknown event kind can come from a future server version; ignore it.
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

		const frame = parsed.data;

		// Any frame with an upload ID acknowledges that batch chunk for windowing
		// and releases the next queued chunk (the ANY-frame rule).
		if ('uploadId' in frame) {
			releaseChunkForUploadId(frame.uploadId);
		}

		// Restore the reconnect budget only when the server first acknowledges
		// outstanding work. Replay deliberately elicits repeated `deferred` frames;
		// counting those as progress would permit an endless reconnect loop.
		const answered =
			'uploadId' in frame ? outstanding.get(frame.uploadId) : undefined;

		if (
			answered !== undefined &&
			!(frame.ev === 'deferred' && answered.acked)
		) {
			reconnectsLeft = maxReconnects;
			reconnectAttempt = 0;
		}

		switch (frame.ev) {
			case 'settled': {
				// Ignore stale frames before recording capacity progress. They do not
				// return credit for any current entry.
				if (!outstanding.has(frame.uploadId)) {
					return;
				}

				noteCapacityProgress();

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
						verdictGrace: () => entry.verdictGrace
					});
				});

				return;
			}

			case 'deferred': {
				const entry = outstanding.get(frame.uploadId);

				if (entry === undefined) {
					return;
				}

				// A reconnect resubscribes every deferred entry and the server answers
				// each with a fresh `deferred` frame, so only the first one for an
				// entry returns credit.
				const isFirstDeferral = !entry.acked;

				// The durable row is now available for retention. Resolve the
				// acknowledgement, but keep the entry until its verdict settles.
				entry.acked = true;
				entry.deadline ??= armDeadline(frame.uploadId);
				entry.resolveAck({
					storePathHash: frame.storePathHash,
					narHash: frame.narHash,
					status: 'pending',
					settled: entry.settled,
					...(frame.grace !== undefined && { grace: frame.grace }),
					verdictGrace: () => entry.verdictGrace
				});

				if (isFirstDeferral) {
					unackedEntries -= 1;
					noteCapacityProgress();
				}

				inFlightEntries.delete(frame.uploadId);
				updateCapacityWait();

				return;
			}

			case 'verdict': {
				const entry = outstanding.get(frame.uploadId);

				if (entry === undefined) {
					return;
				}

				noteCapacityProgress();

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

						// A verdict can arrive before its deferred acknowledgement. Use the
						// target identity to return the committed outcome immediately.
						if (!settling.acked) {
							settling.resolveAck({
								storePathHash: settling.target.storePathHash,
								narHash: settling.target.narHash,
								status: 'committed',
								settled: settling.settled,
								...(frame.grace !== undefined && { grace: frame.grace }),
								verdictGrace: () => settling.verdictGrace
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

					if (entry.retryTimer !== undefined) {
						clearTimeout(entry.retryTimer);
					}

					entry.retryTimer = setTimeout(() => {
						entry.retryTimer = undefined;

						if (isOpened && !isClosed && outstanding.has(errorUploadId)) {
							sendCommits([entry.target]);
						}
					}, delay);
					entry.retryTimer.unref();

					// The error is the first response for this attempt. Remove the entry
					// from the in-flight set before its retry returns to the queue.
					inFlightEntries.delete(errorUploadId);
					updateCapacityWait();

					return;
				}

				noteCapacityProgress();

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

			case 'credit': {
				noteCapacityProgress();

				// The server deducts each grant from this connection's declared
				// demand. Mirror that deduction so the next drain declares only the
				// remaining queue.
				creditAvailable = (creditAvailable ?? 0) + frame.grant;
				declaredDemand = Math.max(0, declaredDemand - frame.grant);
				drainCredit();

				return;
			}

			case 'queued': {
				// The server has no capacity to grant yet. Retain the queue position
				// for a possible timeout diagnostic; the capacity wait is already active.
				lastAhead = frame.ahead;

				return;
			}

			case 'unsupported': {
				// The client declares `request-credit` in the upgrade request, so it
				// may receive `unsupported` from an older server. Disable server pacing
				// for this connection and send through the client-side batch window.
				if (frame.op === 'request-credit') {
					const queued = queuedTargets;
					queuedTargets = [];
					creditAvailable = undefined;
					isCreditPaced = false;
					declaredDemand = 0;
					// Stop this capacity wait when the server declines pacing. A later
					// connection that enables pacing starts a new wait.
					noteCapacityProgress();
					updateCapacityWait();
					sendCommits(queued);

					return;
				}

				// Every other op is sent only when the server advertised it, so a
				// rejection means the server is broken; every outstanding commit
				// depended on that op being accepted.
				failSession(
					new CommitSocketProtocolError(
						options.path,
						`the server rejected the ${frame.op} op it advertised`
					)
				);
			}
		}
	};

	// Replay unacknowledged entries as commits. Resume acknowledged entries with
	// `subscribe`, or with `subscribe-identity` when the server supports recovery
	// after a settled row has been cleared. Batched commits include path identity
	// so a lost acknowledgement can also be recovered.
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

	// Reopens after a back-off. This timer only exists while entries are
	// outstanding, and between the drop and the reopen it can be the process's
	// only handle: the session's other timers are unref'd and no socket exists.
	// Unref it and a run whose remaining work all waits on this session exits
	// with its awaits unsettled instead of reconnecting.
	//
	// `Retry-After` can extend but never shorten exponential back-off.
	const scheduleReconnect = (minimumDelayMs = 0): void => {
		reconnectAttempt += 1;
		reconnectTimer = setTimeout(
			() => {
				reconnectTimer = undefined;
				authoriseAndOpenConnection();
			},
			Math.max(reconnectDelay(reconnectAttempt, backoffBase), minimumDelayMs)
		);
	};

	const authoriseAndOpenConnection = (): void => {
		if (isClosed || isAuthorising) {
			return;
		}

		isAuthorising = true;
		isDormant = false;
		void credentials
			.authorise()
			.then((attempt) => {
				isAuthorising = false;

				if (!isClosed) {
					openConnection(attempt);
				}
			})
			.catch((error: unknown) => {
				isAuthorising = false;
				failSession(asError(error));
			});
	};

	const refreshAndOpenConnection = (refusal: Error): void => {
		if (isClosed || isAuthorising) {
			return;
		}

		isAuthorising = true;
		isDormant = false;
		void connectionAttempt
			.refreshAfterAuthenticationFailure()
			.then((attempt) => {
				isAuthorising = false;

				if (isClosed) {
					return;
				}

				if (attempt === undefined) {
					failSession(refusal);

					return;
				}

				openConnection(attempt);
			})
			.catch((error: unknown) => {
				isAuthorising = false;
				failSession(asError(error));
			});
	};

	// Open a connection for work added to a dormant session. If the previous
	// refusal supplied `Retry-After`, delay this caller-triggered dial until that
	// interval has elapsed.
	const openDormantConnection = (): void => {
		const remaining = earliestDialAt - Date.now();

		if (remaining <= 0) {
			authoriseAndOpenConnection();

			return;
		}

		// The dial is pending from here, so a further commit registers its entry
		// and waits for it rather than opening a second connection.
		isDormant = false;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = undefined;
			authoriseAndOpenConnection();
		}, remaining);
	};

	// Reconnect and replay after transient connection failures. Protocol close
	// code 1002 is terminal because the server deliberately rejected the request.
	// Retryable upgrade refusals also use this path because a later dial can succeed.
	const onDrop = (
		code: number,
		error: Error,
		cause: DropCause = connectionDrop
	): void => {
		if (isClosed) {
			return;
		}

		const minimumDelayMs =
			cause.kind === 'refusal' ? (cause.minimumDelayMs ?? 0) : 0;

		// Record the earliest permitted dial for every retryable refusal. This also
		// constrains a later caller-triggered dial if a capacity timeout cancels the
		// scheduled reconnect and leaves the session dormant.
		if (cause.kind === 'refusal') {
			earliestDialAt = Math.max(earliestDialAt, Date.now() + minimumDelayMs);
		}

		// Record whether the server had received an entry but had not answered it.
		// Read this before clearing connection state so a later failed dial retains
		// the correct retry-budget classification.
		const wasAnswerOwed = inFlightEntries.size > 0;

		isOpened = false;
		clearKeepalive();
		inFlightEntries.clear();
		updateCapacityWait();

		// `replayOutstanding` re-sends every un-acked entry on the fresh
		// connection, so a retry armed on the old one would send its entry a
		// second time.
		for (const entry of outstanding.values()) {
			if (entry.retryTimer === undefined) {
				continue;
			}

			clearTimeout(entry.retryTimer);
			entry.retryTimer = undefined;
		}

		// An idle close with no outstanding entries loses no work. Leave the
		// session dormant so a later commit opens a fresh connection and negotiates
		// new capabilities and credit.
		if (outstanding.size === 0) {
			isDormant = true;
			creditAvailable = undefined;
			reconnectsLeft = maxReconnects;
			lastRefusal = undefined;

			// Preserve back-off after a refusal because the next dial retries the same
			// rejected session. Reset it after an ordinary idle close because the
			// server had accepted the connection and closed it only after inactivity.
			if (cause.kind !== 'refusal') {
				reconnectAttempt = 0;
			}

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

		if (cause.kind === 'authentication-expired') {
			reconnectAttempt = 0;
			authoriseAndOpenConnection();

			return;
		}

		// A paced session preserves its reconnect budget when no server response was
		// outstanding. Unadmitted entries remain bounded by the capacity deadline,
		// while acknowledged entries remain bounded by their verdict deadlines. Both
		// deadlines continue through disconnection, including for durable server work.
		//
		// An unpaced session has no capacity deadline, so the budget is the only
		// bound it has and every drop spends one, a failed dial included.
		if (!wasAnswerOwed && isCreditPaced) {
			scheduleReconnect(minimumDelayMs);

			return;
		}

		if (reconnectsLeft <= 0) {
			failSession(error);

			return;
		}

		reconnectsLeft -= 1;
		scheduleReconnect(minimumDelayMs);
	};

	// Fail a deferred entry whose verdict never arrives. For a deadline beyond the
	// timer limit, each instalment recalculates the remaining delay and only the
	// final instalment fails the entry.
	function armDeadline(uploadId: UploadId): NodeJS.Timeout {
		const expiresAt = Date.now() + options.timeoutSeconds * 1000;

		const armInstalment = (): NodeJS.Timeout => {
			const remaining = expiresAt - Date.now();

			if (remaining > maxTimerDelayMs) {
				const instalment = setTimeout(() => {
					const entry = outstanding.get(uploadId);

					if (entry !== undefined) {
						entry.deadline = armInstalment();
					}
				}, maxTimerDelayMs);
				instalment.unref();

				return instalment;
			}

			const deadline = setTimeout(
				() => {
					finishEntry(uploadId, (entry) => {
						entry.settleFailed(
							new UploadWaitTimeoutError(1, options.timeoutSeconds)
						);
					});
				},
				Math.max(0, remaining)
			);
			deadline.unref();

			return deadline;
		};

		return armInstalment();
	}

	function onAbort(): void {
		if (options.signal !== undefined) {
			failSession(abortReason(options.signal));
		}
	}

	function openConnection(attempt: BearerAttempt): void {
		// Cancel pending reconnect and refusal timers before installing the new
		// connection. Otherwise a stale timer could open another connection or act
		// on a refusal from the superseded handshake.
		clearReconnectTimer();
		clearRefusalDrain();
		connectionAttempt = attempt;
		connectionGeneration += 1;
		const generation = connectionGeneration;
		// A superseded socket keeps its listeners and can still deliver events:
		// `ws` emits `error` and `close` for the same fault, and a socket the
		// session has moved on from goes on running its own handshake. Session
		// state belongs to the current connection alone.
		const isCurrent = (): boolean => generation === connectionGeneration;
		let hasDropped = false;
		const dropOnce = (
			code: number,
			error: Error,
			cause: DropCause = connectionDrop
		): void => {
			if (hasDropped || !isCurrent()) {
				return;
			}

			hasDropped = true;
			onDrop(code, error, cause);
		};

		isOpened = false;
		isDormant = false;
		effectiveBatchSize = undefined;
		hasSubscribeIdentity = false;
		hasBatchRetentionMarker = false;
		hasIdentityRetentionMarker = false;
		// Window state from the previous connection is stale; replayOutstanding
		// sends all outstanding work afresh through the new window.
		inFlightChunks.clear();
		uploadIdToChunkKey.clear();
		pendingBatchChunks = [];
		// A grant and its declared demand belong to one connection. Clear both,
		// but preserve the session-wide time already spent waiting for capacity.
		creditAvailable = undefined;
		declaredDemand = 0;
		queuedTargets = [];
		inFlightEntries.clear();
		// Captured per connection, so `onCapabilities` reports the negotiation of
		// the connection whose `open` fired.
		let connectionCaps: AdvertisedCapabilities = new Map();
		// Record the opening grant but do not count it as progress until the
		// connection opens. A refused handshake must not reset the capacity wait.
		let openingGrant = 0;
		// Capture the connection for its handlers so stale events cannot act on the
		// session's current socket.
		const connection = connect(url, connectionAttempt.headers);
		socket = connection;

		// The upgrade response precedes the open, so the capability is known
		// before anything is sent on this connection.
		connection.on('upgrade', (response) => {
			if (!isCurrent()) {
				return;
			}

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
			// The server enforces the capability from the request. If an intermediary
			// strips it from the response, start with zero credit and request a grant.
			creditAvailable =
				resolvedOpeningGrant(connectionCaps) ??
				(isCreditDeclared ? 0 : undefined);
			// Negotiate pacing per connection. A new connection can restore pacing
			// after an older server rejected it on the previous one.
			isCreditPaced = creditAvailable !== undefined;
			openingGrant = creditAvailable ?? 0;
		});

		connection.on('open', () => {
			if (!isCurrent()) {
				return;
			}

			isOpened = true;
			options.onCapabilities?.(connectionCaps);

			// A positive opening grant is capacity progress. Reset the wait only after
			// the socket opens, so a rejected handshake cannot count its advertised
			// grant. Reset before replay because replay can immediately arm a new wait
			// for entries beyond the grant.
			if (openingGrant > 0) {
				noteCapacityProgress();
			}

			replayOutstanding();

			keepalive = setInterval(() => {
				connection.send(keepaliveRequest);
			}, options.keepaliveMs ?? defaultKeepaliveMs);
			keepalive.unref();
		});

		connection.on('message', (data) => {
			if (!isCurrent()) {
				return;
			}

			const text = data.toString();

			if (text === keepaliveResponse) {
				return;
			}

			onFrame(text);
		});

		connection.on('close', (code, reason) => {
			const reasonText = reason.toString();
			const message =
				code === nonRetryableCloseCode
					? `server closed the connection: ${String(code)} ${reasonText}`
					: 'the socket closed before every commit settled';
			const cause: DropCause =
				code === commitAuthenticationExpiredCloseCode &&
				reasonText === commitAuthenticationExpiredCloseReason
					? { kind: 'authentication-expired' }
					: connectionDrop;
			dropOnce(
				code,
				new CommitSocketProtocolError(options.path, message),
				cause
			);
		});

		connection.on('error', (error) => {
			dropOnce(0, error);
		});

		connection.on('unexpected-response', (_request, response) => {
			if (!isCurrent()) {
				return;
			}

			const body = new BoundedBodyCollector(
				maximumRefusalBodyBytes,
				'truncate'
			);

			// `ws` transfers ownership of the refused handshake to this listener.
			// Destroy the response to release an unfinished body and close the socket
			// to release the connection. Otherwise repeated refusals would retain one
			// referenced connection each.
			//
			// Retryable statuses enter the normal reconnect path, including any
			// `Retry-After` delay. Other statuses fail the session.
			const refuse = (minimumDelayMs: number | undefined): void => {
				response.destroy();
				connection.close();

				// Reading the body can outlive this connection, for example when a
				// capacity timeout abandons the handshake. Ignore stale refusals so they
				// cannot fail a session that has already installed another connection.
				if (hasDropped || !isCurrent()) {
					return;
				}

				clearRefusalDrain();

				const status = response.statusCode ?? 0;
				const refusal = new CupboardHttpError(
					'GET',
					options.path,
					status,
					body.text()
				);

				if (isRetryableRefusal(status)) {
					// Retain the latest refusal for a capacity timeout diagnostic. Any
					// subsequent server progress clears it as stale.
					lastRefusal = refusal;
					dropOnce(0, refusal, { kind: 'refusal', minimumDelayMs });

					return;
				}

				if (status === 401) {
					hasDropped = true;
					refreshAndOpenConnection(refusal);

					return;
				}

				failSession(refusal);
			};

			// A peer can leave the body unfinished in the ways `refusalDrainMs`
			// describes without producing another event on this connection. Bound
			// the read and report the refusal from the bytes received before the
			// deadline. The complete headers retain `Retry-After` even when the body
			// is incomplete.
			//
			// Keep this timer referenced because it is the only event guaranteed to
			// resolve an unfinished refusal body.
			refusalDrainTimer = setTimeout(() => {
				refuse(requestedRetryDelayMs(response));
			}, refusalDrainMs);

			response.on('data', (chunk) => {
				if (!body.append(chunk)) {
					refuse(requestedRetryDelayMs(response));
				}
			});
			response.on('end', () => {
				refuse(requestedRetryDelayMs(response));
			});
		});
	}

	if (options.signal?.aborted === true) {
		onAbort();
	} else {
		options.signal?.addEventListener('abort', onAbort, { once: true });
		openConnection(connectionAttempt);
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

		// An idle server close leaves the session dormant. Open a new connection
		// before replaying this commit.
		if (isDormant) {
			openDormantConnection();
		}

		return new Promise<CommitOutcome>((resolveAck, rejectAck) => {
			const { settled, settleServable, settleFailed } = deferredSettle();
			// Observe `settled` immediately because a `--no-wait` caller may never await
			// it, and the acknowledgement itself may never arrive.
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
			unackedEntries += 1;

			// An open socket uses the coalescing queue. Before the first open or during
			// reconnect, `replayOutstanding` sends the entry after connection. Start
			// the capacity clock now because a connection might never open.
			if (isOpened) {
				enqueueSend(target);
			} else {
				updateCapacityWait();
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

function asError(value: unknown): Error {
	return value instanceof Error ? value : new TokenProviderError(value);
}

// Exponential back-off with full jitter, capped.
function reconnectDelay(attempt: number, base: number): number {
	const ceiling = Math.min(base * 2 ** (attempt - 1), maxReconnectBackoffMs);

	return Math.random() * ceiling;
}

/**
 * Returns whether a later upgrade attempt can reasonably succeed. Gateways and
 * the Worker can return transient 5xx responses during deployment, overload, or
 * origin failure. Rate limiting is also transient. Other 4xx responses describe
 * the request and remain terminal across retries.
 *
 * This set is wider than {@link retryableErrorStatuses}, which covers frames
 * written by the Worker after a successful upgrade.
 */
function isRetryableRefusal(status: number): boolean {
	return status === 429 || status >= 500;
}

/**
 * The wait a refused upgrade asked for in `Retry-After`, in milliseconds and
 * capped at {@link maxRetryAfterMs}. Invalid values return `undefined` and the
 * back-off decides the delay on its own.
 */
function requestedRetryDelayMs(failure: UpgradeFailure): number | undefined {
	const stated = failure.headers['retry-after'];
	const delay = retryAfterDelayMs(Array.isArray(stated) ? stated[0] : stated);

	return delay === undefined ? undefined : Math.min(delay, maxRetryAfterMs);
}

function safeJsonParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}
