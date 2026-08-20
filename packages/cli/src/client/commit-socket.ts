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
A received frame or body chunk; `ws` hands these over as `Buffer`s.
*/
export interface CommitSocketData {
	toString(): string;
}

/**
 * The HTTP response a refused upgrade carries (a `ws` `IncomingMessage`). `ws`
 * hands a refused connection to the listener and does nothing further with it,
 * so the session closes it through `destroy` once it has read the refusal.
 */
export interface UpgradeFailure {
	readonly statusCode?: number;
	readonly headers: Readonly<Record<string, string | string[] | undefined>>;
	on(event: 'data', listener: (chunk: CommitSocketData) => void): unknown;
	on(event: 'end', listener: () => void): unknown;
	destroy(): void;
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

/**
Opens a commit WebSocket carrying the bearer token on the upgrade request.
*/
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
 * A path to commit over the session, with the identity from negotiation. Set
 * `retention` when the upload negotiated a retention plan: on a reconnect the
 * server resolves a row it has already cleared by that identity, and the marker
 * makes it answer with the path's stored grace fact instead of none.
 */
export interface CommitSessionTarget {
	readonly uploadId: UploadId;
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
	/**
	The route path the socket was opened on, for error messages.
	*/
	readonly path: string;
	/**
	Bounds how long a deferred upload's `settled` waits for its verdict.
	*/
	readonly timeoutSeconds: number;
	readonly signal?: AbortSignal;
	readonly keepaliveMs?: number;
	/**
	How many times a dropped socket is re-established before the push fails.
	*/
	readonly maxReconnects?: number;
	/**
	Base back-off before the first reconnect; doubles, jittered, then capped.
	*/
	readonly reconnectBackoffMs?: number;
	/**
	 * Called on each connection with the capabilities the server advertised in
	 * the 101 response. Useful for logging the negotiated mode.
	 */
	readonly onCapabilities?: (capabilities: AdvertisedCapabilities) => void;
	/**
	 * Called when the session starts waiting for the server to grant it capacity
	 * to commit under, and again when it stops. It reports the fact only: the
	 * server's queue moves as soon as any entry settles anywhere, so there is no
	 * position or estimate to report and none is passed.
	 */
	readonly onWaiting?: (isWaitingForCapacity: boolean) => void;
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
	// the negotiation sent a retention plan: a deadline for a path whose verdict
	// has arrived, the captured grace for one still pending.
	readonly grace?: ParsedUploadGraceFact;
	// The grace fact of the terminal frame, readable once `settled` resolves: a
	// deferred path's deadline arrives with its verdict, not its ack.
	readonly verdictGrace?: () => ParsedUploadGraceFact | undefined;
}

/**
A push's commit session: many paths commit over one socket.
*/
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
	// The grace fact of the last `settled` or `verdict` frame, exposed through
	// the outcome's `verdictGrace` once the entry has its verdict.
	verdictGrace?: ParsedUploadGraceFact;
}

/**
 * Why a connection ended, for the parts of the drop path that treat a server
 * refusing the upgrade differently from a connection that failed. A refusal
 * carries the wait the server asked for before the next dial, when it sent one
 * the client could read.
 */
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

// The longest delay a timer can hold. A runtime truncates anything longer to a
// millisecond, so a deadline past this is armed in instalments, each measuring
// what is left afresh.
const maxTimerDelayMs = 2 ** 31 - 1;

// Status codes that indicate a transient server overload: a short per-entry
// backoff and re-send may succeed where an immediate retry would not. An error
// frame is written by the tenant's own object, which reports every transient
// condition of its own as one of these two.
const retryableErrorStatuses = new Set([429, 503]);

// The longest wait a refused upgrade can ask of the session before it dials
// again. A server sends `Retry-After` to ask for a longer gap than the
// back-off would take, so a cap much above the five-second back-off ceiling is
// needed for the header to mean anything; a minute keeps a nonsense value from
// spending the session's whole capacity deadline on one gap.
const maxRetryAfterMs = 60_000;

// How long the session reads a refusal body before it gives up on the response.
// A refusal body is a short message already on its way, so five seconds is far
// longer than a working peer needs. It bounds the two cases that produce no
// further event: a body truncated and then half-closed, and headers whose
// stated length never arrives. Either would otherwise leave the session waiting
// on a connection nothing will speak on again.
const refusalDrainMs = 5000;
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
	'unsupported',
	'credit',
	'queued'
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

// The credit this connection opens with, or `undefined` when the 101 carried no
// `commit-credit` token. A token with no readable grant opens at zero, which
// costs one `request-credit` round trip and nothing else.
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

// Whether these upgrade request headers declare `commit-credit`. The server
// decides to pace a session from this declaration alone and closes it for
// overdrawing, so a session that declares the token has to pace itself even
// when the 101 comes back without it: an intermediary that answers the upgrade
// itself can drop the response header.
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
	credentials: CommitSocketCredentials,
	options: CommitSessionOptions
): CommitSession {
	const outstanding = new Map<UploadId, SessionEntry>();
	const maxReconnects = options.maxReconnects ?? defaultMaxReconnects;
	const backoffBase = options.reconnectBackoffMs ?? defaultReconnectBackoffMs;
	const isCreditDeclared = isCommitCreditDeclared(credentials.initial.headers);

	let socket: CommitSocket | undefined;
	// Counts the connections this session has opened, so each connection's
	// handlers can tell whether they are still the current one.
	let connectionGeneration = 0;
	let isOpened = false;
	let isClosed = false;
	// The server closes a socket it has heard nothing on for a long time. With
	// nothing outstanding that costs the session nothing, so it goes dormant
	// rather than closed and the next commit opens a fresh connection.
	let isDormant = false;
	let failure: Error | undefined;
	let keepalive: NodeJS.Timeout | undefined;
	let reconnectTimer: NodeJS.Timeout | undefined;
	let isAuthorising = false;
	let connectionAttempt = credentials.initial;
	// Bounds how long the body of a refused upgrade is read. It is held here
	// rather than in the handler that arms it so that a session which is torn
	// down, or which has moved to another connection, can clear it.
	let refusalDrainTimer: NodeJS.Timeout | undefined;
	// The clock time before which the session does not dial again, set when a
	// server refuses an upgrade and asks for a wait. It outlives a dormancy,
	// since the dial it applies to is usually the one the next commit makes.
	let earliestDialAt = 0;
	let reconnectsLeft = maxReconnects;
	// Reconnects since the server last answered an entry. The back-off is drawn
	// from this rather than from `reconnectsLeft`, so a reconnect that spends no
	// budget still backs off further than the one before it.
	let reconnectAttempt = 0;
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
	// only when the connection supports it, so that after a reconnect the server
	// answers with the path's stored grace fact rather than none.
	let hasBatchRetentionMarker = false;
	let hasIdentityRetentionMarker = false;
	// The entries this connection may still send, and the demand it last
	// declared. Both are per connection: a fresh 101 carries a fresh grant, and
	// the server keeps no demand for a session that has gone. `undefined` credit
	// means the server did not advertise `commit-credit` and does not pace this
	// session, which leaves the window above in charge.
	let creditAvailable: number | undefined;
	let declaredDemand = 0;
	// Whether this session is paced by credit. It starts from the client's own
	// declaration, for the same reason the missing-token fallback does: the
	// server pins pacing to that declaration, so the client must not wait for a
	// 101 to agree. A session that cannot reach the cache at all therefore still
	// has a capacity clock. Only a server that rejects `request-credit` takes the
	// session off credit, and only for the connection that rejected it.
	let isCreditPaced = isCreditDeclared;
	// Entries the caller has committed that the server has not acknowledged with
	// a durable row. An acked entry is bounded by its own verdict deadline
	// instead. Kept as a count because the capacity wait consults it on every
	// frame.
	let unackedEntries = 0;

	// The wait the capacity timeout measures, and the sum of every wait the
	// session has had. See {@link isWaitingForCapacity}.
	let accruedWaitMs = 0;
	let totalWaitedMs = 0;
	let waitingSince: number | undefined;
	let capacityTimer: NodeJS.Timeout | undefined;
	let isWaitingReported = false;
	// The rotation count the server last reported, carried into the timeout's
	// cause as a diagnostic and read for nothing else.
	let lastAhead: number | undefined;
	// The last upgrade refusal the session was given and went on dialling
	// through. A wait that expires having only met refusals reports this one, so
	// the status and body reach the operator rather than a wait time on its own.
	// It belongs to the wait it was met during, so it is cleared by progress of
	// any kind, in `noteCapacityProgress`, and by the ends of that wait: the
	// expiry that has just reported it, and a dormancy, which leaves the session
	// with nothing outstanding to wait for.
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

	// The targets this connection has not sent yet for want of credit. Cleared on
	// reconnect, since `replayOutstanding` re-queues everything outstanding.
	let queuedTargets: CommitSessionTarget[] = [];

	// The entries this connection has sent that the server has not answered. An
	// entry leaves on its first frame, `deferred` included, because that is when
	// the server returns its credit. Cleared on reconnect, since the replay sends
	// everything outstanding again.
	const inFlightEntries = new Set<UploadId>();

	// Removes a target whose entry has already finished. A retry re-queues an
	// entry, and its verdict can arrive while it waits there; without this the
	// queue would go on counting it as a path waiting for capacity.
	const removeQueuedTarget = (uploadId: UploadId): void => {
		const index = queuedTargets.findIndex(
			(target) => target.uploadId === uploadId
		);

		if (index === -1) {
			return;
		}

		queuedTargets.splice(index, 1);
	};

	// Whether the session is waiting for capacity: a paced session holding work
	// the cache has not let it send, with nothing sent that the cache still owes
	// an answer for.
	//
	// This deliberately ignores the state of the connection. The cache makes
	// no progress for the session whether it is refusing credit, dropping the
	// socket or refusing the dial, so the deadline stays armed through a
	// disconnection and a partition ends at the budget like any other wait
	// without progress. It
	// reads `outstanding` rather than the queue for the same reason: the queue
	// belongs to a connection, and a reconnect empties it.
	//
	// The deadline measures one unbroken wait. A grant or an answered entry
	// starts it again from zero. `accruedWaitMs` holds the wait still running and
	// `totalWaitedMs` sums every wait the session has had.
	const isWaitingForCapacity = (): boolean =>
		!isClosed &&
		isCreditPaced &&
		unackedEntries > 0 &&
		inFlightEntries.size === 0;

	// Adds the wait still running to both counters and returns the wait so far.
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

	// How long the session has waited, including the part still running.
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

	// Fails the work the cache never let the session send, once the wait reaches
	// the budget. This can fire while the session is disconnected, so it rejects
	// from `outstanding` rather than from the queue a reconnect has emptied. An
	// entry parked on its verdict is left alone: the server holds a durable row
	// for it, and its own deadline bounds it.
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

		// With nothing left outstanding there is nothing to reconnect for, and
		// the pending reconnect goes with the session, so a run that gave up
		// during a partition stops holding the process open.
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

	// Starts, stops and reports the capacity wait as the session's work and
	// credit change. Called after anything that can alter either.
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

	// Sends as much of the queue as the session holds credit for, in messages of
	// at most the connection's batch size.
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
			// A queued target whose entry has since finished names a row the
			// server has already answered, and re-sending it would spend credit
			// on a commit for an upload the session no longer holds. Only the
			// survivors are sent, and only they are paid for.
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

	// Sends a set of commits in the shape this connection speaks: one
	// `commit-batch` op per bounded chunk when the server offered it, a per-id
	// `commit` op each otherwise. A server that paces the session takes what its
	// grant covers and the rest waits in the queue.
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
		// The session is closed, so a wait it was reporting has ended and the
		// caller is told so here. Whether capacity arrived or the session gave
		// up is carried by each path's outcome, not by this call.
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

	// Closes the connection but keeps the session's entries. The server holds a
	// session's declared demand and its granted credit in the socket alone, so
	// closing returns both to the tenant. The session sends nothing until a
	// connection is up again, opened either by the drop path's reconnect or by
	// the next commit.
	const abandonConnection = (): void => {
		clearKeepalive();
		isOpened = false;
		creditAvailable = undefined;
		declaredDemand = 0;
		inFlightEntries.clear();
		socket?.close();
	};

	// Closes the connection with nothing left outstanding on it. No reconnect
	// follows; the next commit opens a connection and negotiates again.
	const goDormant = (): void => {
		clearReconnectTimer();
		isDormant = true;
		lastRefusal = undefined;
		abandonConnection();
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

		const frame = parsed.data;

		// Any frame naming an upload counts as an ack for that chunk's window
		// slot, releasing the next queued batch chunk (the ANY-frame rule).
		if ('uploadId' in frame) {
			releaseChunkForUploadId(frame.uploadId);
		}

		// Only the first answer to an entry the session still holds restores the
		// reconnect budget. A repeated `deferred` frame does not, because the
		// replay asks for one on every reconnect, and a cache that accepts an
		// entry, repeats its answer and dies would be reconnected to for ever.
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
				// A frame for an id the session no longer holds returns no credit,
				// so it must not reach `noteCapacityProgress` below.
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

				// A reconnect resubscribes every parked entry and the server answers
				// each with a fresh `deferred` frame, so only the first one for an
				// entry returns credit.
				const isFirstDeferral = !entry.acked;

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

					// The error frame is this entry's first answer, so it leaves the
					// set even though the retry will queue the target again.
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

				// The grant covers entries this session may now send. The server
				// decremented the demand it holds for this session by the same
				// amount, so the client's own record follows it and a queue that is
				// still longer declares the remainder on the next drain.
				creditAvailable = (creditAvailable ?? 0) + frame.grant;
				declaredDemand = Math.max(0, declaredDemand - frame.grant);
				drainCredit();

				return;
			}

			case 'queued': {
				// The server has no capacity to grant yet. The count goes into the
				// timeout's cause and nothing reads it otherwise. The wait is
				// already running, since the session had a queue and no credit
				// before it asked.
				lastAhead = frame.ahead;

				return;
			}

			case 'unsupported': {
				// `request-credit` is the one op the session sends on its own
				// declaration rather than on something the server advertised, so a
				// server that does not know it is simply older. Such a server does
				// not pace the session at all, so the session falls back to its own
				// window of in-flight messages and sends the queue through that.
				if (frame.op === 'request-credit') {
					const queued = queuedTargets;
					queuedTargets = [];
					creditAvailable = undefined;
					isCreditPaced = false;
					declaredDemand = 0;
					// The credited wait ends with the pacing: what the session
					// waited for is not coming from this server, and a later
					// connection that paces it again measures its own wait.
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

	// Reopens after a back-off. This timer only exists while entries are
	// outstanding, and between the drop and the reopen it can be the process's
	// only handle: the session's other timers are unref'd and no socket exists.
	// Unref it and a run whose remaining work all waits on this session exits
	// with its awaits unsettled instead of reconnecting.
	//
	// A wait the server asked for never shortens the back-off the attempt count
	// has reached, so a session that keeps failing still dials less often the
	// longer it fails.
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

	// Opens the connection a commit needs when the session is dormant. A server
	// that refused the last dial and asked for a wait is given it, since a
	// dormant session dials the moment a commit arrives and the timing of that
	// commit is the caller's, not the server's.
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

	// A drop is treated as transient: reconnect and replay, so a network blip
	// does not lose the whole push. Code 1002 means the server rejected the
	// request deliberately, which reconnecting cannot fix. An upgrade refused
	// with a retryable status arrives here too, since a cache that refuses this
	// dial may still accept the next one.
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

		// Every route out of this drop honours the wait a refusal asked for: the
		// reconnect scheduled below takes it directly, and recording it here
		// carries it to a dial that comes some other way. An expiring capacity
		// wait cancels a pending reconnect and leaves the session dormant, and
		// the dial the next commit makes is then the one that owes the server
		// the rest of its wait.
		if (cause.kind === 'refusal') {
			earliestDialAt = Math.max(earliestDialAt, Date.now() + minimumDelayMs);
		}

		// Whether the connection died owing the session an answer. That is the one
		// state a drop is evidence about: the cache had taken an entry and was to
		// answer it. Read before the set below is cleared, so a dial that fails
		// before it opens is classified by the state that survived it.
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

		// The server closes a socket once nothing is outstanding on it, which is
		// what its idle close does to a session whose push has gone quiet.
		// Nothing was lost, so the session stays usable and the next commit opens
		// a fresh connection, renegotiating its capabilities and its grant. A
		// caller that is finished closes the session itself, which takes the
		// branch above.
		if (outstanding.size === 0) {
			isDormant = true;
			creditAvailable = undefined;
			reconnectsLeft = maxReconnects;
			lastRefusal = undefined;

			// The back-off reached so far outlives a dormancy a refusal caused,
			// since the server declined to serve this session and the next dial
			// is the same session asking again. An idle close is the server
			// saying the opposite: it took this session and closed it only
			// because it had gone quiet, and it will take the next connection
			// whenever one comes, so that dial starts afresh.
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

		// A paced session that was owed no answer reconnects for free, because the
		// clock that owns the work it left behind bounds it: the capacity deadline
		// for entries the cache has not taken, and each parked entry's verdict
		// deadline for the ones it has, both of which run through a
		// disconnection. Spending the budget there would fail work the server
		// holds durably, over a link that is merely flaky.
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

	// Fails a deferred entry whose verdict never arrives. A budget longer than a
	// timer can hold is armed in instalments, each measuring what is left of it,
	// and only the last one fails the entry.
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
		// This connection supersedes any the drop path still has pending, so a
		// timer left armed must not open a second one behind it. A refusal still
		// being read belongs to the connection this one replaces, and `refuse`
		// ignores a refusal that old, so its drain has nothing left to decide.
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
		// Credit belongs to the connection the server granted it on, and the
		// server holds no demand for a session that has gone. The wait already
		// spent is not reset here: it is the session's, not the connection's.
		creditAvailable = undefined;
		declaredDemand = 0;
		queuedTargets = [];
		inFlightEntries.clear();
		// Captured per connection, so `onCapabilities` reports the negotiation of
		// the connection whose `open` fired.
		let connectionCaps: AdvertisedCapabilities = new Map();
		// The capacity this connection's 101 offered. A dial that never opens
		// leaves it unread, which is what keeps an offer from counting as
		// progress.
		let openingGrant = 0;
		// Named as well as stored, so a handler that outlives this connection
		// acts on the connection it belongs to rather than on the session's
		// current one.
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
			// A session that declared credit is paced whether or not the grant
			// token survived the hop back, so an unreadable offer opens at zero
			// and the first `request-credit` asks for what the queue needs.
			creditAvailable =
				resolvedOpeningGrant(connectionCaps) ??
				(isCreditDeclared ? 0 : undefined);
			// Each connection negotiates for itself, so a session an older server
			// took off credit is back on it for the next one.
			isCreditPaced = creditAvailable !== undefined;
			openingGrant = creditAvailable ?? 0;
		});

		connection.on('open', () => {
			if (!isCurrent()) {
				return;
			}

			isOpened = true;
			options.onCapabilities?.(connectionCaps);

			// Capacity the session can now spend is progress, the same as a
			// `credit` frame is, so the wait this connection opened during ends
			// here and the next one runs a whole budget. An offer on a 101 whose
			// handshake the client then rejects never reaches this line, which is
			// why the reset lives here rather than beside the header it was read
			// from. A cache that takes the session and grants it nothing has made
			// no progress for it, so its wait carries on.
			//
			// This runs before the replay, which sends what the grant covers and
			// re-arms the deadline for whatever is still queued. After it, the
			// reset would clear the deadline the replay had just armed and
			// nothing would arm another until the next frame.
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

			const chunks: string[] = [];

			// Ends the refusal, reclaiming the connection and then deciding what
			// the session does next.
			//
			// `ws` hands the connection to this listener and abandons it there,
			// still in its handshake, so the session is what gives it back:
			// destroying the response releases a body still being read, and
			// closing the socket ends the connection itself. Destroying alone
			// leaves a read that finished holding an open connection, and a
			// session dialling against a busy cache for minutes would then hold
			// one per refusal, each a ref'd handle that keeps a finished run
			// from exiting.
			//
			// The server refuses an upgrade with a retryable status when it is
			// loaded or has just reset, and this session dials often enough to
			// meet one: after a drop, after going dormant, and after its idle
			// close. So a retryable refusal goes through the drop path, where the
			// session's own bounds decide how long it keeps trying. A refusal
			// that asks for a delay in `Retry-After` also holds the next dial
			// back at least that long. Any other status is a refusal of this
			// request rather than of its timing.
			const refuse = (minimumDelayMs: number | undefined): void => {
				response.destroy();
				connection.close();

				// The body can take long enough that the session has left the
				// connection this refusal condemns by the time it is read: a
				// capacity wait that expires abandons a connection mid-handshake,
				// and the session reconnects and carries on. Acting on the refusal
				// then would end a session over a dial it has already replaced,
				// whatever the status said. The drain is cleared below rather
				// than here, because by this point the timer can belong to the
				// connection the session moved to.
				if (hasDropped || !isCurrent()) {
					return;
				}

				clearRefusalDrain();

				const status = response.statusCode ?? 0;
				const refusal = new CupboardHttpError(
					'GET',
					options.path,
					status,
					chunks.join('')
				);

				if (isRetryableRefusal(status)) {
					// Kept so that a wait which only ever meets refusals fails
					// naming this one. A cache that goes on to make progress for the
					// session clears it, so the refusal reported is always one the
					// session was still being given when it gave up.
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
			// describes, none of which produce another event on this connection,
			// so the read is bounded. The status arrived with the headers, so the
			// refusal is answered on what was received. A `Retry-After` on a
			// response whose body never finished is not honoured, and the
			// back-off decides the next dial.
			//
			// This timer is not unref'd, since until it fires nothing else will
			// move the session on.
			refusalDrainTimer = setTimeout(() => {
				refuse(undefined);
			}, refusalDrainMs);

			response.on('data', (chunk) => {
				chunks.push(chunk.toString());
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

		// A dormant session was closed by the server with nothing outstanding, so
		// this commit opens a fresh connection and `replayOutstanding` sends it
		// once that connection is up. The caller's `close` runs first if it came
		// first, since it sets `isClosed` and the guard above rejects.
		if (isDormant) {
			openDormantConnection();
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
			unackedEntries += 1;

			// An open socket enqueues onto the coalescing flush; before the first
			// open (or mid-reconnect) the op waits and `replayOutstanding` sends it
			// when the socket comes up. Nothing will carry it until then, so the
			// capacity clock starts here rather than on a connection this session
			// may never get.
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

// Exponential back-off with full jitter, capped. The jittered delay never
// exceeds the cap, so a test can fire any pending reconnect by advancing a fake
// clock past `maxReconnectBackoffMs`.
function reconnectDelay(attempt: number, base: number): number {
	const ceiling = Math.min(base * 2 ** (attempt - 1), maxReconnectBackoffMs);

	return ceiling / 2 + Math.random() * (ceiling / 2);
}

/**
 * Whether a refused upgrade refuses the timing of this dial rather than the
 * request itself. An upgrade is answered by whatever stands in front of the
 * Worker, so the gateway conditions an edge reports (a 502 during a redeploy, a
 * 504 on an origin timeout, Cloudflare's own 52x pages) belong here beside the
 * server's own overload statuses, and every other 5xx is a fault the next dial
 * may well not meet. Below 500 only a rate limit passes: an authorisation or
 * routing failure reads the same however often the session dials.
 *
 * This is wider than {@link retryableErrorStatuses}, which answers the same
 * question for a frame the server itself wrote.
 */
function isRetryableRefusal(status: number): boolean {
	return status === 429 || status >= 500;
}

/**
 * The wait a refused upgrade asked for in `Retry-After`, in milliseconds and
 * capped at {@link maxRetryAfterMs}. Only the delay-seconds form is read. For
 * an HTTP date, or a value that is not a positive number of seconds, this
 * returns `undefined` and the back-off decides the delay on its own.
 */
function requestedRetryDelayMs(failure: UpgradeFailure): number | undefined {
	const stated = failure.headers['retry-after'];
	const seconds = Number(Array.isArray(stated) ? stated[0] : stated);

	if (!Number.isFinite(seconds) || seconds <= 0) {
		return;
	}

	return Math.min(seconds * 1000, maxRetryAfterMs);
}

function safeJsonParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}
