import { spawn } from 'node:child_process';
import { constants } from 'node:os';

import { traceLogFields } from '@cupboard/shared/log-context';
import {
	initialiseTracing,
	stopTracing,
	traceOperation
} from '@cupboard/shared/node-tracing';
import { resetSync } from '@logtape/logtape';
import { StatusCodes } from 'http-status-codes';
import { check } from 'recheck';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { configureLogging, getLogger, type LogRecord } from './config.ts';
import { redactingSink, textPatterns } from './redaction.ts';
import { serialiseLogProperties } from './serialisation.ts';
import { githubActionsSink, jsonLinesSink } from './sinks.ts';

const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl';

afterAll(stopTracing);

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

/**
Redacts a record whose tagged-template message interpolates `value`, and
returns the message that the sink receives.
*/
function redactedMessage(value: unknown): readonly unknown[] {
	let message: readonly unknown[] = [];
	const sink = redactingSink((record) => {
		message = record.message;
	});

	sink({
		timestamp: 0,
		category: ['cupboard'],
		level: 'info',
		rawMessage: Object.assign(['detail ', ''], { raw: ['detail ', ''] }),
		message: ['detail ', value, ''],
		properties: {}
	});

	return message;
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
		['pa\u{17F}sword=opaque-credential', 'pa\u{17F}sword=[redacted]'],
		['api_\u{212A}ey=opaque-credential', 'api_\u{212A}ey=[redacted]'],
		['passphrase: opaque-credential', 'passphrase: [redacted]'],
		['--private-key=opaque-credential', '--private-key=[redacted]'],
		[
			JSON.stringify({ signature: 'opaque-credential' }),
			JSON.stringify({ signature: '[redacted]' })
		],
		['password="unterminated value', 'password="[redacted]"'],
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

	it.each([
		[
			['push', '--read-password', 'opaque-credential', '--github-oidc'],
			['push', '--read-password', '[redacted]', '--github-oidc']
		],
		[
			['setup', '--github-token=opaque-credential', '--cache', 'main'],
			['setup', '--github-token=[redacted]', '--cache', 'main']
		],
		[
			['plan', 'cohort', '--view-read-password', '--read-password', 'x'],
			['plan', 'cohort', '--view-read-password', '[redacted]', '[redacted]']
		],
		[
			['deploy', '--api-key', 'opaque-credential', '--yes'],
			['deploy', '--api-key', '[redacted]', '--yes']
		],
		[
			['deploy', '--api_key=opaque-credential', '--yes'],
			['deploy', '--api_key=[redacted]', '--yes']
		]
	])('redacts option values in argument lists: %j', (spawnargs, expected) => {
		expect(render({ spawnargs })).toStrictEqual({
			timestamp: 0,
			level: 'error',
			category: 'cupboard',
			msg: 'request failed',
			spawnargs: expected
		});
	});

	it.each([
		[
			'cupboard push --read-password opaque-credential --github-oidc',
			'cupboard push --read-password [redacted] --github-oidc'
		],
		[
			'cupboard setup --github-token\topaque-credential',
			'cupboard setup --github-token\t[redacted]'
		],
		['deploy -api-key opaque-credential', 'deploy -api-key [redacted]'],
		[
			'push --read-pa\u{17F}sword opaque-credential',
			'push --read-pa\u{17F}sword [redacted]'
		],
		[
			"deploy --api-key 'alpha beta gamma' --yes",
			"deploy --api-key '[redacted]' --yes"
		],
		['deploy --passphrase "alpha beta', 'deploy --passphrase "[redacted]"']
	])('redacts option values in a command line: %s', (detail, expected) => {
		expect(render({ detail })).toStrictEqual({
			timestamp: 0,
			level: 'error',
			category: 'cupboard',
			msg: 'request failed',
			detail: expected
		});
	});

	it('redacts the arguments of a command that could not be started', async () => {
		const child = spawn('/nonexistent/cupboard', [
			'push',
			'--read-password',
			'opaque-credential',
			'--github-token=opaque-credential'
		]);
		const error = await new Promise<unknown>((resolve) => {
			child.once('error', resolve);
		});

		if (!(error instanceof Error)) {
			throw new TypeError('spawn did not report an Error');
		}

		expect(render({ error })).toStrictEqual({
			timestamp: 0,
			level: 'error',
			category: 'cupboard',
			msg: 'request failed',
			errorName: 'Error',
			errorMessage: 'spawn /nonexistent/cupboard ENOENT',
			errorStack: error.stack,
			errorDetails: {
				name: 'Error',
				message: 'spawn /nonexistent/cupboard ENOENT',
				stack: error.stack,
				errno: -constants.errno.ENOENT,
				code: 'ENOENT',
				syscall: 'spawn /nonexistent/cupboard',
				path: '/nonexistent/cupboard',
				spawnargs: [
					'push',
					'--read-password',
					'[redacted]',
					'--github-token=[redacted]'
				]
			}
		});
	});

	it.each(['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_'])(
		'redacts a GitHub token with the %s prefix',
		(prefix) => {
			expect(
				render({ detail: `clone with ${prefix}${'A1b2'.repeat(9)} failed` })
			).toStrictEqual({
				timestamp: 0,
				level: 'error',
				category: 'cupboard',
				msg: 'request failed',
				detail: 'clone with [redacted] failed'
			});
		}
	);

	it.each(Object.entries(textPatterns))(
		'proves the %s pattern linear',
		async (_name, pattern) => {
			// An infinite time limit never expires, so the analysis finishes however
			// long it takes on a loaded machine.
			const diagnostics = await check(pattern.source, pattern.flags, {
				checker: 'automaton',
				timeout: Infinity,
				attackTimeout: Infinity,
				incubationTimeout: Infinity,
				seedingTimeout: Infinity
			});

			expect(diagnostics).toStrictEqual({
				source: pattern.source,
				flags: pattern.flags,
				status: 'safe',
				checker: 'automaton',
				complexity: { type: 'linear', summary: 'linear', isFuzz: false }
			});
		}
	);

	it.each([
		[
			'a token that crosses the truncation point',
			`${'x'.repeat(4090)} ghp_${'A1b2'.repeat(9)} ${'y'.repeat(100)}`,
			`${'x'.repeat(4090)} [reda[truncated]`
		],
		[
			'a value that continues past the scanned text',
			`token="${'a'.repeat(9000)}"`,
			'token="[redacted]"[truncated]'
		],
		[
			'a character that crosses the end of the scanned text',
			`token=${'a'.repeat(5000)} ${'b'.repeat(3184)}\u{1F600}z`,
			`token=[redacted] ${'b'.repeat(3184)}\u{1F600}[truncated]`
		],
		[
			'a character that ends at the end of the scanned text',
			`token=${'a'.repeat(5000)} ${'b'.repeat(3184)}\u{1F600}`,
			`token=[redacted] ${'b'.repeat(3184)}\u{1F600}`
		],
		[
			'a JWT whose second dot is past the scanned text',
			`value eyJ${'a'.repeat(5000)}.${'b'.repeat(5000)}.c2lnbmF0dXJl`,
			'value [JWT REDACTED][truncated]'
		],
		[
			'a character that crosses the truncation point',
			`${'x'.repeat(4095)}\u{1F600}${'y'.repeat(10)}`,
			`${'x'.repeat(4095)}\u{1F600}[truncated]`
		]
	])('redacts and truncates %s', (_case, detail, expected) => {
		expect(render({ detail })).toStrictEqual({
			timestamp: 0,
			level: 'error',
			category: 'cupboard',
			msg: 'request failed',
			detail: expected
		});
	});

	it('bounds the depth of a message value', () => {
		let value: Record<string, unknown> = { leaf: true };

		for (let depth = 0; depth < 12_000; depth += 1) {
			value = { child: value };
		}

		expect(redactedMessage(value)).toStrictEqual(['detail [object Object]']);
	});

	it('bounds the breadth of an array in a message', () => {
		const value = Array.from({ length: 100_000 }, (_, index) => index);

		expect(redactedMessage(value)).toStrictEqual([
			`detail ${value.slice(0, 64).join(',')}`
		]);
	});

	it('bounds visits to a wide object in a message', () => {
		const value: Record<string, unknown> = {};
		let reads = 0;

		for (let index = 0; index < 1000; index += 1) {
			Object.defineProperty(value, `field${String(index)}`, {
				enumerable: true,
				get: () => {
					reads += 1;
					return index;
				}
			});
		}

		expect({ message: redactedMessage(value), reads }).toStrictEqual({
			message: ['detail [object Object]'],
			reads: 64
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
