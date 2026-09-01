import {
	capturingReporter as reporter,
	fakeCliUi
} from '@cupboard/cli-ui/testing';
import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import {
	defaultReadUser,
	tenantCreateBodySchema,
	tenantListResponseSchema,
	tenantMutateResponseSchema,
	tenantReadCredentialResponseSchema,
	tenantSummarySchema
} from '@cupboard/protocol/tenants';
import type { ResultRow } from '@cupboard/reporter';
import { readUserInputSchema } from '@cupboard/shared/http';
import { describe, expect, it } from 'vitest';

import {
	InvalidQuotaBytesError,
	parseQuotaBytes,
	readCredentialFromOptions,
	ReadUserWithoutCredentialError,
	runTenantClearCredential,
	runTenantCreate,
	runTenantList,
	runTenantRemove,
	runTenantResume,
	runTenantRotateCredential,
	runTenantSuspend,
	type TenantClient
} from './tenant.ts';

const acme = tenantIdSchema.parse('acme');
const alice = readUserInputSchema.parse('alice');
const password = 'A'.repeat(43);

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
		rotateReadCredential: ({ id }) =>
			Promise.resolve({ id, hasCredential: true }),
		clearReadCredential: ({ id }) =>
			Promise.resolve({ id, hasCredential: false }),
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
	it('reports the initial access of the default cache', async () => {
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
				{ label: 'Status', value: 'active' },
				{ label: 'Default cache access', value: 'private' }
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
			password
		);

		expect(rows).toStrictEqual([
			[
				{ label: 'Tenant', value: 'acme' },
				{ label: 'Status', value: 'active' },
				{ label: 'Default cache access', value: 'public' },
				{ label: 'Read user', value: 'alice' },
				{ label: 'Read password', value: password }
			]
		]);
	});
});

describe('runTenantList', () => {
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
				{ label: 'acme', value: 'active; config v3' },
				{ label: 'acme', value: 'suspended; config v3' }
			]
		]);
	});
});

describe('tenant state changes', () => {
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
					data: result,
					rows: [{ label: acme, value: result.status }]
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

		expect(rows).toStrictEqual([[{ label: 'acme', value: 'active' }]]);
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
				{ label: 'Read user', value: 'alice' },
				{ label: 'Read password', value: call?.read.password }
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
