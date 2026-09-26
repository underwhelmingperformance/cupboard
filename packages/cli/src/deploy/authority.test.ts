import { readdir, readFile } from 'node:fs/promises';
import process from 'node:process';

import {
	oidcAudienceSchema,
	oidcIssuerSchema,
	oidcSubjectSchema
} from '@cupboard/protocol/oidc';
import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';

import type { TokenProvider } from '../client/credentials.ts';
import {
	CupboardHttpError,
	OwnerLoginRequiredError,
	UnreachableHostError
} from '../errors.ts';

import {
	AdminCheckFailedError,
	AdminControlWorkerMissingError,
	AdminDatabaseMismatchError,
	AdminDeploymentUrlMissingError,
	AdminGrantMissingError,
	adminLogin,
	AdminLoginMismatchError,
	AdminTokenRequiredError,
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
const deploymentUrl = new URL('https://cupboard.example.workers.dev');

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

const adminToken = jwt({
	sub: 'cf-user-1',
	authorization_details: [{ type: 'cupboard_wildcard' }]
});
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
	readonly credential?: TokenProvider;
	readonly url?: URL | undefined;
	readonly checkAdmin?: () => Promise<void>;
	readonly controlWorkerExists?: boolean;
	readonly servesCupboard?: boolean;
	readonly idToken?: string;
	readonly logInAsAdmin?: () => Promise<void>;
}): Harness {
	const calls: string[] = [];
	const credential = options.credential ?? {
		get: () => Promise.resolve(adminToken),
		refresh: () => Promise.resolve(adminToken)
	};
	const currentUrl = 'url' in options ? options.url : deploymentUrl;
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
			controlScriptName: 'cupboard',
			isControlDeployed: options.controlWorkerExists ?? true,
			interactive: options.interactive ?? true
		},
		effects: {
			api: controlDatabaseApi({ cupboard: database }, calls),
			servesCupboard: (url) => {
				calls.push(`servesCupboard:${url.href}`);
				return Promise.resolve(options.servesCupboard ?? true);
			},
			...(options.logInAsAdmin !== undefined && {
				logInAsAdmin: (url, principal) => {
					calls.push(`logInAsAdmin:${url.href}:${principal.subject}`);
					return options.logInAsAdmin?.() ?? Promise.resolve();
				}
			}),
			currentUrl: () => {
				calls.push('currentUrl');
				return Promise.resolve(currentUrl);
			},
			adminAccess: () => ({
				credentialFor: (url) => {
					calls.push(`credentialFor:${url.href}`);
					return credential;
				}
			}),
			checkAdmin: (url) => {
				calls.push(`checkAdmin:${url.href}`);
				return options.checkAdmin?.() ?? Promise.resolve();
			},
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
			controlWorkerExists: false,
			reads: ['findD1Database:cupboard']
		},
		{
			name: 'a database from before the global_admin table',
			database: { exists: true, hasAdminTable: false, adminRow: undefined },
			controlWorkerExists: true,
			reads: ['findD1Database:cupboard', 'd1QueryRows:cupboard:columns']
		},
		{
			// A deployment uploaded without a claim, or one whose deploy stopped
			// between setting the secret and claiming, has no row in the table.
			name: 'a deployment with Workers but no admin',
			database: emptyDatabase,
			controlWorkerExists: true,
			reads: claimedReads
		}
	])(
		'claims $name, logging in before anything changes',
		async ({ database, controlWorkerExists, reads }) => {
			const { deployment, effects, calls } = harness({
				database,
				controlWorkerExists
			});

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

	it('updates with an admin token that the deployment accepts', async () => {
		const { deployment, effects, calls } = harness({
			database: claimedDatabase,
			interactive: false
		});

		const authority = await decideAuthority(deployment, effects);

		expect({ authority: describeAuthority(authority), calls }).toStrictEqual({
			authority: { kind: 'admin', admin },
			calls: [
				...claimedReads,
				'currentUrl',
				`credentialFor:${deploymentUrl.href}`,
				`checkAdmin:${deploymentUrl.href}`
			]
		});
	});

	it.each([
		{
			name: 'no cached session',
			credential: {
				get: () => Promise.reject(new OwnerLoginRequiredError()),
				refresh: () => Promise.reject(new OwnerLoginRequiredError())
			},
			checkAdmin: undefined,
			cause: OwnerLoginRequiredError
		},
		{
			name: 'a token without the wildcard grant',
			credential: {
				get: () =>
					Promise.resolve(
						jwt({
							sub: 'ci',
							authorization_details: [
								{ type: 'cupboard_control', actions: ['tenant:list'] }
							]
						})
					),
				refresh: () => Promise.resolve('')
			},
			checkAdmin: undefined,
			cause: AdminGrantMissingError
		},
		{
			name: 'a token that the deployment refuses',
			credential: undefined,
			checkAdmin: () =>
				Promise.reject(new ORPCError('UNAUTHORIZED', { status: 401 })),
			cause: ORPCError
		},
		{
			name: 'a CI token that no control trust rule accepts',
			credential: {
				get: () =>
					Promise.reject(
						new CupboardHttpError(
							'POST',
							'/token',
							400,
							JSON.stringify({
								error: 'invalid_grant',
								error_description: 'No trust rule matches the token'
							})
						)
					),
				refresh: () => Promise.resolve('')
			},
			checkAdmin: undefined,
			cause: CupboardHttpError
		}
	])(
		'refuses an update with $name before any change',
		async ({ credential, checkAdmin, cause }) => {
			const { deployment, effects, calls } = harness({
				database: claimedDatabase,
				interactive: false,
				...(credential !== undefined && { credential }),
				...(checkAdmin !== undefined && { checkAdmin })
			});

			const refusal = await rejectionOf(decideAuthority(deployment, effects));

			expect({
				refusal:
					refusal instanceof AdminTokenRequiredError
						? {
								url: refusal.url.href,
								admin: refusal.admin,
								isExpectedCause: refusal.cause instanceof cause
							}
						: refusal,
				// Only reads ran: no login, no claim secret, nothing written.
				changes: calls.filter(
					(call) =>
						!call.startsWith('findD1Database') &&
						!call.startsWith('d1QueryRows') &&
						!call.startsWith('currentUrl') &&
						!call.startsWith('controlWorkerExists') &&
						!call.startsWith('credentialFor') &&
						!call.startsWith('checkAdmin')
				)
			}).toStrictEqual({
				refusal: { url: deploymentUrl.href, admin, isExpectedCause: true },
				changes: []
			});
		}
	);

	it.each([
		{
			name: 'the deployment answers with a server error',
			error: new ORPCError('SERVICE_UNAVAILABLE', { status: 503 }),
			failure: { kind: 'error-status', status: 503 }
		},
		{
			name: 'the deployment fails with a Cloudflare ray',
			error: new CupboardHttpError(
				'POST',
				'/control/instance',
				500,
				'boom',
				'ray-1'
			),
			failure: { kind: 'error-status', status: 500, ray: 'ray-1' }
		},
		{
			name: 'the deployment limits the rate of requests',
			error: new CupboardHttpError('POST', '/token', 429, ''),
			failure: { kind: 'error-status', status: 429 }
		},
		{
			name: 'the deployment cannot be reached',
			error: new UnreachableHostError(
				deploymentUrl.host,
				new TypeError('fetch failed')
			),
			failure: { kind: 'unreachable' }
		},
		{
			name: 'the build has no instance.get procedure',
			error: new ORPCError('NOT_FOUND', { status: 404 }),
			failure: { kind: 'unsupported' }
		},
		{
			name: 'the URL does not serve a Cupboard build',
			error: new ORPCError('NOT_FOUND', { status: 404 }),
			servesCupboard: false,
			failure: { kind: 'not-served' }
		},
		{
			name: 'the token exchange finds no Worker at the URL',
			error: new CupboardHttpError('POST', '/token', 404, ''),
			servesCupboard: false,
			failure: { kind: 'not-served' }
		}
	])(
		'reports that the token could not be checked when $name',
		async ({ error, failure, servesCupboard }) => {
			const { deployment, effects } = harness({
				database: claimedDatabase,
				checkAdmin: () => Promise.reject(error),
				...(servesCupboard !== undefined && { servesCupboard })
			});

			const refusal = await rejectionOf(decideAuthority(deployment, effects));

			expect(
				refusal instanceof AdminCheckFailedError
					? {
							url: refusal.url.href,
							admin: refusal.admin,
							failure: refusal.failure,
							isCause: refusal.cause === error
						}
					: refusal
			).toStrictEqual({
				url: deploymentUrl.href,
				admin,
				failure,
				isCause: true
			});
		}
	);

	it('passes an error that is neither a token nor a check failure through unchanged', async () => {
		const failure = new Error('response did not match the contract');
		const { deployment, effects } = harness({
			database: claimedDatabase,
			checkAdmin: () => Promise.reject(failure)
		});

		expect(await rejectionOf(decideAuthority(deployment, effects))).toBe(
			failure
		);
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

	it.each([
		{
			name: 'at a terminal: logs in',
			interactive: true,
			isUpdated: true,
			logins: [`logInAsAdmin:${deploymentUrl.href}:${admin.subject}`]
		},
		{
			name: 'without a terminal: refuses',
			interactive: false,
			isUpdated: false,
			logins: []
		}
	])(
		'logs in as the admin when no session is cached ($name)',
		async ({ interactive, isUpdated, logins }) => {
			let isLoggedIn = false;
			const { deployment, effects, calls } = harness({
				database: claimedDatabase,
				interactive,
				credential: {
					get: () =>
						isLoggedIn
							? Promise.resolve(adminToken)
							: Promise.reject(new OwnerLoginRequiredError()),
					refresh: () => Promise.reject(new OwnerLoginRequiredError())
				},
				logInAsAdmin: () => {
					isLoggedIn = true;
					return Promise.resolve();
				}
			});

			const refusal = await rejectionOf(decideAuthority(deployment, effects));

			expect({
				isUpdated: refusal === undefined,
				logins: calls.filter((call) => call.startsWith('logInAsAdmin'))
			}).toStrictEqual({ isUpdated, logins });
		}
	);

	it('logs in as the admin when the cached session lacks the wildcard grant', async () => {
		// The cached Cloudflare login of another user can be exchanged for a
		// session with a narrower grant.
		let isLoggedIn = false;
		const { deployment, effects, calls } = harness({
			database: claimedDatabase,
			credential: {
				get: () =>
					Promise.resolve(
						isLoggedIn ? adminToken : jwt({ authorization_details: [] })
					),
				refresh: () => Promise.resolve(adminToken)
			},
			logInAsAdmin: () => {
				isLoggedIn = true;
				return Promise.resolve();
			}
		});

		const authority = await decideAuthority(deployment, effects);

		expect({
			authority: describeAuthority(authority),
			logins: calls.filter((call) => call.startsWith('logInAsAdmin'))
		}).toStrictEqual({
			authority: { kind: 'admin', admin },
			logins: [`logInAsAdmin:${deploymentUrl.href}:${admin.subject}`]
		});
	});

	it('refuses after a login as the admin whose token still lacks the wildcard grant', async () => {
		const { deployment, effects, calls } = harness({
			database: claimedDatabase,
			credential: {
				get: () => Promise.resolve(jwt({ authorization_details: [] })),
				refresh: () => Promise.resolve(jwt({ authorization_details: [] }))
			},
			logInAsAdmin: () => Promise.resolve()
		});

		const refusal = await rejectionOf(decideAuthority(deployment, effects));

		expect({
			refusal:
				refusal instanceof AdminTokenRequiredError
					? {
							isAfterLogin: refusal.isAfterLogin,
							isGrantMissing: refusal.cause instanceof AdminGrantMissingError
						}
					: refusal,
			logins: calls.filter((call) => call.startsWith('logInAsAdmin'))
		}).toStrictEqual({
			refusal: { isAfterLogin: true, isGrantMissing: true },
			logins: [`logInAsAdmin:${deploymentUrl.href}:${admin.subject}`]
		});
	});

	it('refuses an update when the deployment has no URL', async () => {
		const { deployment, effects, calls } = harness({
			database: claimedDatabase,
			url: undefined
		});

		const refusal = await rejectionOf(decideAuthority(deployment, effects));

		expect({
			refusal:
				refusal instanceof AdminDeploymentUrlMissingError
					? { admin: refusal.admin }
					: refusal,
			calls
		}).toStrictEqual({
			refusal: { admin },
			calls: [...claimedReads, 'currentUrl']
		});
	});

	it('refuses an update when the control Worker was deleted, before any request to the deployment', async () => {
		const { deployment, effects, calls } = harness({
			database: claimedDatabase,
			controlWorkerExists: false
		});

		const refusal = await rejectionOf(decideAuthority(deployment, effects));

		expect({
			refusal:
				refusal instanceof AdminControlWorkerMissingError
					? {
							admin: refusal.admin,
							controlScriptName: refusal.controlScriptName
						}
					: refusal,
			calls
		}).toStrictEqual({
			refusal: { admin, controlScriptName: 'cupboard' },
			calls: claimedReads
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
	readonly isControlDeployed?: boolean;
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
			plannedDatabaseName: 'fresh',
			controlWorkerExists: seeded.isControlDeployed ?? true
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

	it("refuses when the control Worker was deleted and the tenant Worker's database records an admin", async () => {
		// A deployment whose database has a non-default name keeps that name in
		// the tenant Worker's binding, so the run is not a first deploy.
		expect(
			await decideWith({
				bound: true,
				planned: false,
				isControlDeployed: false
			})
		).toStrictEqual({
			boundDatabase: 'cupboard',
			plannedDatabase: 'fresh',
			admin,
			recordedIn: 'bound'
		});
	});

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

describe('adminLogin', () => {
	const url = new URL('https://cache.example.com');

	it.each([
		{
			name: 'caches a session when the login returns the admin',
			idToken: jwt({ iss: admin.issuer, sub: admin.subject }),
			refusal: undefined,
			cached: 1
		},
		{
			name: 'refuses a login that returns another Cloudflare user',
			idToken: jwt({ iss: admin.issuer, sub: 'someone-else' }),
			refusal: AdminLoginMismatchError,
			cached: 0
		}
	])('$name', async ({ idToken, refusal, cached }) => {
		const calls: string[] = [];
		const logIn = adminLogin({
			info: () => {
				calls.push('info');
			},
			login: (issuer, clientId) => {
				calls.push(`login:${issuer}:${clientId}`);
				return Promise.resolve(idToken);
			},
			exchange: () => {
				calls.push('exchange');
				return Promise.resolve({
					access_token: 'admin-jwt',
					token_type: 'Bearer',
					expires_in: 900,
					issued_token_type: 'urn:ietf:params:oauth:token-type:access_token'
				});
			},
			cacheSession: () => {
				calls.push('cacheSession');
				return Promise.resolve();
			},
			defaultClientId: 'default-client'
		});

		const error = await rejectionOf(logIn(url, admin));

		expect({
			isExpectedRefusal:
				refusal === undefined ? error === undefined : error instanceof refusal,
			cacheCalls: calls.filter((call) => call === 'cacheSession').length,
			logins: calls.filter((call) => call.startsWith('login:'))
		}).toStrictEqual({
			isExpectedRefusal: true,
			cacheCalls: cached,
			logins: [`login:${admin.issuer}:cupboard-client`]
		});
	});
});
