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
	deadline?: NodeJS.Timeout;
}

const defaultKeepaliveMs = 30_000;
const keepaliveRequest = 'ping';
const keepaliveResponse = 'pong';

/**
 * Runs a push's commit session over one socket. Each `commit` registers a path,
 * sends a `commit` op, and resolves when the path's per-id frame settles it: a
 * settled or already-present reply straight away, a `deferred` upload's verdict
 * once verification answers (or `pending` when `wait` is off). A frame names its
 * upload, so many commits multiplex over the one connection. The server answers
 * the keepalive pings without waking the Durable Object, so a long park
 * survives idle timeouts.
 */
export function runCommitSession(
	connect: CommitSocketConnect,
	url: URL,
	headers: Readonly<Record<string, string>>,
	options: CommitSessionOptions
): CommitSession {
	const outstanding = new Map<string, SessionEntry>();
	const socket = connect(url, headers);
	let isOpened = false;
	let isClosed = false;
	let failure: Error | undefined;
	let keepalive: NodeJS.Timeout | undefined;

	// A commit op queued before the upgrade completes; `ws` rejects a send on a
	// socket that has not opened, so ops wait here until the open handler flushes.
	const outbox: CommitSessionRequest[] = [];

	const send = (request: CommitSessionRequest): void => {
		if (!isOpened) {
			outbox.push(request);

			return;
		}

		socket.send(JSON.stringify(request));
	};

	const teardown = (): void => {
		if (keepalive !== undefined) {
			clearInterval(keepalive);
			keepalive = undefined;
		}

		for (const entry of outstanding.values()) {
			if (entry.deadline !== undefined) {
				clearTimeout(entry.deadline);
			}
		}

		options.signal?.removeEventListener('abort', onAbort);
		socket.close();
	};

	// A connection-wide failure (a drop, an abort, a bad frame, a refused
	// upgrade) ends the whole session: every outstanding commit rejects, since
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
		// already settled); ignore it.
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

	socket.on('open', () => {
		isOpened = true;

		for (const request of outbox) {
			socket.send(JSON.stringify(request));
		}
		outbox.length = 0;

		keepalive = setInterval(() => {
			socket.send(keepaliveRequest);
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
		if (outstanding.size > 0) {
			failSession(
				new CommitSocketProtocolError(
					options.path,
					'the socket closed before every commit settled'
				)
			);
		}
	});

	socket.on('error', (error) => {
		failSession(error);
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

	if (options.signal?.aborted === true) {
		onAbort();
	} else {
		options.signal?.addEventListener('abort', onAbort, { once: true });
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
			outstanding.set(target.uploadId, { target, resolve, reject });
			send({ op: 'commit', uploadId: target.uploadId });
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

function safeJsonParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}
