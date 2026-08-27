import {
	capturingReporter as reporter,
	fakeCliUi
} from '@cupboard/cli-ui/testing';
import { cacheNameSchema, tenantIdSchema } from '@cupboard/nix-store/scalars';
import {
	cacheReadCredentialResponseSchema,
	type TenantCreateBody,
	tenantCreateBodySchema,
	tenantListResponseSchema,
	tenantMutateResponseSchema,
	tenantReadModeResponseSchema,
	type TenantSummary,
	tenantSummarySchema
} from '@cupboard/protocol/tenants';
import type { ResultRow } from '@cupboard/reporter';
import { readUserInputSchema } from '@cupboard/shared/http';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	InvalidQuotaBytesError,
	parseQuotaBytes,
	readCredentialFromOptions,
	ReadUserWithoutCredentialError,
	runTenantClearCacheCredential,
	runTenantClearCredential,
	runTenantCreate,
	runTenantList,
	runTenantReadMode,
	runTenantRemove,
	runTenantResume,
	runTenantRotateCacheCredential,
	runTenantRotateCredential,
	runTenantSuspend,
	type TenantClient
} from './tenant.ts';

const acmeTenant = tenantIdSchema.parse('acme');
const buildsCache = cacheNameSchema.parse('builds');
const alice = readUserInputSchema.parse('alice');

// A generated read password: 32 random bytes in base64url. The value is
// random, so the tests read what the command sent and check the report repeats
// it.
const generatedPasswordSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const rotateCallSchema = z.object({
	id: z.string(),
	read: z.object({ user: z.string(), password: generatedPasswordSchema })
});
const rotateCallsSchema = z.tuple([rotateCallSchema]);
const rotateCacheCallSchema = z.object({
	id: z.string(),
	cacheName: z.string(),
	read: z.object({ user: z.string(), password: generatedPasswordSchema })
});
const rotateCacheCallsSchema = z.tuple([rotateCacheCallSchema]);

function thrownBy(run: () => unknown): unknown {
	let thrown: unknown;

	try {
		run();
	} catch (error) {
		thrown = error;
	}

	return thrown;
}

function summary(overrides: Partial<TenantSummary>) {
	return tenantSummarySchema.parse({
		id: 'acme',
		status: 'active',
		readMode: 'private',
		ownerIssuer: 'https://idp.test',
		ownerSubject: 'owner',
		ownerAudience: 'aud',
		configVersion: 1,
		createdAt: '2026-01-01T00:00:00.000Z',
		...overrides
	});
}

function createBody(): TenantCreateBody {
	return tenantCreateBodySchema.parse({
		id: 'acme',
		readMode: 'private',
		ownerIssuer: 'https://idp.test',
		ownerSubject: 'owner',
		ownerAudience: 'aud'
	});
}

function tenantClient(overrides: Partial<TenantClient>): TenantClient {
	return {
		list: () => Promise.resolve({ tenants: [] }),
		create: (input) =>
			Promise.resolve(
				tenantSummarySchema.parse({
					id: input.id,
					status: 'active',
					readMode: input.readMode,
					ownerIssuer: input.ownerIssuer,
					ownerSubject: input.ownerSubject,
					ownerAudience: input.ownerAudience,
					configVersion: 1,
					createdAt: '2026-01-01T00:00:00.000Z'
				})
			),
		suspend: ({ id }) => Promise.resolve({ id, status: 'suspended' }),
		resume: ({ id }) => Promise.resolve({ id, status: 'active' }),
		setReadMode: ({ id, readMode }) => Promise.resolve({ id, readMode }),
		rotateReadCredential: ({ id }) =>
			Promise.resolve({ id, readMode: 'private' }),
		clearReadCredential: ({ id }) =>
			Promise.resolve({ id, readMode: 'private' }),
		rotateCacheReadCredential: ({ id, cacheName }) =>
			Promise.resolve({ id, cacheName, hasCredential: true }),
		clearCacheReadCredential: ({ id, cacheName }) =>
			Promise.resolve({ id, cacheName, hasCredential: false }),
		remove: ({ id }) => Promise.resolve({ id, status: 'offboarding' }),
		...overrides
	};
}

describe('runTenantCreate', () => {
	it('warns when a private tenant is created without a read credential', async () => {
		const results: ResultRow[][] = [];
		const calls: TenantCreateBody[] = [];

		await runTenantCreate(createBody(), reporter(results), {
			create(body) {
				calls.push(body);
				return Promise.resolve(summary({}));
			}
		});

		expect({ calls, results }).toStrictEqual({
			calls: [createBody()],
			results: [
				[
					{ label: 'Tenant', value: 'acme' },
					{ label: 'Status', value: 'active' },
					{ label: 'Read mode', value: 'private' },
					{
						label: 'Warning',
						value:
							'private cache has no read credential; it rejects every read until one is set'
					}
				]
			]
		});
	});

	it('sends the read credential and does not warn when one is given', async () => {
		const results: ResultRow[][] = [];
		const calls: TenantCreateBody[] = [];
		const body = tenantCreateBodySchema.parse({
			id: 'acme',
			readMode: 'private',
			ownerIssuer: 'https://idp.test',
			ownerSubject: 'owner',
			ownerAudience: 'aud',
			read: {
				user: 'alice',
				password: 'wRt2Qm7kZ9x1Yb4Nc6Vd8Fg0Hj3Kl5Mn7Pq9Rs1Tu23'
			}
		});

		await runTenantCreate(body, reporter(results), {
			create(sent) {
				calls.push(sent);
				return Promise.resolve(summary({}));
			}
		});

		expect({ calls, results }).toStrictEqual({
			calls: [body],
			results: [
				[
					{ label: 'Tenant', value: 'acme' },
					{ label: 'Status', value: 'active' },
					{ label: 'Read mode', value: 'private' }
				]
			]
		});
	});

	it('reports a generated read password once when one was generated', async () => {
		const results: ResultRow[][] = [];
		const body = tenantCreateBodySchema.parse({
			id: 'acme',
			readMode: 'private',
			ownerIssuer: 'https://idp.test',
			ownerSubject: 'owner',
			ownerAudience: 'aud',
			read: {
				user: 'cupboard',
				password: 'wRt2Qm7kZ9x1Yb4Nc6Vd8Fg0Hj3Kl5Mn7Pq9Rs1Tu23'
			}
		});

		await runTenantCreate(
			body,
			reporter(results),
			{
				create: () => Promise.resolve(summary({}))
			},
			'wRt2Qm7kZ9x1Yb4Nc6Vd8Fg0Hj3Kl5Mn7Pq9Rs1Tu23'
		);

		expect(results).toStrictEqual([
			[
				{ label: 'Tenant', value: 'acme' },
				{ label: 'Status', value: 'active' },
				{ label: 'Read mode', value: 'private' },
				{ label: 'Read user', value: 'cupboard' },
				{
					label: 'Read password',
					value: 'wRt2Qm7kZ9x1Yb4Nc6Vd8Fg0Hj3Kl5Mn7Pq9Rs1Tu23'
				}
			]
		]);
	});
});

describe('readCredentialFromOptions', () => {
	it('generates a private read password by default', () => {
		const selection = readCredentialFromOptions({});
		const generatedPassword = generatedPasswordSchema.parse(
			selection.generatedPassword
		);

		expect(selection).toStrictEqual({
			read: { user: 'cupboard', password: generatedPassword },
			generatedPassword
		});
	});

	it('generates for a supplied read user', () => {
		const selection = readCredentialFromOptions({ readUser: alice });
		const generatedPassword = generatedPasswordSchema.parse(
			selection.generatedPassword
		);

		expect(selection).toStrictEqual({
			read: { user: 'alice', password: generatedPassword },
			generatedPassword
		});
	});

	it('does not generate for public tenants', () => {
		expect(readCredentialFromOptions({ public: true })).toStrictEqual({
			read: undefined,
			generatedPassword: undefined
		});
	});

	it('creates no credential with --no-read-password', () => {
		expect(readCredentialFromOptions({ readPassword: false })).toStrictEqual({
			read: undefined,
			generatedPassword: undefined
		});
	});

	it('rejects a read user with no read password', () => {
		const error = thrownBy(() =>
			readCredentialFromOptions({ readUser: alice, readPassword: false })
		);

		expect(error).toBeInstanceOf(ReadUserWithoutCredentialError);

		if (error instanceof ReadUserWithoutCredentialError) {
			expect({ name: error.name, readUser: error.readUser }).toStrictEqual({
				name: 'ReadUserWithoutCredentialError',
				readUser: 'alice'
			});
		}
	});
});

describe('parseQuotaBytes', () => {
	it.each([
		{ source: '0', expected: 0 },
		{ source: '100', expected: 100 },
		{
			source: String(Number.MAX_SAFE_INTEGER),
			expected: Number.MAX_SAFE_INTEGER
		}
	])('accepts $source', ({ source, expected }) => {
		expect(parseQuotaBytes(source)).toBe(expected);
	});

	it.each(['', '-1', '+1', '1.5', '1gb', '100foo', 'Infinity'])(
		'rejects %s',
		(source) => {
			const error = thrownBy(() => parseQuotaBytes(source));

			expect(error).toBeInstanceOf(InvalidQuotaBytesError);

			if (error instanceof InvalidQuotaBytesError) {
				expect({ name: error.name, value: error.value }).toStrictEqual({
					name: 'InvalidQuotaBytesError',
					value: source
				});
			}
		}
	);

	it('rejects unsafe integers', () => {
		const error = thrownBy(() => parseQuotaBytes('9007199254740992'));

		expect(error).toBeInstanceOf(InvalidQuotaBytesError);

		if (error instanceof InvalidQuotaBytesError) {
			expect({ name: error.name, value: error.value }).toStrictEqual({
				name: 'InvalidQuotaBytesError',
				value: '9007199254740992'
			});
		}
	});
});

describe('runTenantList', () => {
	it('reports a row per tenant', async () => {
		const results: ResultRow[][] = [];
		const response = tenantListResponseSchema.parse({
			tenants: [
				summary({ id: 'alpha' }),
				summary({ id: 'beta', status: 'suspended', readMode: 'public' })
			]
		});

		await runTenantList(reporter(results), {
			list: () => Promise.resolve(response)
		});

		expect(results).toStrictEqual([
			[
				{ label: 'alpha', value: 'active; private; config v1' },
				{ label: 'beta', value: 'suspended; public; config v1' }
			]
		]);
	});

	it('reports an empty tenant list', async () => {
		const results: ResultRow[][] = [];
		const infos: string[] = [];

		await runTenantList(
			reporter(results, infos),
			tenantClient({ list: () => Promise.resolve({ tenants: [] }) })
		);

		expect({ results, infos }).toStrictEqual({
			results: [[]],
			infos: ['No tenants.']
		});
	});
});

describe('runTenantSuspend / runTenantRemove', () => {
	const cases = [
		{
			name: 'suspend',
			run: runTenantSuspend,
			method: 'suspend' as const,
			status: 'suspended' as const,
			cancelled: 'The tenant was left running.'
		},
		{
			name: 'remove',
			run: runTenantRemove,
			method: 'remove' as const,
			status: 'offboarding' as const,
			cancelled: 'The tenant was left in place.'
		}
	];

	it('states that suspension takes effect on reads and writes immediately', async () => {
		const { ui, captured } = fakeCliUi({ confirm: 'no' });

		await runTenantSuspend(acmeTenant, ui, tenantClient({}));

		expect(captured.confirms).toStrictEqual([
			{
				message: 'Suspend tenant acme?',
				detail:
					'New reads and writes stop as soon as the suspension is recorded.'
			}
		]);
	});

	it.each(cases)(
		'$name reports the resulting status once confirmed',
		async ({ run, method, status }) => {
			const calls: { id: string }[] = [];
			const { ui, captured } = fakeCliUi({ confirm: 'yes' });

			await run(
				acmeTenant,
				ui,
				tenantClient({
					[method](input: { id: string }) {
						calls.push(input);
						return Promise.resolve({ id: 'acme', status });
					}
				})
			);

			expect({ calls, results: captured.results }).toStrictEqual({
				calls: [{ id: 'acme' }],
				results: [
					{
						kind: 'tenant',
						data: { id: 'acme', status },
						rows: [{ label: 'acme', value: status }]
					}
				]
			});
		}
	);

	it.each(cases)(
		'$name does nothing when the confirmation is declined',
		async ({ run, cancelled }) => {
			const { ui, captured } = fakeCliUi({ confirm: 'no' });

			await run(acmeTenant, ui, tenantClient({}));

			expect({
				results: captured.results,
				cancellations: captured.cancellations
			}).toStrictEqual({
				results: [],
				cancellations: [cancelled]
			});
		}
	);
});

describe('runTenantResume', () => {
	it('reports the resumed status', async () => {
		const results: ResultRow[][] = [];
		const calls: { id: string }[] = [];

		await runTenantResume(acmeTenant, reporter(results), {
			resume(input) {
				calls.push(input);
				return Promise.resolve(
					tenantMutateResponseSchema.parse({ id: 'acme', status: 'active' })
				);
			}
		});

		expect({ calls, results }).toStrictEqual({
			calls: [{ id: 'acme' }],
			results: [[{ label: 'acme', value: 'active' }]]
		});
	});
});

describe('runTenantReadMode', () => {
	it('sets the read mode and reports it', async () => {
		const results: ResultRow[][] = [];
		const calls: { id: string; readMode: 'public' | 'private' }[] = [];

		await runTenantReadMode(acmeTenant, 'public', reporter(results), {
			setReadMode(input) {
				calls.push(input);
				return Promise.resolve(
					tenantReadModeResponseSchema.parse({ id: 'acme', readMode: 'public' })
				);
			}
		});

		expect({ calls, results }).toStrictEqual({
			calls: [{ id: 'acme', readMode: 'public' }],
			results: [[{ label: 'acme', value: 'public' }]]
		});
	});
});

describe('runTenantRotateCredential', () => {
	it('generates a password and reports the same value it sends', async () => {
		const results: ResultRow[][] = [];
		const calls: {
			id: string;
			read: { user: string; password: string };
		}[] = [];

		await runTenantRotateCredential(acmeTenant, {}, reporter(results), {
			rotateReadCredential(input) {
				calls.push(input);
				return Promise.resolve(
					tenantReadModeResponseSchema.parse({
						id: 'acme',
						readMode: 'private'
					})
				);
			}
		});
		const [call] = rotateCallsSchema.parse(calls);

		// The operator must see the exact generated password sent to the server;
		// another value could not authenticate.
		const sentPassword = call.read.password;

		expect({ calls, results }).toStrictEqual({
			calls: [
				{
					id: 'acme',
					read: { user: 'cupboard', password: sentPassword }
				}
			],
			results: [
				[
					{ label: 'Tenant', value: 'acme' },
					{ label: 'Read mode', value: 'private' },
					{ label: 'Read user', value: 'cupboard' },
					{ label: 'Read password', value: sentPassword }
				]
			]
		});
	});

	it('warns when the tenant is public', async () => {
		const results: ResultRow[][] = [];
		const calls: {
			id: string;
			read: { user: string; password: string };
		}[] = [];

		await runTenantRotateCredential(
			acmeTenant,
			{ readUser: alice },
			reporter(results),
			{
				rotateReadCredential(input) {
					calls.push(input);
					return Promise.resolve(
						tenantReadModeResponseSchema.parse({
							id: 'acme',
							readMode: 'public'
						})
					);
				}
			}
		);
		const [call] = rotateCallsSchema.parse(calls);
		const sentPassword = call.read.password;

		expect(results).toStrictEqual([
			[
				{ label: 'Tenant', value: 'acme' },
				{ label: 'Read mode', value: 'public' },
				{ label: 'Read user', value: 'alice' },
				{ label: 'Read password', value: sentPassword },
				{
					label: 'Warning',
					value:
						'tenant is public; the read credential is unused until it is private'
				}
			]
		]);
	});
});

describe('runTenantClearCredential', () => {
	it('clears the credential and reports the read mode', async () => {
		const results: ResultRow[][] = [];
		const calls: { id: string }[] = [];

		await runTenantClearCredential(acmeTenant, reporter(results), {
			clearReadCredential(input) {
				calls.push(input);
				return Promise.resolve(
					tenantReadModeResponseSchema.parse({
						id: 'acme',
						readMode: 'private'
					})
				);
			}
		});

		expect({ calls, results }).toStrictEqual({
			calls: [{ id: 'acme' }],
			results: [[{ label: 'acme', value: 'private' }]]
		});
	});
});

describe('runTenantRotateCacheCredential', () => {
	it('generates a password and reports the same value it sends', async () => {
		const results: ResultRow[][] = [];
		const calls: {
			id: string;
			cacheName: string;
			read: { user: string; password: string };
		}[] = [];

		await runTenantRotateCacheCredential(
			acmeTenant,
			buildsCache,
			{},
			reporter(results),
			{
				rotateCacheReadCredential(input) {
					calls.push(input);
					return Promise.resolve(
						cacheReadCredentialResponseSchema.parse({
							id: 'acme',
							cacheName: 'builds',
							hasCredential: true
						})
					);
				}
			}
		);
		const [call] = rotateCacheCallsSchema.parse(calls);

		// The operator must see the exact generated password sent to the server;
		// another value could not authenticate.
		const sentPassword = call.read.password;

		expect({ calls, results }).toStrictEqual({
			calls: [
				{
					id: 'acme',
					cacheName: 'builds',
					read: { user: 'cupboard', password: sentPassword }
				}
			],
			results: [
				[
					{ label: 'Tenant', value: 'acme' },
					{ label: 'Private cache', value: 'builds' },
					{ label: 'Read user', value: 'cupboard' },
					{ label: 'Read password', value: sentPassword }
				]
			]
		});
	});

	it('sends the supplied read user', async () => {
		const results: ResultRow[][] = [];
		const calls: {
			id: string;
			cacheName: string;
			read: { user: string; password: string };
		}[] = [];

		await runTenantRotateCacheCredential(
			acmeTenant,
			buildsCache,
			{ readUser: alice },
			reporter(results),
			{
				rotateCacheReadCredential(input) {
					calls.push(input);
					return Promise.resolve(
						cacheReadCredentialResponseSchema.parse({
							id: 'acme',
							cacheName: 'builds',
							hasCredential: true
						})
					);
				}
			}
		);
		const [call] = rotateCacheCallsSchema.parse(calls);

		expect(results).toStrictEqual([
			[
				{ label: 'Tenant', value: 'acme' },
				{ label: 'Private cache', value: 'builds' },
				{ label: 'Read user', value: 'alice' },
				{ label: 'Read password', value: call.read.password }
			]
		]);
	});
});

describe('runTenantClearCacheCredential', () => {
	it('clears the credential and reports that the tenant credential applies', async () => {
		const results: ResultRow[][] = [];
		const calls: { id: string; cacheName: string }[] = [];

		await runTenantClearCacheCredential(
			acmeTenant,
			buildsCache,
			reporter(results),
			{
				clearCacheReadCredential(input) {
					calls.push(input);
					return Promise.resolve(
						cacheReadCredentialResponseSchema.parse({
							id: 'acme',
							cacheName: 'builds',
							hasCredential: false
						})
					);
				}
			}
		);

		expect({ calls, results }).toStrictEqual({
			calls: [{ id: 'acme', cacheName: 'builds' }],
			results: [
				[
					{ label: 'Tenant', value: 'acme' },
					{ label: 'Private cache', value: 'builds' },
					{
						label: 'Read credential',
						value: 'cleared; readers now use the tenant credential'
					}
				]
			]
		});
	});
});
