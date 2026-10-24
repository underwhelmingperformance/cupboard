import { AsyncLocalStorage } from 'node:async_hooks';

import { getLogger, withContext } from '@cupboard/logger';
import {
	type Context,
	context,
	propagation,
	SpanKind,
	SpanStatusCode,
	trace
} from '@opentelemetry/api';
import { StatusCodes } from 'http-status-codes';

import type {
	CommitSocket,
	CommitSocketConnect,
	UpgradeResponse
} from './commit-socket.ts';

const logger = getLogger(['cupboard', 'commit', 'socket']);
const connections = new WeakMap<CommitSocket, SocketObservation>();
const counters = { connections: 0 };

interface SocketObservation {
	readonly run: ReturnType<typeof AsyncLocalStorage.snapshot>;
	readonly fields: Record<string, unknown>;
	sent: number;
	received: number;
}

function correlation(response: UpgradeResponse): Record<string, string> {
	const fields: Record<string, string> = {};

	for (const [header, field] of [
		['x-request-id', 'requestId'],
		['cf-ray', 'cfRay']
	] as const) {
		const raw = response.headers[header];
		const value = Array.isArray(raw) ? raw[0] : raw;

		if (value !== undefined) {
			fields[field] = value.slice(0, 128);
		}
	}

	return fields;
}

export function observeCommitConnection(
	connect: CommitSocketConnect,
	url: URL,
	headers: Readonly<Record<string, string>>,
	parent: Context
): CommitSocket {
	const span = trace.getTracer('cupboard.commit').startSpan(
		'commit.connection',
		{
			kind: SpanKind.CLIENT,
			attributes: { 'server.address': url.hostname, 'url.path': url.pathname }
		},
		parent
	);
	const active = trace.setSpan(parent, span);
	let isFinished = false;
	const finish = (): void => {
		if (isFinished) {
			return;
		}

		isFinished = true;
		span.end();
	};

	return context.with(active, () => {
		const carrier: Record<string, string> = {};
		propagation.inject(active, carrier);
		const outgoing = Object.fromEntries(
			Object.entries(headers).filter(
				([header]) =>
					!['traceparent', 'tracestate', 'baggage'].includes(
						header.toLowerCase()
					)
			)
		);

		Object.assign(outgoing, carrier);
		const started = performance.now();
		let socket: CommitSocket;

		try {
			socket = connect(url, outgoing);
		} catch (error) {
			span.setStatus({ code: SpanStatusCode.ERROR });
			logger.debug('commit connection failed', { error });
			finish();
			throw error;
		}

		const observation: SocketObservation = {
			run: AsyncLocalStorage.snapshot(),
			fields: {
				connectionId: ++counters.connections,
				url: `${url.origin}${url.pathname}`
			},
			sent: 0,
			received: 0
		};
		connections.set(socket, observation);
		const emit = (
			message: string,
			fields: Record<string, unknown> = {}
		): void => {
			observation.run(() => {
				withContext(observation.fields, () => {
					logger.trace(message, {
						...observation.fields,
						...fields,
						elapsedMs: performance.now() - started
					});
				});
			});
		};
		const responseFields = (response: UpgradeResponse): void => {
			const fields = correlation(response);
			const attributes = Object.entries(fields);
			Object.assign(observation.fields, fields);

			if (!isFinished) {
				for (const [key, value] of attributes) {
					span.setAttribute(
						key === 'requestId' ? 'cupboard.request_id' : 'cloudflare.ray_id',
						value
					);
				}
			}
		};

		emit('commit connection started');
		socket.on('upgrade', (response) => {
			responseFields(response);
			emit('commit connection upgraded', {
				status: StatusCodes.SWITCHING_PROTOCOLS
			});
		});
		socket.on('unexpected-response', (_request, response) => {
			responseFields(response);
			if (!isFinished) {
				span.setStatus({ code: SpanStatusCode.ERROR });
			}
			emit('commit connection refused', { status: response.statusCode });
			finish();
		});
		socket.on('message', (data) => {
			observation.received += 1;
			emit('commit message received', {
				messageBytes:
					data instanceof Uint8Array
						? data.byteLength
						: typeof data === 'string'
							? Buffer.byteLength(data)
							: undefined
			});
		});
		socket.on('close', (code) => {
			if (!isFinished && code !== 1000 && code !== 1001) {
				span.setStatus({ code: SpanStatusCode.ERROR });
			}

			emit('commit connection closed', {
				code,
				sent: observation.sent,
				received: observation.received
			});
			finish();
		});
		socket.on('error', (error) => {
			if (!isFinished) {
				span.setStatus({ code: SpanStatusCode.ERROR });
			}

			emit('commit connection failed', { error });
			finish();
		});

		return socket;
	});
}

export function sendObservedCommitMessage(
	socket: CommitSocket,
	data: string
): void {
	const observation = connections.get(socket);

	if (observation !== undefined) {
		observation.sent += 1;
		observation.run(() => {
			logger.trace('commit message sent', {
				...observation.fields,
				messageBytes: Buffer.byteLength(data)
			});
		});
	}

	socket.send(data);
}
