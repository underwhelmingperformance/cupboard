import { traceLogFields } from '@cupboard/shared/log-context';
import {
	initialiseTracing,
	traceOperation
} from '@cupboard/shared/node-tracing';
import { resetSync } from '@logtape/logtape';
import { StatusCodes } from 'http-status-codes';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { configureLogging, getLogger, type LogRecord } from './config.ts';
import { serialiseLogProperties } from './serialisation.ts';
import { githubActionsSink, jsonLinesSink } from './sinks.ts';

const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl';

function render(properties: Record<string, unknown>): unknown {
	let result: unknown;
	const sink = jsonLinesSink((line) => {
		result = JSON.parse(line);
	});

	sink({
		timestamp: 0,
		category: ['cupboard'],
		level: 'error',
		rawMessage: 'request failed',
		message: ['request failed'],
		properties
	});

	return result;
}

afterEach(() => {
	resetSync();
});

describe('log redaction', () => {
	it.each([
		['Authorization: Basic dXNlcjpzZWNyZXQ=', 'Authorization: [redacted]'],
		['access_token=opaque-credential', 'access_token=[redacted]'],
		['refresh_token=opaque-credential', 'refresh_token=[redacted]'],
		['client_secret=opaque-credential', 'client_secret=[redacted]'],
		['api_key=opaque-credential', 'api_key=[redacted]'],
		[
			JSON.stringify({ password: 'before"after' }),
			JSON.stringify({ password: '[redacted]' })
		],
		[
			JSON.stringify({ client_secret: String.raw`before\after` }),
			JSON.stringify({ client_secret: '[redacted]' })
		],
		['{"access_token":"opaque-credential"}', '{"access_token":"[redacted]"}']
	])('redacts credentials in diagnostic text: %s', (input, output) => {
		expect(render({ detail: input })).toStrictEqual({
			timestamp: 0,
			level: 'error',
			category: 'cupboard',
			msg: 'request failed',
			detail: output
		});
	});

	it.each([
		[
			'Cookie: session=first-secret; refresh=second-secret',
			'Cookie: [redacted]'
		],
		[
			'Set-Cookie: session=first-secret; Secure; HttpOnly',
			'Set-Cookie: [redacted]'
		],
		[
			'Authorization: Digest username="user", response="private-response"',
			'Authorization: [redacted]'
		],
		[
			"https://user:pa'ssword@example.com/path?key=value",
			'https://example.com/path'
		],
		[
			'https://user:pa"ssword@example.com/path?key=value',
			'https://example.com/path'
		],
		[
			'https://user:pa ssword@example.com/path?key=value',
			'https://example.com/path'
		],
		[
			'{"url":"https://example.com/path","password":"private-password"}',
			'{"url":"https://example.com/'
		],
		[
			'request to https://example.com/path failed with token=private-token',
			'request to https://example.com/'
		]
	])('redacts ambiguous header and URL text: %s', (detail, expected) => {
		expect(render({ detail })).toStrictEqual({
			timestamp: 0,
			level: 'error',
			category: 'cupboard',
			msg: 'request failed',
			detail: expected
		});
	});

	it('redacts text in a standalone Actions sink', () => {
		const lines: string[] = [];
		const sink = githubActionsSink({
			environment: { GITHUB_ACTIONS: 'true' },
			stdout: {
				write: (line) => {
					lines.push(line);
				}
			}
		});

		sink({
			timestamp: 0,
			category: ['cupboard'],
			level: 'info',
			rawMessage: 'Authorization: Basic dXNlcjpzZWNyZXQ=',
			message: ['Authorization: Basic dXNlcjpzZWNyZXQ='],
			properties: {}
		});

		expect(lines).toStrictEqual(['Authorization: [redacted]\n']);
	});

	it.each(['properties', 'error'])(
		'redacts private bodies before evaluating their JSON representation (%s)',
		(location) => {
			const toJSON = vi.fn(() => {
				throw new Error('The body must not be evaluated');
			});
			const body = { toJSON };
			const error = Object.assign(new Error('upload failed'), {
				request: { body }
			});
			const properties =
				location === 'properties' ? { body, attempts: 1 } : { error };
			const expected =
				location === 'properties'
					? { body: '[redacted]', attempts: 1 }
					: {
							errorName: 'Error',
							errorMessage: 'upload failed',
							errorStack: error.stack,
							errorDetails: {
								name: 'Error',
								message: 'upload failed',
								stack: error.stack,
								request: { body: '[redacted]' }
							}
						};

			expect({
				properties: serialiseLogProperties(properties),
				serialisations: toJSON.mock.calls.length
			}).toStrictEqual({ properties: expected, serialisations: 0 });
		}
	);

	it('bounds visits to wide diagnostic objects before redaction', () => {
		const detail: Record<string, unknown> = {};
		let reads = 0;

		for (let index = 0; index < 1000; index += 1) {
			Object.defineProperty(detail, `field${String(index)}`, {
				enumerable: true,
				get: () => {
					reads += 1;
					return index;
				}
			});
		}

		expect({ record: render({ detail }), reads }).toStrictEqual({
			record: {
				timestamp: 0,
				level: 'error',
				category: 'cupboard',
				msg: 'request failed',
				detail: Object.fromEntries(
					Array.from({ length: 64 }, (_, index) => [
						`field${String(index)}`,
						index
					])
				)
			},
			reads: 64
		});
	});

	it.each(['getter', 'toJSON'])(
		'reports an unreadable diagnostic %s without throwing',
		(kind) => {
			const detail =
				kind === 'getter'
					? Object.defineProperty({}, 'value', {
							enumerable: true,
							get: () => {
								throw new Error('unreadable');
							}
						})
					: {
							toJSON: () => {
								throw new Error('unreadable');
							}
						};

			expect(serialiseLogProperties({ detail })).toStrictEqual({
				logSerialisationFailed: true
			});
		}
	);

	it('keeps Error details when an SDK supplies a custom JSON representation', () => {
		const error = Object.assign(new Error('fetch failed'), {
			code: 'ECONNRESET',
			toJSON: () => ({ summary: 'not an Error representation' })
		});

		expect(serialiseLogProperties({ error })).toStrictEqual({
			errorName: 'Error',
			errorMessage: 'fetch failed',
			errorStack: error.stack,
			errorDetails: {
				name: 'Error',
				message: 'fetch failed',
				stack: error.stack,
				code: 'ECONNRESET'
			}
		});
	});

	it('preserves exact bigint values and bounded cyclic errors', () => {
		const error = new Error('loop');
		Object.defineProperty(error, 'cause', { value: error });

		expect(
			serialiseLogProperties({ count: 9_007_199_254_740_993n, error })
		).toStrictEqual({
			count: '9007199254740993n',
			errorName: 'Error',
			errorMessage: 'loop',
			errorStack: error.stack,
			errorCause: '[Circular]',
			errorDetails: {
				name: 'Error',
				message: 'loop',
				stack: error.stack,
				cause: '[Circular]'
			}
		});
	});

	it('adds the active trace context before configured sinks truncate fields', async () => {
		initialiseTracing();

		const records: LogRecord[] = [];
		configureLogging({
			sink: (record) => {
				records.push(record);
			}
		});
		const fields = Object.fromEntries(
			Array.from({ length: 64 }, (_, index) => [`field${String(index)}`, index])
		);

		const traceFields = await traceOperation('diagnostic', async () => {
			await Promise.resolve();
			getLogger('cupboard').info('request', fields);
			return traceLogFields();
		});

		expect(records.map((record) => record.properties)).toStrictEqual([
			{
				...Object.fromEntries(Object.entries(fields).slice(0, 60)),
				...traceFields,
				logTruncated: true
			}
		]);
	});

	it('keeps nested network codes in an ordinary fetch error', () => {
		const cause = Object.assign(new Error('socket closed'), {
			code: 'ECONNRESET',
			syscall: 'read'
		});
		const error = new TypeError('fetch failed', { cause });

		expect(render({ error })).toStrictEqual({
			timestamp: 0,
			level: 'error',
			category: 'cupboard',
			msg: 'request failed',
			errorName: 'TypeError',
			errorMessage: 'fetch failed',
			errorStack: error.stack,
			errorCause: 'Error: socket closed',
			errorCauseStack: cause.stack,
			errorDetails: {
				name: 'TypeError',
				message: 'fetch failed',
				stack: error.stack,
				cause: {
					name: 'Error',
					message: 'socket closed',
					stack: cause.stack,
					code: 'ECONNRESET',
					syscall: 'read'
				}
			}
		});
	});

	it('preserves dates in ordinary diagnostic properties', () => {
		expect(
			render({ startedAt: new Date('2026-10-24T00:00:00Z') })
		).toStrictEqual({
			timestamp: 0,
			level: 'error',
			category: 'cupboard',
			msg: 'request failed',
			startedAt: '2026-10-24T00:00:00.000Z'
		});
	});

	it('keeps correlation fields when broad diagnostic properties are truncated', () => {
		const fields = Object.fromEntries(
			Array.from({ length: 64 }, (_, index) => [`field${String(index)}`, index])
		);
		const correlation = {
			trace_id: '0123456789abcdef0123456789abcdef',
			span_id: '0123456789abcdef',
			trace_flags: '01',
			requestId: 'server-request',
			cfRay: 'ray-LHR',
			ray: 'ray-LHR',
			clientTraceId: 'abcdef0123456789abcdef0123456789',
			clientSpanId: 'abcdef0123456789'
		};

		expect(render({ ...fields, ...correlation })).toStrictEqual({
			timestamp: 0,
			level: 'error',
			category: 'cupboard',
			msg: 'request failed',
			...Object.fromEntries(Object.entries(fields).slice(0, 52)),
			...correlation,
			logTruncated: true
		});
	});

	it('redacts nested credential fields and URL credentials without losing correlation fields', () => {
		const result = render({
			trace_id: '0123456789abcdef0123456789abcdef',
			requestId: 'server-request',
			socket: { address: '127.0.0.1', port: 443 },
			url: 'https://alice:secret@example.com/cache?token=secret#fragment',
			attempts: [
				{
					authorization: 'Bearer secret',
					token,
					status: StatusCodes.SERVICE_UNAVAILABLE
				}
			],
			detail: `Bearer secret ${token}`
		});

		expect(result).toStrictEqual({
			timestamp: 0,
			level: 'error',
			category: 'cupboard',
			msg: 'request failed',
			trace_id: '0123456789abcdef0123456789abcdef',
			requestId: 'server-request',
			socket: { address: '127.0.0.1', port: 443 },
			url: 'https://example.com/cache',
			attempts: [
				{
					authorization: '[redacted]',
					token: '[redacted]',
					status: StatusCodes.SERVICE_UNAVAILABLE
				}
			],
			detail: 'Bearer [redacted] [JWT REDACTED]'
		});
	});

	it('preserves error codes and aggregate causes while redacting their contents', () => {
		const cause = Object.assign(new Error('connect failed token=secret'), {
			code: 'ECONNRESET',
			authorization: 'Bearer secret'
		});
		const error = new AggregateError([cause], 'request failed', { cause });
		const causeStack = cause.stack?.replaceAll(
			'token=secret',
			'token=[redacted]'
		);

		expect(render({ error })).toStrictEqual({
			timestamp: 0,
			level: 'error',
			category: 'cupboard',
			msg: 'request failed',
			errorName: 'AggregateError',
			errorMessage: 'request failed',
			errorStack: error.stack,
			errorCause: 'Error: connect failed token=[redacted]',
			errorCauseStack: causeStack,
			errorDetails: {
				name: 'AggregateError',
				message: 'request failed',
				stack: error.stack,
				cause: {
					name: 'Error',
					message: 'connect failed token=[redacted]',
					stack: causeStack,
					code: 'ECONNRESET',
					authorization: '[redacted]'
				},
				errors: [
					{
						name: 'Error',
						message: 'connect failed token=[redacted]',
						stack: causeStack,
						code: 'ECONNRESET',
						authorization: '[redacted]'
					}
				]
			}
		});
	});

	it.each([
		[
			'cookie',
			'session=first-secret; refresh=second-secret',
			'Cookie: [redacted]'
		],
		['url', "pa'ssword", 'https://example.com/path']
	])(
		'redacts credentials across message parts: %s',
		(kind, detail, expected) => {
			const lines: string[] = [];
			const sink = githubActionsSink({
				environment: { GITHUB_ACTIONS: 'true' },
				stdout: {
					write: (line) => {
						lines.push(line);
					}
				}
			});
			const message =
				kind === 'cookie'
					? ['Cookie: ', detail, '']
					: ['https://user:', detail, '@example.com/path?key=value'];

			sink({
				timestamp: 0,
				category: ['cupboard'],
				level: 'info',
				rawMessage: Object.assign(
					kind === 'cookie'
						? ['Cookie: ', '']
						: ['https://user:', '@example.com/path?key=value'],
					{ raw: [] }
				),
				message,
				properties: {}
			});

			expect(lines).toStrictEqual([`${expected}\n`]);
		}
	);

	it('redacts Error interpolation and the raw message before custom sinks', () => {
		const records: LogRecord[] = [];
		const error = new Error('Bearer opaque-credential');

		configureLogging({
			sink: (record) => {
				records.push(record);
			}
		});
		getLogger('cupboard').warn('source failed: {error}', { error });

		expect(
			records.map(({ rawMessage, message, properties }) => ({
				rawMessage,
				message,
				properties
			}))
		).toStrictEqual([
			{
				rawMessage: 'source failed: Error: Bearer [redacted]',
				message: ['source failed: Error: Bearer [redacted]'],
				properties: {
					errorName: 'Error',
					errorMessage: 'Bearer [redacted]',
					errorStack: error.stack?.replaceAll(
						'Bearer opaque-credential',
						'Bearer [redacted]'
					),
					errorDetails: {
						name: 'Error',
						message: 'Bearer [redacted]',
						stack: error.stack?.replaceAll(
							'Bearer opaque-credential',
							'Bearer [redacted]'
						)
					}
				}
			}
		]);
	});

	it('redacts interpolated messages before custom sinks receive a record', () => {
		const records: LogRecord[] = [];

		configureLogging({
			sink: (record) => {
				records.push(record);
			}
		});
		const error = new Error('Bearer secret');

		getLogger('cupboard').error('authentication failed: {password}', {
			password: 'secret',
			error
		});

		expect(
			records.map(({ message, properties }) => ({ message, properties }))
		).toStrictEqual([
			{
				message: ['authentication failed: [redacted]'],
				properties: {
					password: '[redacted]',
					errorDetails: {
						name: 'Error',
						message: 'Bearer [redacted]',
						stack: error.stack?.replaceAll('Bearer secret', 'Bearer [redacted]')
					},
					errorName: 'Error',
					errorMessage: 'Bearer [redacted]',
					errorStack: error.stack?.replaceAll(
						'Bearer secret',
						'Bearer [redacted]'
					)
				}
			}
		]);
	});
});
