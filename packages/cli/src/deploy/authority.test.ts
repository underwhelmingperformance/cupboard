import { readdir, readFile } from 'node:fs/promises';
import process from 'node:process';

import {
	oidcAudienceSchema,
	oidcIssuerSchema,
	oidcSubjectSchema
} from '@cupboard/protocol/oidc';
import { describe, expect, it } from 'vitest';

import {
	AdminDatabaseMismatchError,
	type AuthorityDeployment,
	type AuthorityEffects,
	type BoundDatabase,
	decideAuthority,
	type DeployAuthority,
	GlobalAdminRowInvalidError,
	readGlobalAdmin,
	renewingIdToken
} from './authority.ts';
import type { CloudflareApi } from './cloudflare-api.ts';
import { type DatabaseId, databaseIdSchema } from './identifiers.ts';
import { parseD1Migrations } from './migrations.ts';
import {
	adminLoginCommand,
	ClaimTokenUnusableError,
	type OwnerBinding
} from './owner.ts';
import { claimSecretSchema } from './secrets.ts';

function owner(
	issuer: string,
	subject: string,
	audience?: string
): OwnerBinding {
	return {
		issuer: oidcIssuerSchema.parse(issuer),
		subject: oidcSubjectSchema.parse(subject),
		...(audience !== undefined && {
			audience: oidcAudienceSchema.parse(audience)
		})
	};
}

const admin = owner(
	'https://dash.cloudflare.com',
	'cf-user-1',
	'cupboard-client'
);

function segment(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function jwt(claims: Record<string, unknown>): string {
	return `${segment({ alg: 'none' })}.${segment(claims)}.`;
}

async function rejectionOf(pending: Promise<unknown>): Promise<unknown> {
	try {
		await pending;
	} catch (error) {
		return error;
	}

	return undefined;
}

function rows(answers: readonly (readonly string[])[]): {
	queryRows(id: DatabaseId, sql: string): Promise<readonly string[]>;
} {
	const remaining = [...answers];

	return {
		queryRows: () => Promise.resolve(remaining.shift() ?? [])
	};
}

const claimToken = jwt({
	iss: 'https://dash.cloudflare.com',
	sub: 'cf-user-1',
	aud: 'cupboard-client'
});
const nowMs = Date.parse('2026-09-25T12:00:00Z');
/**
 * A control database as the deploy reads it before any change: whether the
 * database exists, whether it has the `global_admin` table yet, and its row.
 */
interface ControlDatabase {
	readonly exists: boolean;
	readonly hasAdminTable: boolean;
	readonly adminRow: string | undefined;
}

type ApiRead = Pick<CloudflareApi, 'findD1Database' | 'd1QueryRows'>;

const adminColumns = ['id', 'issuer', 'subject', 'claimed_at', 'audience'];

// Each database's id is its name, so the calls identify the database.
function controlDatabaseApi(
	databases: Readonly<Record<string, ControlDatabase>>,
	calls: string[]
): ApiRead {
	return {
		findD1Database: (name) => {
			calls.push(`findD1Database:${name}`);
			return Promise.resolve(
				databases[name]?.exists === true
					? databaseIdSchema.parse(name)
					: undefined
			);
		},
		d1QueryRows: (id, sql) => {
			const isColumnsQuery = sql.includes('pragma_table_info');
			const database = databases[id];
			calls.push(`d1QueryRows:${id}:${isColumnsQuery ? 'columns' : 'admin'}`);

			if (isColumnsQuery) {
				return Promise.resolve(
					database?.hasAdminTable === true ? adminColumns : []
				);
			}

			return Promise.resolve(
				database?.adminRow === undefined ? [] : [database.adminRow]
			);
		}
	};
}

const claimedDatabase: ControlDatabase = {
	exists: true,
	hasAdminTable: true,
	adminRow: JSON.stringify([admin.issuer, admin.subject, admin.audience])
};
const emptyDatabase: ControlDatabase = {
	exists: true,
	hasAdminTable: true,
	adminRow: undefined
};
const claimedReads = [
	'findD1Database:cupboard',
	'd1QueryRows:cupboard:columns',
	'd1QueryRows:cupboard:admin'
];

interface Harness {
	readonly deployment: AuthorityDeployment;
	readonly effects: AuthorityEffects;
	readonly calls: string[];
}

const boundCupboard: BoundDatabase = {
	id: databaseIdSchema.parse('cupboard'),
	name: 'cupboard'
};

function harness(options: {
	readonly database?: ControlDatabase;
	readonly boundDatabase?: BoundDatabase | undefined;
	readonly plannedDatabaseName?: string;
	readonly interactive?: boolean;
	readonly idToken?: string;
}): Harness {
	const calls: string[] = [];
	const database = options.database ?? emptyDatabase;

	return {
		calls,
		deployment: {
			boundDatabase:
				'boundDatabase' in options
					? options.boundDatabase
					: database.exists
						? boundCupboard
						: undefined,
			plannedDatabaseName: options.plannedDatabaseName ?? 'cupboard',
			interactive: options.interactive ?? true
		},
		effects: {
			api: controlDatabaseApi({ cupboard: database }, calls),
			idToken: () => {
				calls.push('login');
				return Promise.resolve(options.idToken ?? claimToken);
			},
			generateClaimSecret: () => {
				calls.push('generateClaimSecret');
				return claimSecretSchema.parse('claim-1');
			}
		}
	};
}

function describeAuthority(authority: DeployAuthority): unknown {
	switch (authority.kind) {
		case 'bootstrap': {
			return {
				kind: authority.kind,
				claimSecret: authority.claimSecret,
				claimant: authority.claimant
			};
		}
		case 'admin': {
			return { kind: authority.kind, admin: authority.admin };
		}
		case 'unclaimed': {
			return { kind: authority.kind };
		}
	}
}

const claimant = {
	issuer: 'https://dash.cloudflare.com',
	subject: 'cf-user-1',
	audience: 'cupboard-client',
	displayName: 'cf-user-1'
};

describe('decideAuthority', () => {
	it.each([
		{
			name: 'a fresh account, with no control Worker or database',
			database: { exists: false, hasAdminTable: false, adminRow: undefined },
			reads: ['findD1Database:cupboard']
		},
		{
			name: 'a database from before the global_admin table',
			database: { exists: true, hasAdminTable: false, adminRow: undefined },
			reads: ['findD1Database:cupboard', 'd1QueryRows:cupboard:columns']
		},
		{
			// A deployment uploaded without a claim, or one whose deploy stopped
			// between setting the secret and claiming, has no row in the table.
			name: 'a deployment with Workers but no admin',
			database: emptyDatabase,
			reads: claimedReads
		}
	])(
		'claims $name, logging in before anything changes',
		async ({ database, reads }) => {
			const { deployment, effects, calls } = harness({ database });

			const authority = await decideAuthority(deployment, effects);

			expect({
				authority: describeAuthority(authority),
				calls
			}).toStrictEqual({
				authority: { kind: 'bootstrap', claimSecret: 'claim-1', claimant },
				calls: [...reads, 'login', 'generateClaimSecret']
			});
		}
	);

	it('leaves a first deploy without a terminal unclaimed, without a login or a secret', async () => {
		const { deployment, effects, calls } = harness({ interactive: false });

		const authority = await decideAuthority(deployment, effects);

		expect({ authority: describeAuthority(authority), calls }).toStrictEqual({
			authority: { kind: 'unclaimed' },
			calls: claimedReads
		});
	});

	it.each([
		{
			name: 'no issuer',
			claims: { sub: 'founder', aud: 'cupboard-client' },
			problem: 'issuer'
		},
		{
			name: 'an HTTP issuer on a public host',
			claims: {
				iss: 'http://idp.example.test',
				sub: 'founder',
				aud: 'cupboard-client'
			},
			problem: 'issuer'
		},
		{
			// A deployed Worker accepts loopback HTTP only in local development.
			name: 'an HTTP issuer on a loopback host',
			claims: {
				iss: 'http://127.0.0.1:8787',
				sub: 'founder',
				aud: 'cupboard-client'
			},
			problem: 'issuer'
		},
		{
			name: 'no subject',
			claims: { iss: 'https://idp.example.test', aud: 'cupboard-client' },
			problem: 'subject'
		},
		{
			name: 'two audiences',
			claims: {
				iss: 'https://idp.example.test',
				sub: 'founder',
				aud: ['cupboard-client', 'other-client']
			},
			problem: 'audience'
		},
		{
			name: 'no audience',
			claims: { iss: 'https://idp.example.test', sub: 'founder' },
			problem: 'audience'
		}
	])(
		'refuses to claim with an id_token that has $name, before any change',
		async ({ claims, problem }) => {
			const { deployment, effects, calls } = harness({ idToken: jwt(claims) });

			const refusal = await rejectionOf(decideAuthority(deployment, effects));

			expect({
				refusal:
					refusal instanceof ClaimTokenUnusableError
						? { problem: refusal.problem }
						: refusal,
				secrets: calls.filter((call) => call === 'generateClaimSecret')
			}).toStrictEqual({ refusal: { problem }, secrets: [] });
		}
	);

	it('updates a deployment whose database records an admin', async () => {
		const { deployment, effects, calls } = harness({
			database: claimedDatabase,
			interactive: false
		});

		const authority = await decideAuthority(deployment, effects);

		expect({ authority: describeAuthority(authority), calls }).toStrictEqual({
			authority: { kind: 'admin', admin },
			calls: claimedReads
		});
	});

	it("claims with the identity in the operator's id_token", async () => {
		const { deployment, effects } = harness({
			idToken: jwt({
				iss: 'https://idp.example.test',
				sub: 'founder',
				aud: ['cupboard-cli'],
				email: 'ada@example.com'
			})
		});

		const authority = await decideAuthority(deployment, effects);

		expect(describeAuthority(authority)).toStrictEqual({
			kind: 'bootstrap',
			claimSecret: 'claim-1',
			claimant: {
				issuer: 'https://idp.example.test',
				subject: 'founder',
				audience: 'cupboard-cli',
				displayName: 'ada@example.com'
			}
		});
	});
});

const migrationsDirectory = new URL(
	'../../../server/drizzle-d1/',
	import.meta.url
);

/**
 * An in-memory SQLite database with the D1 migrations applied up to, but not
 * including, `before`.
 */
async function migratedDatabase(
	before: string
): Promise<import('node:sqlite').DatabaseSync> {
	const entries = await readdir(migrationsDirectory);
	const names = entries.filter(
		(name) => name.endsWith('.sql') && name < before
	);
	const files = await Promise.all(
		names.map(async (name) => ({
			name,
			sql: await readFile(new URL(name, migrationsDirectory), 'utf8')
		}))
	);
	const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
	const database = new DatabaseSync(':memory:');

	for (const migration of parseD1Migrations(files)) {
		for (const statement of migration.statements) {
			database.exec(statement);
		}
	}

	return database;
}

/**
 * Runs each query on `database` and returns the first column of each row as
 * `d1QueryRows` does.
 */
function sqliteRows(database: import('node:sqlite').DatabaseSync): {
	queryRows(id: DatabaseId, sql: string): Promise<readonly string[]>;
} {
	return {
		queryRows: (_id, sql) =>
			Promise.resolve(
				database
					.prepare(sql)
					.all()
					.flatMap((row) => {
						const [value] = Object.values(row);

						return typeof value === 'string' ? [value] : [];
					})
			)
	};
}

const seededAdmin =
	"INSERT INTO global_admin (id, issuer, subject, claimed_at, audience) VALUES ('singleton', 'https://dash.cloudflare.com', 'cf-user-1', '2026-06-01T00:00:00Z', 'cupboard-client')";

// The deployed Workers are bound to `cupboard`, and the plan selects `fresh`.
async function decideWith(seeded: {
	readonly bound: boolean;
	readonly planned: boolean;
}): Promise<unknown> {
	const bound = await migratedDatabase('9999');
	const planned = await migratedDatabase('9999');

	try {
		if (seeded.bound) {
			bound.exec(seededAdmin);
		}

		if (seeded.planned) {
			planned.exec(seededAdmin);
		}

		const databases = new Map([
			['cupboard', sqliteRows(bound)],
			['fresh', sqliteRows(planned)]
		]);
		const { deployment, effects } = harness({
			boundDatabase: boundCupboard,
			plannedDatabaseName: 'fresh'
		});

		try {
			return describeAuthority(
				await decideAuthority(deployment, {
					...effects,
					api: {
						findD1Database: (name) =>
							Promise.resolve(databaseIdSchema.parse(name)),
						d1QueryRows: async (id, sql) => [
							...((await databases.get(id)?.queryRows(id, sql)) ?? [])
						]
					}
				})
			);
		} catch (error) {
			return error instanceof AdminDatabaseMismatchError
				? {
						boundDatabase: error.boundDatabase,
						plannedDatabase: error.plannedDatabase,
						admin: error.admin,
						recordedIn: error.recordedIn
					}
				: error;
		}
	} finally {
		bound.close();
		planned.close();
	}
}

describe('decideAuthority with two control databases', () => {
	it.each([
		{
			name: 'the bound database',
			bound: true,
			planned: false,
			recordedIn: 'bound'
		},
		{
			name: 'the planned database',
			bound: false,
			planned: true,
			recordedIn: 'planned'
		},
		{ name: 'both databases', bound: true, planned: true, recordedIn: 'both' }
	])(
		'refuses when $name records an admin, before any change',
		async ({ bound, planned, recordedIn }) => {
			expect(await decideWith({ bound, planned })).toStrictEqual({
				boundDatabase: 'cupboard',
				plannedDatabase: 'fresh',
				admin,
				recordedIn
			});
		}
	);

	it('deploys as a first deploy when neither database records an admin', async () => {
		expect(await decideWith({ bound: false, planned: false })).toStrictEqual({
			kind: 'bootstrap',
			claimSecret: 'claim-1',
			claimant
		});
	});
});

describe('readGlobalAdmin', () => {
	it('reads the claimed principal', async () => {
		expect(
			await readGlobalAdmin(
				rows([adminColumns, [claimedDatabase.adminRow ?? '']]),
				databaseIdSchema.parse('cupboard')
			)
		).toStrictEqual(admin);
	});

	it.each([['not json'], [JSON.stringify(['only-one'])]])(
		'refuses an unreadable row %j',
		async (row) => {
			await expect(
				readGlobalAdmin(
					rows([adminColumns, [row]]),
					databaseIdSchema.parse('cupboard')
				)
			).rejects.toBeInstanceOf(GlobalAdminRowInvalidError);
		}
	);

	it.each([
		{
			name: 'no global_admin table',
			before: '0005',
			seed: [],
			expected: undefined
		},
		{
			name: 'an empty global_admin table without the audience column',
			before: '0016',
			seed: [],
			expected: undefined
		},
		{
			name: 'an admin without the audience column or a bootstrap rule',
			before: '0016',
			seed: [
				"INSERT INTO global_admin (id, issuer, subject, claimed_at) VALUES ('singleton', 'https://dash.cloudflare.com', 'cf-user-1', '2026-06-01T00:00:00Z')"
			],
			expected: owner('https://dash.cloudflare.com', 'cf-user-1')
		},
		{
			name: 'an admin without the audience column, with a bootstrap rule',
			before: '0016',
			seed: [
				"INSERT INTO global_admin (id, issuer, subject, claimed_at) VALUES ('singleton', 'https://dash.cloudflare.com', 'cf-user-1', '2026-06-01T00:00:00Z')",
				"INSERT INTO control_trust (id, issuer, audience, created_at) VALUES ('signup', 'https://dash.cloudflare.com', 'cupboard-client', '2026-06-01T00:00:00Z')"
			],
			expected: admin
		},
		{
			name: 'an admin whose audience migration 0016 could not fill',
			before: '0017',
			seed: [
				"INSERT INTO global_admin (id, issuer, subject, claimed_at) VALUES ('singleton', 'https://dash.cloudflare.com', 'cf-user-1', '2026-06-01T00:00:00Z')"
			],
			expected: owner('https://dash.cloudflare.com', 'cf-user-1')
		},
		{
			name: 'an admin with the audience column',
			before: '0017',
			seed: [seededAdmin],
			expected: admin
		}
	])('reads a database with $name', async ({ before, seed, expected }) => {
		const database = await migratedDatabase(before);

		try {
			for (const statement of seed) {
				database.exec(statement);
			}

			expect(
				await readGlobalAdmin(
					sqliteRows(database),
					databaseIdSchema.parse('cupboard')
				)
			).toStrictEqual(expected);
		} finally {
			database.close();
		}
	});
});

function expiringIn(minutes: number): string {
	return jwt({ sub: 'u', exp: Math.floor(nowMs / 1000) + minutes * 60 });
}

describe('renewingIdToken', () => {
	it('logs in once while the token stays fresh', async () => {
		const logins: string[] = [];
		const token = expiringIn(60);
		const idToken = renewingIdToken(
			() => {
				logins.push('login');
				return Promise.resolve(token);
			},
			() => nowMs
		);

		expect({
			first: await idToken(),
			second: await idToken(),
			logins
		}).toStrictEqual({ first: token, second: token, logins: ['login'] });
	});

	it('keeps a token that expires in four minutes', async () => {
		let logins = 0;
		const token = expiringIn(4);
		const idToken = renewingIdToken(
			() => {
				logins += 1;
				return Promise.resolve(token);
			},
			() => nowMs
		);

		expect({
			first: await idToken(),
			second: await idToken(),
			logins
		}).toStrictEqual({ first: token, second: token, logins: 1 });
	});

	it('logs in again once the current token expires within a minute', async () => {
		const tokens = [expiringIn(0.5), expiringIn(60)];
		const idToken = renewingIdToken(
			() => Promise.resolve(tokens.shift() ?? ''),
			() => nowMs
		);
		const first = await idToken();

		expect({ first, second: await idToken() }).toStrictEqual({
			first,
			second: expiringIn(60)
		});
	});
});

describe('adminLoginCommand', () => {
	const url = new URL('https://cache.example.com');

	it.each([
		{
			name: 'the default issuer and client',
			admin: owner(
				'https://dash.cloudflare.com',
				'cf-user-1',
				'6c915db1f16ece47255821ee6ca1d538'
			),
			command: 'cupboard login https://cache.example.com'
		},
		{
			name: 'an admin from before migration 0016 without an audience',
			admin: owner('https://dash.cloudflare.com', 'cf-user-1'),
			command: 'cupboard login https://cache.example.com'
		},
		{
			name: 'another issuer',
			admin: owner(
				'https://idp.example.test/realms/a',
				'founder',
				'cupboard-cli'
			),
			command:
				'cupboard login https://cache.example.com --oidc-issuer https://idp.example.test/realms/a --client-id cupboard-cli'
		},
		{
			name: 'an audience that the shell would split',
			admin: owner(
				'https://idp.example.test',
				'founder',
				"api://cupboard cli's"
			),
			command: String.raw`cupboard login https://cache.example.com --oidc-issuer https://idp.example.test --client-id 'api://cupboard cli'\''s'`
		}
	])('builds the login command for $name', ({ admin: principal, command }) => {
		expect(adminLoginCommand(url, principal)).toBe(command);
	});
});
