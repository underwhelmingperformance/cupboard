import {
	type TenantCreateBody,
	tenantCreateBodySchema,
	type TenantListResponse,
	type TenantSummary
} from '@cupboard/protocol/tenants';
import type { Reporter, ResultRow } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import {
	InvalidQuotaBytesError,
	parseQuotaBytes,
	readCredentialFromOptions,
	ReadCredentialIncompleteError,
	runTenantClearCredential,
	runTenantCreate,
	runTenantDelete,
	runTenantList,
	runTenantReadMode,
	runTenantResume,
	runTenantRotateCredential,
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
		create: uncalled,
		list: uncalled,
		suspend: uncalled,
		resume: uncalled,
		setReadMode: uncalled,
		rotateReadCredential: uncalled,
		clearReadCredential: uncalled,
		remove: uncalled,
		...overrides
	};
}

describe('runTenantCreate', () => {
	it('warns when a private tenant is created without a read credential', async () => {
		const results: ResultRow[][] = [];
		const calls: TenantCreateBody[] = [];

		await runTenantCreate(
			createBody(),
			reporter(results),
			tenantClient({
				create(body) {
					calls.push(body);
					return Promise.resolve(summary({}));
				}
			})
		);

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
			read: { user: 'alice', password: 'correct-horse-battery-staple' }
		});

		await runTenantCreate(
			body,
			reporter(results),
			tenantClient({
				create(sent) {
					calls.push(sent);
					return Promise.resolve(summary({}));
				}
			})
		);

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
				password: 'correct-horse-battery-staple'
			}
		});

		await runTenantCreate(
			body,
			reporter(results),
			tenantClient({
				create() {
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
			reporter(results),
			tenantClient({ list: () => Promise.resolve(response) })
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
			method: 'suspend' as const,
			status: 'suspended' as const
		},
		{
			name: 'delete',
			run: runTenantDelete,
			method: 'remove' as const,
			status: 'offboarding' as const
		}
	])('$name reports the resulting status', async ({ run, method, status }) => {
		const results: ResultRow[][] = [];
		const calls: { id: string }[] = [];

		await run(
			'acme',
			reporter(results),
			tenantClient({
				[method](input: { id: string }) {
					calls.push(input);
					return Promise.resolve({ id: 'acme', status });
				}
			})
		);

		expect({ calls, results }).toStrictEqual({
			calls: [{ id: 'acme' }],
			results: [[{ label: 'acme', value: status }]]
		});
	});
});

describe('runTenantResume', () => {
	it('reports the resumed status', async () => {
		const results: ResultRow[][] = [];
		const calls: { id: string }[] = [];

		await runTenantResume(
			'acme',
			reporter(results),
			tenantClient({
				resume(input) {
					calls.push(input);
					return Promise.resolve({ id: 'acme', status: 'active' });
				}
			})
		);

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

		await runTenantReadMode(
			'acme',
			'public',
			reporter(results),
			tenantClient({
				setReadMode(input) {
					calls.push(input);
					return Promise.resolve({ id: 'acme', readMode: 'public' });
				}
			})
		);

		expect({ calls, results }).toStrictEqual({
			calls: [{ id: 'acme', readMode: 'public' }],
			results: [[{ label: 'acme', value: 'public' }]]
		});
	});
});

describe('runTenantRotateCredential', () => {
	it('sends an explicit credential and shows the user without echoing the password', async () => {
		const results: ResultRow[][] = [];
		const calls: {
			id: string;
			read: { user: string; password: string };
		}[] = [];

		await runTenantRotateCredential(
			'acme',
			{ readUser: 'alice', readPassword: 'correct-horse-battery-staple' },
			reporter(results),
			tenantClient({
				rotateReadCredential(input) {
					calls.push(input);
					return Promise.resolve({ id: 'acme', readMode: 'private' });
				}
			})
		);

		expect({ calls, results }).toStrictEqual({
			calls: [
				{
					id: 'acme',
					read: { user: 'alice', password: 'correct-horse-battery-staple' }
				}
			],
			results: [
				[
					{ label: 'Tenant', value: 'acme' },
					{ label: 'Read mode', value: 'private' },
					{ label: 'Read user', value: 'alice' }
				]
			]
		});
	});

	it('generates a password by default and reports the same value it sends', async () => {
		const results: ResultRow[][] = [];
		const calls: {
			id: string;
			read: { user: string; password: string };
		}[] = [];

		await runTenantRotateCredential(
			'acme',
			{},
			reporter(results),
			tenantClient({
				rotateReadCredential(input) {
					calls.push(input);
					return Promise.resolve({ id: 'acme', readMode: 'private' });
				}
			})
		);

		// The generated password is sent to the server and printed to the operator,
		// so capture what was sent and assert the printed value is exactly it: an
		// operator shown a different value would hold a password that cannot
		// authenticate.
		const sentPassword = calls.at(0)?.read.password;

		expect(sentPassword).toMatch(/^[A-Za-z0-9_-]{43}$/);
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

		await runTenantRotateCredential(
			'acme',
			{ readUser: 'alice', readPassword: 'correct-horse-battery-staple' },
			reporter(results),
			tenantClient({
				rotateReadCredential() {
					return Promise.resolve({ id: 'acme', readMode: 'public' });
				}
			})
		);

		expect(results).toStrictEqual([
			[
				{ label: 'Tenant', value: 'acme' },
				{ label: 'Read mode', value: 'public' },
				{ label: 'Read user', value: 'alice' },
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

		await runTenantClearCredential(
			'acme',
			reporter(results),
			tenantClient({
				clearReadCredential(input) {
					calls.push(input);
					return Promise.resolve({ id: 'acme', readMode: 'private' });
				}
			})
		);

		expect({ calls, results }).toStrictEqual({
			calls: [{ id: 'acme' }],
			results: [[{ label: 'acme', value: 'private' }]]
		});
	});
});
