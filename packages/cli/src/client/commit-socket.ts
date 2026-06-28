import {
	type CommitResponse,
	commitSessionFrameSchema,
	type CommitSessionRequest
} from '@cupboard/protocol/upload';

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
 * The client half of a commit WebSocket. Structurally a subset of `ws`'s
 * `WebSocket`, so the real client and test fakes plug in alike.
 */
export interface CommitSocket {
	on(event: 'open', listener: () => void): unknown;
	on(event: 'message', listener: (data: CommitSocketData) => void): unknown;
	on(event: 'close', listener: (code: number) => void): unknown;
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

/** A path to commit over the session, with the identity from negotiation. */
export interface CommitSessionTarget {
	readonly uploadId: string;
	readonly storePathHash: string;
	readonly narHash: string;
}

export interface CommitSessionOptions {
	/** The route path the socket was opened on, for error messages. */
	readonly path: string;
	/** Park for the verification verdict on a deferred upload. */
	readonly wait: boolean;
	/** Bounds how long a parked upload waits for its verdict. */
	readonly timeoutSeconds: number;
	readonly signal?: AbortSignal;
	readonly keepaliveMs?: number;
	/** How many times a dropped socket is re-established before the push fails. */
	readonly maxReconnects?: number;
	/** Base back-off before the first reconnect; doubles, jittered, then capped. */
	readonly reconnectBackoffMs?: number;
}

/** A push's commit session: many paths commit over one socket. */
export interface CommitSession {
	commit(target: CommitSessionTarget): Promise<CommitResponse>;
	/** Closes the socket; safe once every commit has settled. */
	close(): void;
}

interface SessionEntry {
	readonly target: CommitSessionTarget;
	readonly resolve: (response: CommitResponse) => void;
	readonly reject: (error: Error) => void;
	// A `deferred` frame has arrived, so the server holds a durable row for this
	// upload. A reconnect resumes such an id with `subscribe`, where a since-gone
	// row safely means it committed; an un-acked id is re-sent as `commit`
	// instead, since its op may never have reached the server.
	acked: boolean;
	deadline?: NodeJS.Timeout;
}

const defaultKeepaliveMs = 30_000;
const defaultMaxReconnects = 5;
const defaultReconnectBackoffMs = 500;
const maxReconnectBackoffMs = 5000;
const keepaliveRequest = 'ping';
const keepaliveResponse = 'pong';

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
 * costs at most a brief pause rather than every in-flight commit.
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

	const sendNow = (request: CommitSessionRequest): void => {
		socket?.send(JSON.stringify(request));
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
			entry.reject(error);
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

		outstanding.delete(uploadId);
		settle(entry);
	};

	const onFrame = (text: string): void => {
		const parsed = commitSessionFrameSchema.safeParse(safeJsonParse(text));

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

		switch (frame.ev) {
			case 'settled': {
				finishEntry(frame.uploadId, (entry) => {
					entry.resolve(frame.response);
				});

				return;
			}

			case 'deferred': {
				const entry = outstanding.get(frame.uploadId);

				if (entry === undefined) {
					return;
				}

				if (!options.wait) {
					finishEntry(frame.uploadId, () => {
						entry.resolve({
							storePathHash: frame.storePathHash,
							narHash: frame.narHash,
							status: 'pending'
						});
					});

					return;
				}

				entry.acked = true;
				entry.deadline ??= armDeadline(frame.uploadId);

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
					finishEntry(frame.uploadId, () => {
						entry.resolve({
							storePathHash: entry.target.storePathHash,
							narHash: entry.target.narHash,
							status: 'committed'
						});
					});

					return;
				}

				const status = frame.status;
				finishEntry(frame.uploadId, () => {
					entry.reject(
						new UploadVerificationFailedError(frame.uploadId, status)
					);
				});

				return;
			}

			case 'error': {
				const { status, message } = frame;
				finishEntry(frame.uploadId, (entry) => {
					entry.reject(
						new CupboardHttpError('GET', options.path, status, message)
					);
				});
			}
		}
	};

	// On every open (the first connect and each reconnect), drive the outstanding
	// work onto the fresh socket: an acked id resumes with `subscribe`, an un-acked
	// id is re-sent as `commit`. On the first open this is just a `commit` per
	// registered path.
	const replayOutstanding = (): void => {
		const ackedIds: string[] = [];

		for (const [uploadId, entry] of outstanding) {
			if (entry.acked) {
				ackedIds.push(uploadId);
				continue;
			}

			sendNow({ op: 'commit', uploadId });
		}

		if (ackedIds.length > 0) {
			sendNow({ op: 'subscribe', uploadIds: ackedIds });
		}
	};

	// A drop on an established socket is treated as transient: reconnect and
	// replay rather than fail, so a network blip does not lose the whole push. A
	// refused upgrade is handled separately, as it will not heal on retry.
	const onDrop = (error: Error): void => {
		if (isClosed) {
			return;
		}

		isOpened = false;
		clearKeepalive();

		// The server closes the socket once nothing is outstanding; that is a clean
		// end, not a drop to recover from.
		if (outstanding.size === 0) {
			teardown();

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
				entry.reject(new UploadWaitTimeoutError(1, options.timeoutSeconds));
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
		socket = connect(url, headers);

		socket.on('open', () => {
			isOpened = true;
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

		socket.on('close', () => {
			onDrop(
				new CommitSocketProtocolError(
					options.path,
					'the socket closed before every commit settled'
				)
			);
		});

		socket.on('error', (error) => {
			onDrop(error);
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

	const commit = (target: CommitSessionTarget): Promise<CommitResponse> => {
		if (failure !== undefined) {
			return Promise.reject(failure);
		}

		if (isClosed) {
			return Promise.reject(
				new CommitSocketProtocolError(options.path, 'the session is closed')
			);
		}

		return new Promise<CommitResponse>((resolve, reject) => {
			outstanding.set(target.uploadId, {
				target,
				resolve,
				reject,
				acked: false
			});

			// An open socket sends now; before the first open (or mid-reconnect) the
			// op waits and `replayOutstanding` sends it when the socket comes up.
			if (isOpened) {
				sendNow({ op: 'commit', uploadId: target.uploadId });
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
