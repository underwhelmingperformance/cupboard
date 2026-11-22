import {
	capturingReporter as reporter,
	fakeCliUi
} from '@cupboard/cli-ui/testing';
import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import {
	tenantCreateBodySchema,
	tenantListResponseSchema,
	tenantMutateResponseSchema,
	type TenantQuota,
	tenantSummarySchema
} from '@cupboard/protocol/tenants';
import type { ResultRow } from '@cupboard/reporter';
import { genericExitCode } from '@cupboard/shared/errors';
import { ORPCError } from '@orpc/client';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { cliExitCode } from '../cli.ts';
import { TenantCreateIncompleteError } from '../errors.ts';

import {
	InvalidQuotaBytesError,
	parseQuotaBytes,
	registerTenantCommands,
	runTenantCreate,
	runTenantList,
	runTenantQuota,
	runTenantRemove,
	runTenantResume,
	runTenantSetQuota,
	runTenantSuspend,
	type TenantClient,
	type TenantCreateOptions
} from './tenant.ts';

const acme = tenantIdSchema.parse('acme');

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

function tenantClient(overrides: Partial<TenantClient>): TenantClient {
	return {
		list: () => Promise.resolve({ tenants: [] }),
		create: () => Promise.resolve(summary()),
		suspend: ({ id }) => Promise.resolve({ id, status: 'suspended' }),
		resume: ({ id }) => Promise.resolve({ id, status: 'active' }),
		getQuota: ({ id }) =>
			Promise.resolve({ id, quota: { kind: 'unlimited' }, usedBytes: 0 }),
		setQuota: ({ id, quota }) => Promise.resolve({ id, quota, usedBytes: 0 }),
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
});

// The options of a create that record each wait that the command requests.
function createOptions(sleeps: number[]): TenantCreateOptions {
	return {
		sleep: (ms) => {
			sleeps.push(ms);

			return Promise.resolve();
		}
	};
}

describe('runTenantCreate', () => {
	it('reports the created tenant', async () => {
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
				{ label: 'Default cache access', value: 'private' }
			]
		]);
	});

	const tenantBody = tenantCreateBodySchema.parse({
		id: acme,
		defaultCacheAccess: 'public',
		ownerIssuer: 'https://issuer.example',
		ownerSubject: 'owner',
		ownerAudience: 'cupboard'
	});

	function unpublished(retryAfterSeconds: number): ORPCError<string, unknown> {
		return new ORPCError('TENANT_MEMBERSHIP_UNPUBLISHED', {
			status: 503,
			message: 'raw',
			data: { id: acme, retryAfterSeconds }
		});
	}

	// The deployment created the tenant but could not publish its membership.
	// The command repeats the identical request after the delay that the
	// deployment asked for.
	it('repeats the identical create after the requested delay when the membership is unpublished', async () => {
		const rows: ResultRow[][] = [];
		const requests: unknown[] = [];
		const sleeps: number[] = [];
		let refusals = 1;

		await runTenantCreate(
			tenantBody,
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
			requests: [tenantBody, tenantBody],
			sleeps: [5000],
			rows: [
				[
					{ label: 'Tenant', value: 'acme' },
					{ label: 'Status', value: 'Active' },
					{ label: 'Default cache access', value: 'public' }
				]
			]
		});
	});

	// Every request gets the same answer. The command waits at most ten seconds
	// between requests.
	it('throws TenantCreateIncompleteError when every create leaves the membership unpublished', async () => {
		const rows: ResultRow[][] = [];
		const requests: unknown[] = [];
		const sleeps: number[] = [];
		let failure: unknown;

		try {
			await runTenantCreate(
				tenantBody,
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
							exitCode: cliExitCode(failure, 130)
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
				exitCode: genericExitCode
			},
			rows: [],
			requests: [tenantBody, tenantBody, tenantBody],
			sleeps: [10_000, 10_000]
		});
	});

	// After an unpublished answer the tenant exists. A later failure becomes
	// TenantCreateIncompleteError with that failure as its cause.
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
		'throws TenantCreateIncompleteError for $failure after an unpublished answer',
		async ({ later }) => {
			const sleeps: number[] = [];
			const answers = [unpublished(5), later];
			let failure: unknown;

			try {
				await runTenantCreate(
					tenantBody,
					reporter([]),
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
								cause: failure.cause,
								exitCode: cliExitCode(failure, 130)
							}
						: failure,
				sleeps
			}).toStrictEqual({
				failure: {
					name: 'TenantCreateIncompleteError',
					tenant: acme,
					attempts: 2,
					cause: later,
					exitCode: genericExitCode
				},
				sleeps: [5000]
			});
		}
	);

	it('does not repeat a create that the deployment refused for another reason', async () => {
		const conflict = new ORPCError('CONFLICT', { status: 409, message: 'raw' });
		const requests: unknown[] = [];

		await expect(
			runTenantCreate(
				tenantBody,
				reporter([]),
				{
					create: (body) => {
						requests.push(body);

						return Promise.reject(conflict);
					}
				},
				{
					sleep: () => Promise.reject(new Error('the command must not wait'))
				}
			)
		).rejects.toBe(conflict);
		expect(requests).toStrictEqual([tenantBody]);
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
