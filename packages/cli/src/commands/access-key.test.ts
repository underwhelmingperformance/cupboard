import {
	capturingReporter as reporter,
	fakeCliUi
} from '@cupboard/cli-ui/testing';
import {
	type AccessKeyCreateRequest,
	type AccessKeyCreateResponse,
	accessKeyIdSchema,
	accessKeySecretSchema,
	type AccessKeySummary
} from '@cupboard/protocol/access-keys';
import { oidcSubjectSchema, trustRuleIdSchema } from '@cupboard/protocol/oidc';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { refreshSessionIdSchema } from '@cupboard/protocol/sessions';
import type { ResultRow } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import {
	type AccessKeyClient,
	accessKeyExpiry,
	AccessKeyExpiryChoiceError,
	accessKeyGrants,
	AccessKeyGrantsConflictError,
	InvalidAccessKeyExpiryError,
	InvalidAccessKeyGrantsError,
	InvalidAccessKeyIdError,
	InvalidAccessKeyResourceError,
	parseAccessKeyId,
	runAccessKeyCreate,
	runAccessKeyDelete,
	runAccessKeyList
} from './access-key.ts';
import {
	ContentReadRootSelectionError,
	RootBindingRequiredError,
	UnknownAllowError
} from './oidc-trust/rule-builder.ts';

const keyId = accessKeyIdSchema.parse('00000000-0000-4000-8000-000000000001');
const secret = accessKeySecretSchema.parse(
	`cupboard_ak_${keyId}_${'a'.repeat(64)}`
);
const createdAt = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');
const expiresAt = isoTimestampSchema.parse('2026-02-01T00:00:00.000Z');
const subject = oidcSubjectSchema.parse('alice');
const readDefault = {
	type: 'cupboard_cache' as const,
	actions: ['cache:content-read' as const],
	cache: { kind: 'default' as const }
};

function summary(overrides: Partial<AccessKeySummary> = {}): AccessKeySummary {
	return {
		id: keyId,
		grants: [readDefault],
		subject,
		createdAt,
		...overrides
	};
}

function accessKeyClient(
	overrides: Partial<AccessKeyClient> = {}
): AccessKeyClient {
	return {
		create: () => Promise.resolve({ ...summary(), secret }),
		list: () => Promise.resolve({ accessKeys: [], unreadableAccessKeys: [] }),
		delete: ({ id }) => Promise.resolve({ id, deleted: false }),
		...overrides
	};
}

describe('accessKeyGrants', () => {
	it.each([
		{
			name: 'a read of the default cache',
			options: { allow: ['read'] },
			grants: [readDefault]
		},
		{
			name: 'publication and reads of a named cache',
			options: { allow: ['push', 'read'], cache: 'builds' },
			grants: [
				{
					type: 'cupboard_cache',
					actions: [
						'upload:negotiate',
						'upload:status',
						'upload:commit',
						'upload:confirm'
					],
					cache: { kind: 'named', name: 'builds' }
				},
				{
					type: 'cupboard_cache',
					actions: ['cache:content-read'],
					cache: { kind: 'named', name: 'builds' }
				}
			]
		},
		{
			name: 'root updates under a root prefix',
			options: { allow: ['root'], root: 'github:acme/app/' },
			grants: [
				{
					type: 'cupboard_cache',
					actions: ['root:set', 'root:list'],
					cache: { kind: 'default' },
					root: 'github:acme/app/'
				}
			]
		},
		{
			name: 'a read of a reuse view',
			options: { allow: [], view: 'everything' },
			grants: [
				{
					type: 'cupboard_view',
					actions: ['view:content-read'],
					view: 'everything'
				}
			]
		}
	])('builds $name', ({ options, grants }) => {
		expect(accessKeyGrants(options)).toStrictEqual(grants);
	});

	it.each([
		{
			name: 'root operations without a root',
			options: { allow: ['root'] },
			error: RootBindingRequiredError
		},
		{
			name: 'a read restricted to a root',
			options: { allow: ['read'], root: 'github:acme/app' },
			error: ContentReadRootSelectionError
		},
		{
			name: 'an unknown shorthand',
			options: { allow: ['everything'] },
			error: UnknownAllowError
		}
	])('refuses $name', ({ options, error }) => {
		expect(() => accessKeyGrants(options)).toThrow(error);
	});

	it.each([
		{ name: '--allow', options: { allow: ['read'] } },
		{ name: '--cache', options: { allow: [], cache: 'release' } },
		{ name: '--root', options: { allow: [], root: 'main' } },
		{ name: '--view', options: { allow: [], view: 'shared' } }
	])('refuses a grants document together with $name', ({ options }) => {
		let error: unknown;

		try {
			accessKeyGrants({ ...options, grants: JSON.stringify([readDefault]) });
		} catch (error_) {
			error = error_;
		}

		expect(error instanceof AccessKeyGrantsConflictError).toBe(true);
	});

	it('reads the grants from a document', () => {
		expect(
			accessKeyGrants({ allow: [], grants: JSON.stringify([readDefault]) })
		).toStrictEqual([readDefault]);
	});
	it.each([
		{ name: 'a cache name', options: { allow: ['read'], cache: 'Bad Name' } },
		{ name: 'a reuse view name', options: { allow: [], view: 'Bad View!' } }
	])('refuses an invalid $name with a usage error', ({ options }) => {
		let error: unknown;

		try {
			accessKeyGrants(options);
		} catch (error_) {
			error = error_;
		}

		expect(error instanceof InvalidAccessKeyResourceError).toBe(true);
	});

	it.each([
		{ name: 'text that is not JSON', grants: 'not json' },
		{ name: 'JSON that is not a list of grants', grants: '{"type":"x"}' }
	])('refuses a grants document of $name with a usage error', ({ grants }) => {
		expect(() => accessKeyGrants({ allow: [], grants })).toThrow(
			InvalidAccessKeyGrantsError
		);
	});
});

describe('parseAccessKeyId', () => {
	it('accepts an access key ID and refuses other text with a usage error', () => {
		expect({
			id: parseAccessKeyId(keyId),
			other: (() => {
				try {
					return parseAccessKeyId('1234');
				} catch (error: unknown) {
					return error instanceof InvalidAccessKeyIdError;
				}
			})()
		}).toStrictEqual({ id: keyId, other: true });
	});
});

describe('accessKeyExpiry', () => {
	const now = new Date('2026-01-01T00:00:00.000Z');

	it.each([
		{
			name: 'a duration',
			options: { expiresIn: '30d', expiry: true },
			expected: '2026-01-31T00:00:00.000Z'
		},
		{
			name: 'a time',
			options: { expiresAt: '2026-03-01T12:00:00Z', expiry: true },
			expected: '2026-03-01T12:00:00.000Z'
		},
		{ name: 'no expiry', options: { expiry: false }, expected: undefined }
	])('accepts $name', ({ options, expected }) => {
		expect(accessKeyExpiry(options, now)).toBe(expected);
	});

	it.each([
		{ name: 'no choice', options: { expiry: true } },
		{
			name: 'a duration and no expiry',
			options: { expiresIn: '1d', expiry: false }
		},
		{
			name: 'a duration and a time',
			options: {
				expiresIn: '1d',
				expiresAt: '2026-03-01T12:00:00Z',
				expiry: true
			}
		}
	])('refuses $name', ({ options }) => {
		expect(() => accessKeyExpiry(options, now)).toThrow(
			AccessKeyExpiryChoiceError
		);
	});
	it.each(['2026-12-31', '12/31/2026', 'Dec 31 2026', '2026-12-31T00:00:00'])(
		'refuses %s, which is not an ISO 8601 date and time in UTC',
		(expiresAt) => {
			expect(() => accessKeyExpiry({ expiresAt, expiry: true }, now)).toThrow(
				InvalidAccessKeyExpiryError
			);
		}
	);
});

describe('runAccessKeyCreate', () => {
	it('sends the request and reports the secret once', async () => {
		const results: ResultRow[][] = [];
		const infos: string[] = [];
		const requests: AccessKeyCreateRequest[] = [];
		const created: AccessKeyCreateResponse = {
			...summary({ expiresAt }),
			secret
		};
		const request: AccessKeyCreateRequest = {
			grants: [readDefault],
			expiresAt
		};

		await runAccessKeyCreate(
			request,
			reporter(results, infos),
			accessKeyClient({
				create: (input) => {
					requests.push(input);
					return Promise.resolve(created);
				}
			})
		);

		expect({ requests, results, infos }).toStrictEqual({
			requests: [request],
			results: [
				[
					{ label: 'Access key', value: keyId },
					{
						label: 'Grant',
						value: "Tenant's default cache: read cached content"
					},
					{ label: 'Expires', value: '2026-02-01 00:00 UTC' },
					{ label: 'Secret', value: secret, raw: true }
				]
			],
			infos: [
				'Save the secret now. cupboard does not store it and cannot show it again.'
			]
		});
	});
});

describe('runAccessKeyList', () => {
	it('follows every page and reports the keys in creation order', async () => {
		const results: ResultRow[][] = [];
		const requests: unknown[] = [];
		const laterId = accessKeyIdSchema.parse(
			'00000000-0000-4000-8000-000000000000'
		);
		const later = isoTimestampSchema.parse('2026-01-02T00:00:00.000Z');

		await runAccessKeyList(
			reporter(results),
			accessKeyClient({
				list: (input) => {
					requests.push(input);

					return Promise.resolve(
						input.cursor === undefined
							? {
									accessKeys: [summary({ id: laterId, createdAt: later })],
									unreadableAccessKeys: [],
									cursor: laterId
								}
							: { accessKeys: [summary()], unreadableAccessKeys: [] }
					);
				}
			})
		);

		expect({
			requests,
			labels: results.map((rows) => rows.map((row) => row.label))
		}).toStrictEqual({
			requests: [{}, { cursor: laterId }],
			labels: [[keyId, laterId]]
		});
	});

	it('reports each key with its grants, parent, rule and expiry, and marks an unreadable key', async () => {
		const results: ResultRow[][] = [];
		const childId = accessKeyIdSchema.parse(
			'00000000-0000-4000-8000-000000000002'
		);
		const unreadableId = accessKeyIdSchema.parse(
			'00000000-0000-4000-8000-000000000003'
		);
		const sessionId = refreshSessionIdSchema.parse(
			'00000000-0000-4000-8000-0000000000aa'
		);

		await runAccessKeyList(
			reporter(results),
			accessKeyClient({
				list: () =>
					Promise.resolve({
						accessKeys: [
							summary({ rule: trustRuleIdSchema.parse('owner') }),
							summary({
								id: childId,
								parent: { kind: 'access-key', id: keyId },
								expiresAt
							})
						],
						unreadableAccessKeys: [
							{
								id: unreadableId,
								parent: { kind: 'session', id: sessionId },
								subject,
								createdAt
							}
						]
					})
			})
		);

		expect(results).toStrictEqual([
			[
				{
					label: keyId,
					value:
						"Tenant's default cache: read cached content; subject alice; rule owner; created 2026-01-01 00:00 UTC; does not expire"
				},
				{
					label: childId,
					value: `Tenant's default cache: read cached content; subject alice; created by access key ${keyId}; created 2026-01-01 00:00 UTC; expires 2026-02-01 00:00 UTC`
				},
				{
					label: unreadableId,
					value: `grants that this deployment cannot read; it refuses the key; subject alice; created in sign-in session ${sessionId}; created 2026-01-01 00:00 UTC; does not expire`
				}
			]
		]);
	});
});

describe('runAccessKeyDelete', () => {
	it.each([
		{ deleted: true, value: 'access key and the keys below it deleted' },
		{ deleted: false, value: 'access key not found' }
	])('reports deleted=$deleted once confirmed', async ({ deleted, value }) => {
		const { ui, captured } = fakeCliUi({ confirm: 'yes' });

		await runAccessKeyDelete(
			keyId,
			ui,
			accessKeyClient({
				delete: ({ id }) => Promise.resolve({ id, deleted })
			})
		);

		expect({
			confirms: captured.confirms.map((confirm) => confirm.message),
			rows: captured.results.map((result) => result.rows)
		}).toStrictEqual({
			confirms: [`Delete access key ${keyId} and the keys below it?`],
			rows: [
				[
					{ label: 'Access key', value: keyId },
					{ label: 'Outcome', value }
				]
			]
		});
	});

	it('leaves the key in place when the deletion is declined', async () => {
		const { ui, captured } = fakeCliUi({ confirm: 'no' });
		const deletions: string[] = [];

		await runAccessKeyDelete(
			keyId,
			ui,
			accessKeyClient({
				delete: ({ id }) => {
					deletions.push(id);
					return Promise.resolve({ id, deleted: true });
				}
			})
		);

		expect({
			deletions,
			results: captured.results,
			cancellations: captured.cancellations
		}).toStrictEqual({
			deletions: [],
			results: [],
			cancellations: ['The access key was left in place.']
		});
	});
});
