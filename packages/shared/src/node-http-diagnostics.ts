import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';

import { getConfig, getLogger } from '@logtape/logtape';
import { context, ROOT_CONTEXT } from '@opentelemetry/api';

import { currentHttpAttemptFields } from './fetch-observation.ts';

const logger = getLogger(['cupboard', 'http', 'undici']);
const requests = new WeakMap<object, RequestObservation>();
const sockets = new WeakMap<object, number>();
const subscriptions = new Map<string, (message: unknown) => void>();
const counters = {
	requests: 0,
	sockets: 0,
	completed: 0,
	transportErrors: 0,
	instrumentationFailures: 0
};

interface RequestObservation {
	readonly run: ReturnType<typeof AsyncLocalStorage.snapshot>;
	readonly started: number;
	readonly fields: Record<string, unknown>;
	isFinished: boolean;
}

function objectField(value: unknown, key: string): unknown {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}

	return Reflect.get(value, key);
}

function isObject(value: unknown): value is object {
	return typeof value === 'object' && value !== null;
}

function socketFields(socket: unknown): Record<string, unknown> {
	if (!isObject(socket)) {
		return {};
	}

	let socketId = sockets.get(socket);

	if (socketId === undefined) {
		socketId = ++counters.sockets;
		sockets.set(socket, socketId);
	}

	return {
		socketId,
		...scalarFields(socket, [
			'localAddress',
			'localPort',
			'remoteAddress',
			'remotePort',
			'remoteFamily',
			'connecting',
			'destroyed',
			'encrypted',
			'authorized'
		])
	};
}

function scalarFields(
	value: unknown,
	keys: readonly string[]
): Record<string, unknown> {
	const result: Record<string, unknown> = {};

	for (const key of keys) {
		const field = objectField(value, key);

		if (
			typeof field === 'string' ||
			typeof field === 'number' ||
			typeof field === 'boolean'
		) {
			result[key] = typeof field === 'string' ? field.slice(0, 256) : field;
		}
	}

	return result;
}

function responseFields(response: unknown): Record<string, unknown> {
	const fields = scalarFields(response, ['statusCode']);
	const headers = objectField(response, 'headers');

	if (!Array.isArray(headers)) {
		return fields;
	}

	for (let index = 0; index < headers.length; index += 2) {
		const key: unknown = headers[index];
		const value: unknown = headers[index + 1];

		if (!(key instanceof Uint8Array) || !(value instanceof Uint8Array)) {
			continue;
		}

		const header = Buffer.from(key).toString('ascii').toLowerCase();

		if (header === 'x-request-id' || header === 'cf-ray') {
			fields[header === 'x-request-id' ? 'requestId' : 'cfRay'] = Buffer.from(
				value.subarray(0, 128)
			).toString('utf8');
		}
	}

	return fields;
}

function subscribe(name: string, onMessage: (message: unknown) => void): void {
	const guarded = (message: unknown): void => {
		try {
			onMessage(message);
		} catch {
			counters.instrumentationFailures += 1;
		}
	};

	subscriptions.set(name, guarded);
	channel(name).subscribe(guarded);
}

function observeRequest(message: unknown, event: string): void {
	const request = objectField(message, 'request');
	const observation = isObject(request) ? requests.get(request) : undefined;

	if (observation === undefined || observation.isFinished) {
		return;
	}

	const isCompleted = event === 'trailers';
	const hasFailed = event === 'error';

	if (isCompleted || hasFailed) {
		observation.isFinished = true;
		counters[hasFailed ? 'transportErrors' : 'completed'] += 1;
	}

	Object.assign(
		observation.fields,
		responseFields(objectField(message, 'response'))
	);
	observation.run(() => {
		logger.trace('HTTP transport event', () => ({
			...observation.fields,
			event,
			elapsedMs: performance.now() - observation.started,
			...socketFields(objectField(message, 'socket')),
			...(hasFailed && { error: objectField(message, 'error') })
		}));
	});
}

/**
Installs process-wide transport diagnostics for observed HTTP attempts.
*/
export function initialiseHttpDiagnostics(): void {
	if (subscriptions.size > 0) {
		return;
	}

	subscribe('undici:request:create', (message) => {
		const fields = currentHttpAttemptFields();
		const request = objectField(message, 'request');

		if (fields === undefined || !isObject(request)) {
			return;
		}

		const origin = objectField(request, 'origin');
		const path = objectField(request, 'path');
		const method = objectField(request, 'method');
		const url =
			typeof origin === 'string' && typeof path === 'string'
				? URL.parse(path, origin)
				: undefined;

		requests.set(request, {
			run: AsyncLocalStorage.snapshot(),
			started: performance.now(),
			fields: {
				...fields,
				...(typeof method === 'string' && { method }),
				...(url instanceof URL && { url: `${url.origin}${url.pathname}` }),
				transportRequestId: ++counters.requests
			},
			isFinished: false
		});
		observeRequest(message, 'created');
	});

	for (const event of ['bodySent', 'headers', 'trailers', 'error']) {
		subscribe(`undici:request:${event}`, (message) => {
			observeRequest(message, event);
		});
	}

	subscribe('undici:client:sendHeaders', (message) => {
		observeRequest(message, 'sendHeaders');
	});

	for (const event of ['beforeConnect', 'connected', 'connectError']) {
		subscribe(`undici:client:${event}`, (message) => {
			const emit = (): void => {
				context.with(ROOT_CONTEXT, () => {
					logger.trace('HTTP connection event', () => ({
						event,
						...scalarFields(objectField(message, 'connectParams'), [
							'hostname',
							'protocol',
							'port'
						]),
						...socketFields(objectField(message, 'socket')),
						...(event === 'connectError' && {
							error: objectField(message, 'error')
						})
					}));
				});
			};
			const storage = getConfig()?.contextLocalStorage;

			if (storage === undefined) {
				emit();
				return;
			}

			storage.run({}, emit);
		});
	}
}

/**
Returns process totals without request identifiers or URL dimensions.
*/
export function httpDiagnosticCounters(): Readonly<typeof counters> {
	return { ...counters };
}

/**
Removes subscriptions after owned requests have finished.
*/
export function stopHttpDiagnostics(): void {
	for (const [name, onMessage] of subscriptions) {
		channel(name).unsubscribe(onMessage);
	}

	subscriptions.clear();
}
