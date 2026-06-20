import {
	type CommitResponse,
	commitSocketFrameSchema
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

export interface CommitSettleOptions {
	/** The route path the socket was opened on, for error messages. */
	readonly path: string;
	readonly uploadId: string;
	// The upload's identity from negotiation. The server binds the same metadata
	// to this uploadId, so it matches the deferred frame's values; it lets the
	// client settle a verdict that races ahead of the deferred frame, where the
	// server never sent the identity.
	readonly storePathHash: string;
	readonly narHash: string;
	/** Park for the verification verdict on a deferred upload. */
	readonly wait: boolean;
	/** Bounds how long a parked upload waits for its verdict. */
	readonly timeoutSeconds: number;
	readonly signal?: AbortSignal;
	readonly keepaliveMs?: number;
}

const defaultKeepaliveMs = 30_000;
const keepaliveRequest = 'ping';
const keepaliveResponse = 'pong';

/**
 * Drives a commit conversation to its `CommitResponse`. The first frame either
 * settles the path or reports it deferred; a deferred upload parks on the
 * socket for the verification verdict (or returns `pending` straight away when
 * `wait` is off). The server answers the periodic keepalive pings without
 * waking the Durable Object, so a long park survives idle timeouts.
 */
export function settleCommitSocket(
	socket: CommitSocket,
	options: CommitSettleOptions
): Promise<CommitResponse> {
	return new Promise<CommitResponse>((resolve, reject) => {
		let isDone = false;
		let deferred: undefined | { storePathHash: string; narHash: string };
		let keepalive: NodeJS.Timeout | undefined;
		let deadline: NodeJS.Timeout | undefined;

		const onAbort = (): void => {
			if (options.signal !== undefined) {
				fail(abortReason(options.signal));
			}
		};

		const finish = (settle: () => void): void => {
			if (isDone) {
				return;
			}

			isDone = true;
			clearInterval(keepalive);
			clearTimeout(deadline);
			options.signal?.removeEventListener('abort', onAbort);
			socket.close();
			settle();
		};

		const succeed = (response: CommitResponse): void => {
			finish(() => {
				resolve(response);
			});
		};

		const fail = (error: Error): void => {
			finish(() => {
				reject(error);
			});
		};

		const protocolError = (detail: string): void => {
			fail(new CommitSocketProtocolError(options.path, detail));
		};

		const onFrame = (text: string): void => {
			let payload: unknown;

			try {
				payload = JSON.parse(text);
			} catch {
				protocolError(`unexpected frame: ${text}`);

				return;
			}

			const frame = commitSocketFrameSchema.safeParse(payload);

			if (!frame.success) {
				protocolError(`unexpected frame: ${text}`);

				return;
			}

			switch (frame.data.event) {
				case 'result': {
					succeed(frame.data.response);

					return;
				}

				case 'deferred': {
					const { storePathHash, narHash } = frame.data;

					if (!options.wait) {
						succeed({ storePathHash, narHash, status: 'pending' });

						return;
					}

					deferred = { storePathHash, narHash };
					deadline = setTimeout(() => {
						fail(new UploadWaitTimeoutError(1, options.timeoutSeconds));
					}, options.timeoutSeconds * 1000);
					deadline.unref();

					return;
				}

				case 'verdict': {
					if (frame.data.status === 'pending') {
						protocolError(`unexpected verdict frame: ${text}`);

						return;
					}

					// Verification can settle the upload as the socket opens, delivering
					// the verdict before the deferred frame. The path's identity is then
					// the one negotiated for this uploadId, which the server bound to the
					// same metadata.
					const settled = deferred ?? {
						storePathHash: options.storePathHash,
						narHash: options.narHash
					};

					if (frame.data.status === 'servable') {
						succeed({ ...settled, status: 'committed' });

						return;
					}

					fail(
						new UploadVerificationFailedError(
							options.uploadId,
							frame.data.status
						)
					);

					return;
				}

				case 'error': {
					fail(
						new CupboardHttpError(
							'GET',
							options.path,
							frame.data.status,
							frame.data.message
						)
					);
				}
			}
		};

		socket.on('open', () => {
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
			protocolError('the socket closed before the commit settled');
		});

		socket.on('error', (error) => {
			fail(error);
		});

		socket.on('unexpected-response', (_request, response) => {
			const chunks: string[] = [];

			response.on('data', (chunk) => {
				chunks.push(chunk.toString());
			});
			response.on('end', () => {
				fail(
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

			return;
		}

		options.signal?.addEventListener('abort', onAbort, { once: true });
	});
}
