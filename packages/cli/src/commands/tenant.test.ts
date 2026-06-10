import {
	type TenantCreateBody,
	tenantCreateBodySchema,
	type TenantListResponse,
	type TenantSummary
} from '@cupboard/protocol/tenants';
import type { Reporter, ResultRow } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import type { AccessCredential } from '../client/client.ts';

import {
	InvalidQuotaBytesError,
	parseQuotaBytes,
	readCredentialFromOptions,
	ReadCredentialIncompleteError,
	runTenantCreate,
	runTenantDelete,
	runTenantList,
	runTenantSuspend,
	type TenantClient
} from './tenant.ts';

function summary(overrides: Partial<TenantSummary>): TenantSummary {
	return {
		id: 'acme',
		status: 'active',
		readMode: 'private',
		ownerIssuer: 'https://idp.test',
		ownerSubject: 'owner',
		ownerAudience: 'aud',
		configVersion: 1,
		createdAt: '2026-01-01T00:00:00.000Z',
		...overrides
	};
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

function reporter(results: ResultRow[][]): Reporter {
	return {
		phase(_label, body) {
			return Promise.resolve(
				body({
					fact() {
						return;
					}
				})
			);
		},
		result(rows) {
			results.push([...rows]);
		},
		warn() {
			return;
		},
		info() {
			return;
		}
	};
}

function uncalled(): never {
	throw new Error('client should not be called');
}

function tenantClient(overrides: Partial<TenantClient>): TenantClient {
	return {
		createTenant: uncalled,
		listTenants: uncalled,
		suspendTenant: uncalled,
		deleteTenant: uncalled,
		...overrides
	};
}

describe('runTenantCreate', () => {
	it('warns when a private tenant is created without a read credential', async () => {
		const results: ResultRow[][] = [];
		const calls: TenantCreateBody[] = [];

		await runTenantCreate(
			createBody(),
			'admin-token',
			reporter(results),
			tenantClient({
				createTenant(_token, body) {
					calls.push(body);
					return Promise.resolve(summary({}));
				}
			})
		);

		expect({ sentId: calls[0]?.id, results }).toStrictEqual({
			sentId: 'acme',
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
			read: { user: 'alice', password: 'correct-horse-battery-staple' }
		});

		await runTenantCreate(
			body,
			'admin-token',
			reporter(results),
			tenantClient({
				createTenant(_token, sent) {
					calls.push(sent);
					return Promise.resolve(summary({}));
				}
			})
		);

		expect({ sentRead: calls[0]?.read, results }).toStrictEqual({
			sentRead: { user: 'alice', password: 'correct-horse-battery-staple' },
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
				password: 'correct-horse-battery-staple'
			}
		});

		await runTenantCreate(
			body,
			'admin-token',
			reporter(results),
			tenantClient({
				createTenant() {
					return Promise.resolve(summary({}));
				}
			}),
			'correct-horse-battery-staple'
		);

		expect(results).toStrictEqual([
			[
				{ label: 'Tenant', value: 'acme' },
				{ label: 'Status', value: 'active' },
				{ label: 'Read mode', value: 'private' },
				{ label: 'Read user', value: 'cupboard' },
				{ label: 'Read password', value: 'correct-horse-battery-staple' }
			]
		]);
	});
});

describe('readCredentialFromOptions', () => {
	it('uses an explicit read password with the given user', () => {
		expect(
			readCredentialFromOptions({
				readUser: 'alice',
				readPassword: 'correct-horse-battery-staple'
			})
		).toStrictEqual({
			read: { user: 'alice', password: 'correct-horse-battery-staple' },
			generatedPassword: undefined
		});
	});

	it('generates a private read password by default', () => {
		const selection = readCredentialFromOptions({});

		expect(selection.read?.user).toBe('cupboard');
		expect(selection.read?.password).toBe(selection.generatedPassword);
		expect(selection.generatedPassword).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});

	it('treats auto as explicit generation', () => {
		const selection = readCredentialFromOptions({
			readUser: 'alice',
			readPassword: 'auto'
		});

		expect(selection.read?.user).toBe('alice');
		expect(selection.read?.password).toBe(selection.generatedPassword);
		expect(selection.generatedPassword).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});

	it('does not generate for public tenants', () => {
		expect(readCredentialFromOptions({ public: true })).toStrictEqual({
			read: undefined,
			generatedPassword: undefined
		});
	});

	it('respects the no-read-password escape hatch', () => {
		expect(readCredentialFromOptions({ readPassword: false })).toStrictEqual({
			read: undefined,
			generatedPassword: undefined
		});
	});

	it('rejects a read user with no read password', () => {
		expect(() =>
			readCredentialFromOptions({ readUser: 'alice', readPassword: false })
		).toThrow(ReadCredentialIncompleteError);
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
			expect(() => parseQuotaBytes(source)).toThrow(InvalidQuotaBytesError);
		}
	);

	it('rejects unsafe integers', () => {
		expect(() => parseQuotaBytes('9007199254740992')).toThrow(
			InvalidQuotaBytesError
		);
	});
});

describe('runTenantList', () => {
	it('reports a row per tenant', async () => {
		const results: ResultRow[][] = [];
		const response: TenantListResponse = {
			tenants: [
				summary({ id: 'alpha' }),
				summary({ id: 'beta', status: 'suspended', readMode: 'public' })
			]
		};

		await runTenantList(
			'admin-token',
			reporter(results),
			tenantClient({ listTenants: () => Promise.resolve(response) })
		);

		expect(results).toStrictEqual([
			[
				{ label: 'alpha', value: 'active; private; config v1' },
				{ label: 'beta', value: 'suspended; public; config v1' }
			]
		]);
	});
});

describe('runTenantSuspend / runTenantDelete', () => {
	it.each([
		{
			name: 'suspend',
			run: runTenantSuspend,
			method: 'suspendTenant' as const,
			status: 'suspended' as const
		},
		{
			name: 'delete',
			run: runTenantDelete,
			method: 'deleteTenant' as const,
			status: 'offboarding' as const
		}
	])('$name reports the resulting status', async ({ run, method, status }) => {
		const results: ResultRow[][] = [];
		const calls: { token: AccessCredential; id: string }[] = [];

		await run(
			'acme',
			'admin-token',
			reporter(results),
			tenantClient({
				[method](token: AccessCredential, id: string) {
					calls.push({ token, id });
					return Promise.resolve({ id: 'acme', status });
				}
			})
		);

		expect({ calls, results }).toStrictEqual({
			calls: [{ token: 'admin-token', id: 'acme' }],
			results: [[{ label: 'acme', value: status }]]
		});
	});
});
