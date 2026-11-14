import {
	capturingReporter as reporter,
	fakeCliUi
} from '@cupboard/cli-ui/testing';
import {
	cacheNameSchema,
	type CacheScope,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import {
	cacheReadCredentialResponseSchema,
	defaultReadUser,
	tenantCreateBodySchema,
	tenantListResponseSchema,
	tenantMutateResponseSchema,
	type TenantQuota,
	tenantReadCredentialResponseSchema,
	tenantSummarySchema
} from '@cupboard/protocol/tenants';
import type { ResultRow } from '@cupboard/reporter';
import { genericExitCode } from '@cupboard/shared/errors';
import { readUserInputSchema } from '@cupboard/shared/http';
import { ORPCError } from '@orpc/client';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { cliExitCode } from '../cli.ts';
import {
	OwnerLoginRequiredError,
	TenantCreateIncompleteError
} from '../errors.ts';

import {
	InvalidQuotaBytesError,
	parseQuotaBytes,
	readCredentialFromOptions,
	ReadUserWithoutCredentialError,
	registerTenantCommands,
	runTenantClearCacheCredential,
	runTenantClearCredential,
	runTenantCreate,
	runTenantList,
	runTenantQuota,
	runTenantRemove,
	runTenantResume,
	runTenantRotateCacheCredential,
	runTenantRotateCredential,
	runTenantSetQuota,
	runTenantSuspend,
	type TenantClient,
	type TenantCreateOptions
} from './tenant.ts';

const acme = tenantIdSchema.parse('acme');
const alice = readUserInputSchema.parse('alice');
const password = 'A'.repeat(43);

const quotaMocks = vi.hoisted(() => ({ client: vi.fn(), set: vi.fn() }));
vi.mock('../client/orpc.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../client/orpc.ts')>()),
	controlRpc: quotaMocks.client
}));

describe('parsed quota selection', () => {
	it.each([['0'], ['--quota-bytes', '0']])(
		'sets zero bytes with %j',
		async (...arguments_) => {
			quotaMocks.set.mockReset();
			quotaMocks.client.mockReset();
			quotaMocks.set.mockResolvedValue({
				id: acme,
				quota: { kind: 'limited', bytes: 0 },
				usedBytes: 0
			});
			quotaMocks.client.mockReturnValue({
				tenants: { setQuota: quotaMocks.set }
			});
			const program = new Command().exitOverride();
			registerTenantCommands(program);
			await program.parseAsync(
				[
					'tenant',
					'set-quota',
					'https://cupboard.example.workers.dev',
					'acme',
					...arguments_
				],
				{ from: 'user' }
			);
			expect(quotaMocks.set.mock.calls).toStrictEqual([
				[{ id: acme, quota: { kind: 'limited', bytes: 0 } }]
			]);
		}
	);

	it.each([
		{
			args: [],
			message:
				'Pass a quota in bytes as the positional argument or with --quota-bytes.'
		},
		{
			args: ['1', '--quota-bytes', '2'],
			message:
				'Pass the quota once: use either the positional bytes argument or --quota-bytes.'
		},
		{
			args: ['0', '--quota-bytes', '0'],
			message:
				'Pass the quota once: use either the positional bytes argument or --quota-bytes.'
		}
	])(
		'refuses $args before creating an authenticated client',
		async ({ args, message }) => {
			quotaMocks.client.mockClear();
			const program = new Command()
				.exitOverride()
				.configureOutput({ writeErr: vi.fn() });
			registerTenantCommands(program);
			let result: unknown;
			try {
				await program.parseAsync(
					[
						'tenant',
						'set-quota',
						'https://cupboard.example.workers.dev',
						'acme',
						...args
					],
					{ from: 'user' }
				);
			} catch (error) {
				result = {
					status: cliExitCode(error, 1),
					message: error instanceof Error ? error.message : undefined
				};
			}
			expect({
				result,
				clientCalls: quotaMocks.client.mock.calls
			}).toStrictEqual({ result: { status: 2, message }, clientCalls: [] });
		}
	);
});

function summary(status: 'active' | 'suspended' = 'active') {
	return tenantSummarySchema.parse({
		id: acme,
		status,
		ownerIssuer: 'https://issuer.example',
		ownerSubject: 'owner',
		ownerAudience: 'cupboard',
		configVersion: 3,
		createdAt: '2026-09-01T00:00:00.000Z'
	});
}

// The message and stack of `error` and of every error in its cause chain,
// with each error's own properties.
function errorChainText(error: unknown): string {
	const parts: string[] = [];
	const seen = new Set<unknown>();
	let current = error;

	while (current instanceof Error && !seen.has(current)) {
		seen.add(current);
		parts.push(
			current.message,
			current.stack ?? '',
			JSON.stringify(Object.entries(current))
		);
		current = current.cause;
	}

	return parts.join('\n');
}

function tenantClient(overrides: Partial<TenantClient>): TenantClient {
	return {
		list: () => Promise.resolve({ tenants: [] }),
		create: () => Promise.resolve(summary()),
		suspend: ({ id }) => Promise.resolve({ id, status: 'suspended' }),
		resume: ({ id }) => Promise.resolve({ id, status: 'active' }),
		getQuota: ({ id }) =>
			Promise.resolve({ id, quota: { kind: 'unlimited' }, usedBytes: 0 }),
		setQuota: ({ id, quota }) => Promise.resolve({ id, quota, usedBytes: 0 }),
		rotateReadCredential: ({ id }) =>
			Promise.resolve({ id, hasCredential: true }),
		clearReadCredential: ({ id }) =>
			Promise.resolve({ id, hasCredential: false }),
		rotateDefaultCacheReadCredential: ({ id }) =>
			Promise.resolve({ id, cache: { kind: 'default' }, hasCredential: true }),
		rotateNamedCacheReadCredential: ({ id, cacheName }) =>
			Promise.resolve({
				id,
				cache: { kind: 'named', name: cacheName },
				hasCredential: true
			}),
		clearDefaultCacheReadCredential: ({ id }) =>
			Promise.resolve({ id, cache: { kind: 'default' }, hasCredential: false }),
		clearNamedCacheReadCredential: ({ id, cacheName }) =>
			Promise.resolve({
				id,
				cache: { kind: 'named', name: cacheName },
				hasCredential: false
			}),
		remove: ({ id }) => Promise.resolve({ id, status: 'offboarding' }),
		...overrides
	};
}

describe('parseQuotaBytes', () => {
	it.each([
		['0', 0],
		['1048576', 1_048_576]
	])('parses %s', (value, expected) => {
		expect(parseQuotaBytes(value)).toBe(expected);
	});

	it.each(['', '-1', '1.5', '1e3', String(Number.MAX_SAFE_INTEGER + 1)])(
		'refuses %j',
		(value) => {
			expect(() => parseQuotaBytes(value)).toThrow(InvalidQuotaBytesError);
		}
	);
});

describe('tenant argument error statuses', () => {
	it.each(['', '-1', '1.5', '1e3', String(Number.MAX_SAFE_INTEGER + 1)])(
		'explains the quota format and exits two for %j',
		(value) => {
			let failure: unknown;
			try {
				parseQuotaBytes(value);
			} catch (error) {
				failure = error;
			}
			expect({
				name: failure instanceof Error ? failure.name : undefined,
				message: failure instanceof Error ? failure.message : undefined,
				status: cliExitCode(failure, 130)
			}).toStrictEqual({
				name: 'InvalidQuotaBytesError',
				message: `Invalid quota bytes: ${value}. Pass a non-negative integer in bytes, such as 1048576 (at most ${String(Number.MAX_SAFE_INTEGER)}).`,
				status: 2
			});
		}
	);
	it('classifies a username without a credential as a usage error', () => {
		let failure: unknown;
		try {
			readCredentialFromOptions({ readUser: alice, readPassword: false });
		} catch (error) {
			failure = error;
		}
		expect({
			name: failure instanceof Error ? failure.name : undefined,
			status: cliExitCode(failure, 130)
		}).toStrictEqual({ name: 'ReadUserWithoutCredentialError', status: 2 });
	});
});

describe('readCredentialFromOptions', () => {
	it('creates the default fallback credential', () => {
		const selected = readCredentialFromOptions({});

		expect(selected).toStrictEqual({
			read: {
				user: defaultReadUser,
				password: selected.generatedPassword
			},
			generatedPassword: selected.generatedPassword
		});
		expect(selected.generatedPassword).toMatch(/^[A-Za-z0-9_-]{43}$/u);
	});

	it('uses a supplied fallback username', () => {
		const selected = readCredentialFromOptions({ readUser: alice });

		expect(selected.read?.user).toBe(alice);
		expect(selected.read?.password).toBe(selected.generatedPassword);
	});

	it('omits the fallback credential when disabled', () => {
		expect(readCredentialFromOptions({ readPassword: false })).toStrictEqual({
			read: undefined,
			generatedPassword: undefined
		});
	});

	it('refuses a username when credential generation is disabled', () => {
		expect(() =>
			readCredentialFromOptions({ readUser: alice, readPassword: false })
		).toThrow(ReadUserWithoutCredentialError);
	});
});

describe('runTenantCreate', () => {
	// A private default cache with neither its own credential nor the tenant
	// credential refuses every read, so the command says so.
	it('warns when a private default cache is created without a read credential', async () => {
		const rows: ResultRow[][] = [];
		const body = tenantCreateBodySchema.parse({
			id: acme,
			defaultCacheAccess: 'private',
			ownerIssuer: 'https://issuer.example',
			ownerSubject: 'owner',
			ownerAudience: 'cupboard'
		});

		await runTenantCreate(body, reporter(rows), {
			create: () => Promise.resolve(summary())
		});

		expect(rows).toStrictEqual([
			[
				{ label: 'Tenant', value: 'acme' },
				{ label: 'Status', value: 'Active' },
				{ label: 'Default cache access', value: 'private' },
				{
					label: 'Warning',
					value:
						'the private default cache has no read credential; it refuses every read until one is set'
				}
			]
		]);
	});

	it('prints a generated fallback credential once', async () => {
		const rows: ResultRow[][] = [];
		const body = tenantCreateBodySchema.parse({
			id: acme,
			defaultCacheAccess: 'public',
			ownerIssuer: 'https://issuer.example',
			ownerSubject: 'owner',
			ownerAudience: 'cupboard',
			read: { user: alice, password }
		});

		await runTenantCreate(
			body,
			reporter(rows),
			{ create: () => Promise.resolve(summary()) },
			{ generatedReadPassword: password }
		);

		expect(rows).toStrictEqual([
			[
				{ label: 'Tenant', value: 'acme' },
				{ label: 'Status', value: 'Active' },
				{ label: 'Default cache access', value: 'public' },
				{ label: 'Read user', raw: true, value: 'alice' },
				{ label: 'Read password', raw: true, value: password }
			]
		]);
	});

	const bodyWithPassword = tenantCreateBodySchema.parse({
		id: acme,
		defaultCacheAccess: 'public',
		ownerIssuer: 'https://issuer.example',
		ownerSubject: 'owner',
		ownerAudience: 'cupboard',
		read: { user: alice, password }
	});

	function unpublished(retryAfterSeconds: number): ORPCError<string, unknown> {
		return new ORPCError('TENANT_MEMBERSHIP_UNPUBLISHED', {
			status: 503,
			message: 'raw',
			data: { id: acme, retryAfterSeconds }
		});
	}

	// The options of a create with the generated password, which record each
	// wait that the command requests.
	function createOptions(sleeps: number[]): TenantCreateOptions {
		return {
			generatedReadPassword: password,
			sleep: (ms) => {
				sleeps.push(ms);

				return Promise.resolve();
			}
		};
	}

	// The deployment created the tenant but could not publish its membership.
	// The command repeats the identical request, with the same password, after
	// the delay that the deployment asked for.
	it('repeats the identical create after the requested delay when the membership is unpublished', async () => {
		const rows: ResultRow[][] = [];
		const requests: unknown[] = [];
		const sleeps: number[] = [];
		let refusals = 1;

		await runTenantCreate(
			bodyWithPassword,
			reporter(rows),
			{
				create: (body) => {
					requests.push(body);
					refusals -= 1;

					return refusals >= 0
						? Promise.reject(unpublished(5))
						: Promise.resolve(summary());
				}
			},
			createOptions(sleeps)
		);

		expect({ requests, sleeps, rows }).toStrictEqual({
			requests: [bodyWithPassword, bodyWithPassword],
			sleeps: [5000],
			rows: [
				[
					{ label: 'Tenant', value: 'acme' },
					{ label: 'Status', value: 'Active' },
					{ label: 'Default cache access', value: 'public' },
					{ label: 'Read user', raw: true, value: 'alice' },
					{ label: 'Read password', raw: true, value: password }
				]
			]
		});
	});

	const noteMatcher: unknown = expect.any(String);

	// The card that the command prints when the tenant may exist but the
	// command did not confirm it.
	const unconfirmedCredential: unknown[] = [
		{ label: 'Tenant', value: 'acme' },
		{ label: 'Read user', raw: true, value: 'alice' },
		{ label: 'Read password', raw: true, value: password },
		{ label: 'Note', value: noteMatcher }
	];

	// Every request gets the same answer. The command waits at most ten seconds
	// between requests. It prints the generated credential through the reporter,
	// and the error does not contain the password.
	it('prints the credential and throws TenantCreateIncompleteError when every create leaves the membership unpublished', async () => {
		const rows: ResultRow[][] = [];
		const requests: unknown[] = [];
		const sleeps: number[] = [];
		let failure: unknown;

		try {
			await runTenantCreate(
				bodyWithPassword,
				reporter(rows),
				{
					create: (body) => {
						requests.push(body);

						return Promise.reject(unpublished(30));
					}
				},
				createOptions(sleeps)
			);
		} catch (error) {
			failure = error;
		}

		expect({
			failure:
				failure instanceof TenantCreateIncompleteError
					? {
							name: failure.name,
							tenant: failure.tenant,
							attempts: failure.attempts,
							hasPrintedReadCredential: failure.hasPrintedReadCredential,
							exitCode: cliExitCode(failure, 130),
							containsPassword: errorChainText(failure).includes(password)
						}
					: failure,
			rows,
			requests,
			sleeps
		}).toStrictEqual({
			failure: {
				name: 'TenantCreateIncompleteError',
				tenant: acme,
				attempts: 3,
				hasPrintedReadCredential: true,
				exitCode: genericExitCode,
				containsPassword: false
			},
			rows: [unconfirmedCredential],
			requests: [bodyWithPassword, bodyWithPassword, bodyWithPassword],
			sleeps: [10_000, 10_000]
		});
	});

	// After an unpublished answer the tenant exists. A later failure becomes
	// TenantCreateIncompleteError with that failure as its cause. The command
	// prints the credential first, and it exits with the generic code.
	it.each([
		{
			failure: 'a lost connection',
			later: new TypeError('fetch failed')
		},
		{
			failure: 'an abort during the wait',
			later: new DOMException('The operation was aborted.', 'AbortError')
		}
	])(
		'prints the credential and throws TenantCreateIncompleteError for $failure after an unpublished answer',
		async ({ later }) => {
			const rows: ResultRow[][] = [];
			const sleeps: number[] = [];
			const answers = [unpublished(5), later];
			let failure: unknown;

			try {
				await runTenantCreate(
					bodyWithPassword,
					reporter(rows),
					{
						create: () =>
							Promise.reject(
								answers.shift() ?? new Error('the test ran out of answers')
							)
					},
					createOptions(sleeps)
				);
			} catch (error) {
				failure = error;
			}

			expect({
				failure:
					failure instanceof TenantCreateIncompleteError
						? {
								name: failure.name,
								tenant: failure.tenant,
								attempts: failure.attempts,
								hasPrintedReadCredential: failure.hasPrintedReadCredential,
								cause: failure.cause,
								exitCode: cliExitCode(failure, 130)
							}
						: failure,
				rows,
				sleeps
			}).toStrictEqual({
				failure: {
					name: 'TenantCreateIncompleteError',
					tenant: acme,
					attempts: 2,
					hasPrintedReadCredential: true,
					cause: later,
					exitCode: genericExitCode
				},
				rows: [unconfirmedCredential],
				sleeps: [5000]
			});
		}
	);

	// A 503 on the first request leaves the outcome unknown, so the command
	// prints the credential and throws the failure unchanged.
	it('prints the credential before it throws a 503 on the first request', async () => {
		const rows: ResultRow[][] = [];
		const unavailable = new ORPCError('SERVICE_UNAVAILABLE', {
			status: 503,
			message: 'raw'
		});

		await expect(
			runTenantCreate(
				bodyWithPassword,
				reporter(rows),
				{ create: () => Promise.reject(unavailable) },
				createOptions([])
			)
		).rejects.toBe(unavailable);
		expect(rows).toStrictEqual([unconfirmedCredential]);
	});

	// Without a session, the client fails before it sends the request, so the
	// tenant cannot exist and the command prints no credential.
	it('prints no credential when the create fails before a request is sent', async () => {
		const rows: ResultRow[][] = [];
		const noSession = new OwnerLoginRequiredError();
		const wasRequestSent = false;

		await expect(
			runTenantCreate(
				bodyWithPassword,
				reporter(rows),
				{ create: () => Promise.reject(noSession) },
				{ ...createOptions([]), wasRequestSent: () => wasRequestSent }
			)
		).rejects.toBe(noSession);
		expect({ rows, wasRequestSent }).toStrictEqual({
			rows: [],
			wasRequestSent: false
		});
	});

	it('neither repeats nor prints the credential for a create that the deployment refused for another reason', async () => {
		const conflict = new ORPCError('CONFLICT', { status: 409, message: 'raw' });
		const rows: ResultRow[][] = [];
		const requests: unknown[] = [];

		await expect(
			runTenantCreate(
				bodyWithPassword,
				reporter(rows),
				{
					create: (body) => {
						requests.push(body);

						return Promise.reject(conflict);
					}
				},
				{
					generatedReadPassword: password,
					sleep: () => Promise.reject(new Error('the command must not wait'))
				}
			)
		).rejects.toBe(conflict);
		expect({ requests, rows }).toStrictEqual({
			requests: [bodyWithPassword],
			rows: []
		});
	});
});

describe('runTenantList', () => {
	it.each(['summary', 'details', 'debug'] as const)(
		'keeps lifecycle versions in debug output only (%s)',
		async (presentation) => {
			const rows: ResultRow[][] = [];
			const response = tenantListResponseSchema.parse({
				tenants: [
					{ ...summary(), status: 'offboarding' },
					{ ...summary(), status: 'offboarded' }
				]
			});

			await runTenantList(
				{ ...reporter(rows), presentation },
				{
					list: () => Promise.resolve(response)
				}
			);

			expect(rows).toStrictEqual([
				[
					{
						label: 'acme',
						value:
							presentation === 'debug'
								? 'Removal in progress; config v3'
								: 'Removal in progress'
					},
					{
						label: 'acme',
						value: presentation === 'debug' ? 'Removed; config v3' : 'Removed'
					}
				]
			]);
		}
	);

	it('reports each tenant', async () => {
		const rows: ResultRow[][] = [];
		const response = tenantListResponseSchema.parse({
			tenants: [summary(), summary('suspended')]
		});

		await runTenantList(reporter(rows), {
			list: () => Promise.resolve(response)
		});

		expect(rows).toStrictEqual([
			[
				{ label: 'acme', value: 'Active' },
				{ label: 'acme', value: 'Suspended' }
			]
		]);
	});

	it('requests each page of the listing', async () => {
		const rows: ResultRow[][] = [];
		const requested: unknown[] = [];
		const pages = [
			tenantListResponseSchema.parse({ tenants: [summary()], cursor: 'acme' }),
			tenantListResponseSchema.parse({ tenants: [summary('suspended')] })
		];

		await runTenantList(reporter(rows), {
			list: (input) => {
				requested.push(input);

				return Promise.resolve(pages[requested.length - 1] ?? { tenants: [] });
			}
		});

		expect({ requested, rows }).toStrictEqual({
			requested: [{ limit: 200 }, { limit: 200, cursor: 'acme' }],
			rows: [
				[
					{ label: 'acme', value: 'Active' },
					{ label: 'acme', value: 'Suspended' }
				]
			]
		});
	});
});

describe('tenant state changes', () => {
	it('explains irreversible tenant removal before confirming', async () => {
		const { ui, captured } = fakeCliUi({ confirm: 'no' });

		await runTenantRemove(acme, ui, tenantClient({}));

		expect(captured.confirms).toStrictEqual([
			{
				message: 'Remove tenant acme?',
				detail:
					"New reads and writes stop immediately. The tenant's data is deleted over the following hours. Removal cannot be undone."
			}
		]);
	});
	const suspendMethod: 'suspend' | 'remove' = 'suspend';
	const offboardingOperation: 'suspend' | 'remove' = 'remove';

	it.each([
		{
			name: 'suspends',
			run: runTenantSuspend,
			result: tenantMutateResponseSchema.parse({
				id: acme,
				status: 'suspended'
			}),
			method: suspendMethod
		},
		{
			name: 'starts offboarding',
			run: runTenantRemove,
			result: tenantMutateResponseSchema.parse({
				id: acme,
				status: 'offboarding'
			}),
			method: offboardingOperation
		}
	])('$name after confirmation', async ({ run, result, method }) => {
		const { ui, captured } = fakeCliUi({ confirm: 'yes' });
		const calls: unknown[] = [];

		await run(
			acme,
			ui,
			tenantClient({
				[method]: (input: { id: typeof acme }) => {
					calls.push(input);
					return Promise.resolve(result);
				}
			})
		);

		expect({ calls, results: captured.results }).toStrictEqual({
			calls: [{ id: acme }],
			results: [
				{
					kind: 'tenant',
					title: 'Tenant',
					data: result,
					rows: [
						{
							label: acme,
							value:
								result.status === 'offboarding'
									? 'Removal in progress'
									: 'Suspended'
						}
					]
				}
			]
		});
	});

	it('keeps a tenant when suspension is declined', async () => {
		const { ui, captured } = fakeCliUi({ confirm: 'no' });

		await runTenantSuspend(acme, ui, tenantClient({}));

		expect(captured.cancellations).toStrictEqual([
			'The tenant was left running.'
		]);
	});

	it('resumes a tenant', async () => {
		const rows: ResultRow[][] = [];
		const result = tenantMutateResponseSchema.parse({
			id: acme,
			status: 'active'
		});

		await runTenantResume(acme, reporter(rows), {
			resume: () => Promise.resolve(result)
		});

		expect(rows).toStrictEqual([[{ label: 'acme', value: 'Active' }]]);
	});
});

describe('runTenantSetQuota', () => {
	it.each([
		{
			name: 'sets a limit',
			quota: { kind: 'limited', bytes: 5_000_000 } satisfies TenantQuota,
			label: '5 MB'
		},
		{
			name: 'clears the limit',
			quota: { kind: 'unlimited' } satisfies TenantQuota,
			label: 'unlimited'
		}
	])('$name and reports the charged bytes', async ({ quota, label }) => {
		const rows: ResultRow[][] = [];
		const calls: unknown[] = [];

		await runTenantSetQuota(acme, quota, reporter(rows), {
			setQuota: (input) => {
				calls.push(input);
				return Promise.resolve({ id: input.id, quota, usedBytes: 1_500_000 });
			}
		});

		expect({ calls, rows }).toStrictEqual({
			calls: [{ id: acme, quota }],
			rows: [
				[
					{ label: 'Tenant', value: 'acme' },
					{ label: 'Quota', value: label },
					{ label: 'Used', value: '1.5 MB' }
				]
			]
		});
	});
});

describe('runTenantQuota', () => {
	it.each([
		{
			name: 'a limit',
			quota: { kind: 'limited', bytes: 5_000_000 } satisfies TenantQuota,
			label: '5 MB'
		},
		{
			name: 'unlimited storage',
			quota: { kind: 'unlimited' } satisfies TenantQuota,
			label: 'unlimited'
		}
	])('reads $name without changing it', async ({ quota, label }) => {
		const rows: ResultRow[][] = [];
		const calls: unknown[] = [];

		await runTenantQuota(acme, reporter(rows), {
			getQuota: (input: { id: typeof acme }) => {
				calls.push(input);
				return Promise.resolve({ id: input.id, quota, usedBytes: 1_500_000 });
			}
		});

		expect({ calls, rows }).toStrictEqual({
			calls: [{ id: acme }],
			rows: [
				[
					{ label: 'Tenant', value: 'acme' },
					{ label: 'Quota', value: label },
					{ label: 'Used', value: '1.5 MB' }
				]
			]
		});
	});
});

describe('tenant fallback credential', () => {
	it('rotates the credential', async () => {
		const rows: ResultRow[][] = [];
		let call: Parameters<TenantClient['rotateReadCredential']>[0] | undefined;
		const result = tenantReadCredentialResponseSchema.parse({
			id: acme,
			hasCredential: true
		});

		await runTenantRotateCredential(acme, { readUser: alice }, reporter(rows), {
			rotateReadCredential: (input) => {
				call = input;
				return Promise.resolve(result);
			}
		});

		expect(call).toStrictEqual({
			id: acme,
			read: { user: alice, password: call?.read.password }
		});
		expect(call?.read.password).toMatch(/^[A-Za-z0-9_-]{43}$/u);
		expect(rows).toStrictEqual([
			[
				{ label: 'Tenant', value: 'acme' },
				{ label: 'Read user', raw: true, value: 'alice' },
				{ label: 'Read password', raw: true, value: call?.read.password }
			]
		]);
	});

	it('clears the credential', async () => {
		const rows: ResultRow[][] = [];
		const result = tenantReadCredentialResponseSchema.parse({
			id: acme,
			hasCredential: false
		});

		await runTenantClearCredential(acme, reporter(rows), {
			clearReadCredential: () => Promise.resolve(result)
		});

		expect(rows).toStrictEqual([
			[
				{ label: 'Tenant', value: 'acme' },
				{ label: 'Read credential', value: 'cleared' }
			]
		]);
	});
});

describe('cache read credentials', () => {
	const scopes: readonly { name: string; cache: CacheScope; label: string }[] =
		[
			{
				name: 'the default cache',
				cache: { kind: 'default' },
				label: '(default)'
			},
			{
				name: 'a named cache',
				cache: { kind: 'named', name: cacheNameSchema.parse('release') },
				label: 'release'
			}
		];

	function credentialClient(
		calls: unknown[],
		hasCredential: boolean
	): TenantClient {
		const respond = (cache: CacheScope) => (input: object) => {
			calls.push(input);

			return Promise.resolve(
				cacheReadCredentialResponseSchema.parse({
					id: acme,
					cache,
					hasCredential
				})
			);
		};
		const named: CacheScope = {
			kind: 'named',
			name: cacheNameSchema.parse('release')
		};

		return tenantClient({
			rotateDefaultCacheReadCredential: respond({ kind: 'default' }),
			rotateNamedCacheReadCredential: respond(named),
			clearDefaultCacheReadCredential: respond({ kind: 'default' }),
			clearNamedCacheReadCredential: respond(named)
		});
	}

	it.each(scopes)(
		'generates a password for $name and reports the value it sent',
		async ({ cache, label }) => {
			const calls: { read: { password: string } }[] = [];
			const rows: ResultRow[][] = [];

			await runTenantRotateCacheCredential(
				acme,
				cache,
				{ readUser: alice },
				reporter(rows),
				credentialClient(calls, true)
			);

			const sent = calls[0]?.read.password;

			expect(calls).toStrictEqual([
				{
					id: acme,
					...(cache.kind === 'named' && { cacheName: cache.name }),
					read: { user: alice, password: sent }
				}
			]);
			expect(sent).toMatch(/^[A-Za-z0-9_-]{43}$/u);
			expect(rows).toStrictEqual([
				[
					{ label: 'Tenant', value: 'acme' },
					{ label: 'Cache', value: label },
					{ label: 'Read user', raw: true, value: 'alice' },
					{ label: 'Read password', raw: true, value: sent }
				]
			]);
		}
	);

	it.each(scopes)(
		'clears the credential of $name and reports that the tenant credential applies',
		async ({ cache, label }) => {
			const calls: unknown[] = [];
			const rows: ResultRow[][] = [];

			await runTenantClearCacheCredential(
				acme,
				cache,
				reporter(rows),
				credentialClient(calls, false)
			);

			expect(calls).toStrictEqual([
				{ id: acme, ...(cache.kind === 'named' && { cacheName: cache.name }) }
			]);
			expect(rows).toStrictEqual([
				[
					{ label: 'Tenant', value: 'acme' },
					{ label: 'Cache', value: label },
					{
						label: 'Read credential',
						value: 'cleared; readers now use the tenant credential'
					}
				]
			]);
		}
	);
});
