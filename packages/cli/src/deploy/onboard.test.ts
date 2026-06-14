import type { ParsedR2CredentialCheck } from '@cupboard/protocol/reports';
import type { ParsedTenantSummary } from '@cupboard/protocol/tenants';
import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';

import type { CachedSession } from '../auth/token-store.ts';
import { CupboardHttpError } from '../errors.ts';

import type { CloudflareApi } from './cloudflare-api.ts';
import {
	onboardAdminFor,
	type OnboardClient,
	onboardDeployment,
	type OnboardOptions,
	type OnboardOutcome,
	slugProblem
} from './onboard.ts';
import { deployerOwner, type OwnerBinding } from './owner.ts';
import type { DeployUi, TextEdit } from './ui.ts';

const unexpected = (member: string) => (): never => {
	throw new Error(`${member} was not expected`);
};

interface UiScript {
	readonly slugs?: readonly (string | undefined)[];
	readonly secrets?: readonly (string | undefined)[];
	readonly textEdits?: readonly TextEdit[];
}

interface ScriptedUi {
	readonly ui: DeployUi;
	readonly warnings: string[];
	readonly successes: string[];
	readonly infos: string[];
}

/** A UI whose prompts answer from the script and which records what it says. */
function scriptedUi(script: UiScript = {}): ScriptedUi {
	const remainingSlugs = [...(script.slugs ?? [])];
	const remainingSecrets = [...(script.secrets ?? [])];
	const remainingTextEdits = [...(script.textEdits ?? [])];
	const warnings: string[] = [];
	const successes: string[] = [];
	const infos: string[] = [];
	const facts: string[] = [];

	const ui: DeployUi = {
		intro: unexpected('intro'),
		outro: unexpected('outro'),
		cancelled: unexpected('cancelled'),
		info: (message) => {
			infos.push(message);
		},
		success: (message) => {
			successes.push(message);
		},
		warn: (message) => {
			warnings.push(message);
		},
		note: unexpected('note'),
		menu: unexpected('menu'),
		editText: () => {
			const edit = remainingTextEdits.shift();

			if (edit === undefined) {
				throw new Error('editText asked more often than scripted');
			}

			return Promise.resolve(edit);
		},
		prefixedText: ({ prefix }) => {
			if (remainingSlugs.length === 0) {
				throw new Error('prefixedText asked more often than scripted');
			}

			expect(prefix).toBe('https://cache.example.com/t/');

			return Promise.resolve(remainingSlugs.shift());
		},
		secret: () => {
			if (remainingSecrets.length === 0) {
				throw new Error('secret asked more often than scripted');
			}

			return Promise.resolve(remainingSecrets.shift());
		},
		interactive: true,
		data: unexpected('data'),
		confirm: unexpected('confirm'),
		chooseAccount: unexpected('chooseAccount'),
		openBrowser: unexpected('openBrowser'),
		reporter: () => ({
			phase: (_label, body) =>
				Promise.resolve(
					body({
						fact: (label, value) => {
							facts.push(`${label} ${String(value)}`);
						}
					})
				),
			progress: unexpected('reporter.progress'),
			steps: unexpected('reporter.steps'),
			result: unexpected('result'),
			data: unexpected('reporter.data'),
			warn: unexpected('reporter.warn'),
			info: unexpected('reporter.info'),
			error: unexpected('reporter.error')
		})
	};

	return { ui, warnings, successes, infos };
}

const baseApi: CloudflareApi = {
	listAccounts: unexpected('listAccounts'),
	r2BucketExists: unexpected('r2BucketExists'),
	ensureR2Bucket: unexpected('ensureR2Bucket'),
	ensureD1Database: unexpected('ensureD1Database'),
	ensureKvNamespace: unexpected('ensureKvNamespace'),
	ensureQueue: unexpected('ensureQueue'),
	d1Query: unexpected('d1Query'),
	d1QueryRows: unexpected('d1QueryRows'),
	getScriptMigrationTag: unexpected('getScriptMigrationTag'),
	getScriptBindings: unexpected('getScriptBindings'),
	uploadScript: unexpected('uploadScript'),
	ensureQueueConsumer: unexpected('ensureQueueConsumer'),
	ensureSchedules: unexpected('ensureSchedules'),
	putSecret: unexpected('putSecret'),
	listScriptSecrets: unexpected('listScriptSecrets'),
	findZoneId: unexpected('findZoneId'),
	findCustomDomain: unexpected('findCustomDomain'),
	ensureCustomDomain: unexpected('ensureCustomDomain'),
	listTokenPermissionGroups: unexpected('listTokenPermissionGroups'),
	findApiTokenId: unexpected('findApiTokenId'),
	createApiToken: unexpected('createApiToken'),
	rollApiTokenSecret: unexpected('rollApiTokenSecret'),
	getWorkersDevSubdomain: unexpected('getWorkersDevSubdomain'),
	enableWorkersDevRoute: unexpected('enableWorkersDevRoute')
};

/** A subdomain lookup; called with no argument it finds none registered. */
const subdomainOf = (value?: string) => (): Promise<string | undefined> =>
	Promise.resolve(value);

const owner: OwnerBinding = deployerOwner('cf-user-1');

const claimable = {
	kind: 'claimable',
	owner,
	idToken: 'id-token-1'
} as const;

function tenantSummary(id: string): ParsedTenantSummary {
	return {
		id,
		status: 'active',
		readMode: 'public',
		ownerIssuer: owner.issuer,
		ownerSubject: owner.subject,
		ownerAudience: owner.audience,
		configVersion: 1,
		createdAt: '2026-06-12T00:00:00Z'
	};
}

/** One scripted answer: a value, an HTTP status to fail with, or no route. */
type Scripted<T> = T | number | 'offline';

function answer<T>(
	remaining: Scripted<T>[],
	member: string,
	rejection: (status: number, member: string) => Error = httpRejection
): Promise<T> {
	const next = remaining.shift();

	if (next === undefined) {
		throw new Error(`${member} called more often than scripted`);
	}

	if (next === 'offline') {
		return Promise.reject(new TypeError('fetch failed'));
	}

	if (typeof next === 'number') {
		return Promise.reject(rejection(next, member));
	}

	return Promise.resolve(next);
}

// The raw endpoints fail as CupboardHttpError; the control procedures arrive
// through the derived client, whose failures are ORPCErrors.
function httpRejection(status: number, member: string): Error {
	return new CupboardHttpError('GET', member, status, 'computer says no\n');
}

function orpcRejection(status: number): Error {
	return new ORPCError('INTERNAL_SERVER_ERROR', {
		status,
		message: 'computer says no'
	});
}

interface ClientScript {
	/** What `/_version` answers; the deployed build is `v-new`. */
	readonly versions?: Scripted<string>[];
	readonly signup?: Scripted<{
		issuer: string;
		subject: string;
		claimed: boolean;
	}>[];
	/** What listing tenants answers; the claim flow always lists first. */
	readonly lists?: Scripted<ParsedTenantSummary[]>[];
	readonly creates?: Scripted<ParsedTenantSummary>[];
	readonly controlChecks?: Scripted<ParsedR2CredentialCheck>[];
	readonly publicKeys?: Scripted<string>[];
}

interface ScriptedClient {
	readonly factory: (url: string) => OnboardClient;
	readonly urls: string[];
	readonly signupBodies: unknown[];
	readonly createdBodies: unknown[];
	readonly cachedSessions: { session: CachedSession; target: string }[];
	readonly cacheSession: (
		session: CachedSession,
		target: string
	) => Promise<void>;
}

function scriptedClient(script: ClientScript): ScriptedClient {
	const versions = [...(script.versions ?? [])];
	const signups = [...(script.signup ?? [])];
	const lists = [...(script.lists ?? [])];
	const creates = [...(script.creates ?? [])];
	const controlChecks = [...(script.controlChecks ?? [])];
	const publicKeys = [...(script.publicKeys ?? [])];
	const urls: string[] = [];
	const signupBodies: unknown[] = [];
	const createdBodies: unknown[] = [];
	const cachedSessions: { session: CachedSession; target: string }[] = [];

	return {
		urls,
		signupBodies,
		createdBodies,
		cachedSessions,
		cacheSession: (session, target) => {
			cachedSessions.push({ session, target });
			return Promise.resolve();
		},
		factory: (url) => {
			urls.push(url);

			return {
				version: () => answer(versions, '/_version'),
				signup: (request) => {
					signupBodies.push(request);
					return answer(signups, '/signup');
				},
				listTenants: async () => ({
					tenants: await answer(lists, '/control/tenants', orpcRejection)
				}),
				tokenExchange: () =>
					Promise.resolve({
						access_token: 'admin-jwt',
						token_type: 'Bearer',
						expires_in: 900,
						scope: 'admin',
						issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
						refresh_token: 'refresh-1'
					}),
				createTenant: (_token, body) => {
					createdBodies.push(body);
					return answer(creates, '/control/tenants', orpcRejection);
				},
				controlCheck: async () => ({
					r2: await answer(controlChecks, '/control/check', orpcRejection)
				}),
				publicKey: () => answer(publicKeys, '/pubkey')
			};
		}
	};
}

const claimedSignup = {
	issuer: owner.issuer,
	subject: owner.subject,
	claimed: true
};

/** The options every test starts from; spread and override per case. */
function baseOptions(ui: DeployUi, client: ScriptedClient): OnboardOptions {
	return {
		api: baseApi,
		ui,
		controlScriptName: 'cupboard',
		tenantScriptName: 'cupboard-tenant',
		domain: 'cache.example.com',
		admin: claimable,
		buildVersion: 'v-new',
		claimSecret: { kind: 'none' },
		r2: { kind: 'fresh' },
		clientFactory: client.factory,
		cacheSession: client.cacheSession,
		sleep: () => Promise.resolve()
	};
}

const keptR2 = {
	kind: 'kept',
	accountId: 'acc-1',
	bucketName: 'cupboard-blobs'
} as const;

describe('onboardAdminFor', () => {
	const deployer = { subject: 'cf-user-1', idToken: 'id-token-1' };

	it('is claimable when the gate is the deployer themselves', () => {
		expect(
			onboardAdminFor({ kind: 'owner', owner, origin: 'deployer' }, deployer)
		).toStrictEqual({ kind: 'claimable', owner, idToken: 'id-token-1' });
	});

	it('is claimable when a re-read config gate matches the deployer', () => {
		expect(
			onboardAdminFor({ kind: 'owner', owner, origin: 'config' }, deployer)
		).toStrictEqual({ kind: 'claimable', owner, idToken: 'id-token-1' });
	});

	it('belongs to someone else when the subject differs', () => {
		const other: OwnerBinding = { ...owner, subject: 'cf-user-2' };

		expect(
			onboardAdminFor(
				{ kind: 'owner', owner: other, origin: 'manual' },
				deployer
			)
		).toStrictEqual({ kind: 'other', owner: other });
	});

	it('is unproven when the session credential carries no identity', () => {
		expect(
			onboardAdminFor({ kind: 'owner', owner, origin: 'config' })
		).toStrictEqual({ kind: 'unproven', owner });
	});

	it('is closed when no admin is bound', () => {
		expect(onboardAdminFor({ kind: 'none' }, deployer)).toStrictEqual({
			kind: 'none'
		});
	});
});

describe('slugProblem', () => {
	it.each([['builds'], ['team-1'], ['a.b_c-d']])('accepts %s', (value) => {
		expect(slugProblem(value)).toBeUndefined();
	});

	it.each([
		['', 'a slug is required'],
		['-leading', 'lowercase letters'],
		['UPPER', 'lowercase letters'],
		['has space', 'lowercase letters']
	])('rejects %j', (value, reason) => {
		expect(slugProblem(value)).toContain(reason);
	});
});

describe('onboardDeployment', () => {
	it('claims, creates the chosen tenant and initialises its cache', async () => {
		const { ui, successes } = scriptedUi({ slugs: ['builds'] });
		const client = scriptedClient({
			versions: ['offline', 404, 'v-new'],
			signup: [claimedSignup],
			lists: [[]],
			creates: [tenantSummary('builds')],
			publicKeys: [503, 'pk-1']
		});

		const outcome = await onboardDeployment(baseOptions(ui, client));

		expect({
			outcome,
			urls: client.urls,
			signupBodies: client.signupBodies,
			createdBodies: client.createdBodies,
			cachedSessions: client.cachedSessions,
			successes
		}).toStrictEqual({
			outcome: {
				kind: 'ready',
				url: 'https://cache.example.com',
				slug: 'builds',
				cacheUrl: 'https://cache.example.com/t/builds',
				publicKey: 'pk-1'
			} satisfies OnboardOutcome,
			urls: ['https://cache.example.com', 'https://cache.example.com/t/builds'],
			signupBodies: [{ subject_token: 'id-token-1' }],
			createdBodies: [
				{
					id: 'builds',
					readMode: 'public',
					ownerIssuer: owner.issuer,
					ownerSubject: owner.subject,
					ownerAudience: owner.audience
				}
			],
			cachedSessions: [
				{
					session: { accessToken: 'admin-jwt', refreshToken: 'refresh-1' },
					target: 'https://cache.example.com'
				}
			],
			successes: ['You are now the admin of this deployment (cf-user-1).']
		});
	});

	it('waits out an older version that is still serving', async () => {
		const { ui } = scriptedUi({ slugs: ['builds'] });
		const client = scriptedClient({
			versions: ['v-old', 'v-old', 'v-new'],
			signup: [claimedSignup],
			lists: [[]],
			creates: [tenantSummary('builds')],
			publicKeys: ['pk-1']
		});

		const outcome = await onboardDeployment(baseOptions(ui, client));

		expect(outcome.kind).toBe('ready');
	});

	it('gives up naming the version that kept answering', async () => {
		const { ui } = scriptedUi();
		const client = scriptedClient({ versions: ['v-old', 'v-old'] });

		expect(
			await onboardDeployment({
				...baseOptions(ui, client),
				attempts: 2
			})
		).toStrictEqual({
			kind: 'unreachable',
			url: 'https://cache.example.com',
			lastProbe: 'still serving v-old'
		});
	});

	it('sends the claim secret this deploy supplied', async () => {
		const { ui } = scriptedUi({ slugs: ['builds'] });
		const client = scriptedClient({
			versions: ['v-new'],
			signup: [claimedSignup],
			lists: [[]],
			creates: [tenantSummary('builds')],
			publicKeys: ['pk-1']
		});

		await onboardDeployment({
			...baseOptions(ui, client),
			claimSecret: { kind: 'known', value: 'hunter2' }
		});

		expect(client.signupBodies).toStrictEqual([
			{ subject_token: 'id-token-1', claim_secret: 'hunter2' }
		]);
	});

	it('asks for the claim secret only the Worker holds, then claims', async () => {
		const { ui, infos } = scriptedUi({
			slugs: ['builds'],
			secrets: ['hunter2']
		});
		const client = scriptedClient({
			versions: ['v-new'],
			signup: [claimedSignup],
			lists: [[]],
			creates: [tenantSummary('builds')],
			publicKeys: ['pk-1']
		});

		const outcome = await onboardDeployment({
			...baseOptions(ui, client),
			claimSecret: { kind: 'configured' }
		});

		expect({
			kind: outcome.kind,
			signupBodies: client.signupBodies,
			explained: infos.some((message) =>
				message.includes('protected by a claim secret')
			)
		}).toStrictEqual({
			kind: 'ready',
			signupBodies: [{ subject_token: 'id-token-1', claim_secret: 'hunter2' }],
			explained: true
		});
	});

	it('withholds the claim when the secret prompt is dismissed', async () => {
		const { ui } = scriptedUi({ secrets: [undefined] });
		const client = scriptedClient({ versions: ['v-new'] });

		expect(
			await onboardDeployment({
				...baseOptions(ui, client),
				claimSecret: { kind: 'configured' }
			})
		).toStrictEqual({
			kind: 'claim-cancelled',
			url: 'https://cache.example.com'
		});
	});

	it('presents a freshly fetched id_token to the claim', async () => {
		const { ui } = scriptedUi({ slugs: ['builds'] });
		const client = scriptedClient({
			versions: ['v-new'],
			signup: [claimedSignup],
			lists: [[]],
			creates: [tenantSummary('builds')],
			publicKeys: ['pk-1']
		});

		await onboardDeployment({
			...baseOptions(ui, client),
			// The login's snapshot ('id-token-1') can expire mid-deploy; the
			// claim asks for a fresh token at the moment of use.
			freshIdToken: () => Promise.resolve('id-token-fresh')
		});

		expect(client.signupBodies).toStrictEqual([
			{ subject_token: 'id-token-fresh' }
		]);
	});

	it('proves a kept R2 pair through the new cache', async () => {
		const { ui } = scriptedUi({ slugs: ['builds'] });
		const client = scriptedClient({
			versions: ['v-new'],
			signup: [claimedSignup],
			lists: [[]],
			creates: [tenantSummary('builds')],
			controlChecks: [{ result: 'ok' }],
			publicKeys: ['pk-1']
		});

		const outcome = await onboardDeployment({
			...baseOptions(ui, client),
			r2: keptR2
		});

		expect(outcome.kind).toBe('ready');
	});

	it('replaces a rejected kept pair, looping until R2 accepts one', async () => {
		const secretsSet: string[] = [];
		const api: CloudflareApi = {
			...baseApi,
			putSecret: (scriptName, secret) => {
				secretsSet.push(`${scriptName}:${secret.name}`);
				return Promise.resolve();
			}
		};
		const probed: string[] = [];
		const goodKey = 'b'.repeat(32);
		const { ui, warnings } = scriptedUi({
			slugs: ['builds'],
			// The first entered pair is rejected by R2; the loop asks again.
			textEdits: [
				{ kind: 'set', value: 'a'.repeat(32) },
				{ kind: 'set', value: goodKey }
			],
			secrets: ['c'.repeat(64), 'd'.repeat(64)]
		});
		const client = scriptedClient({
			versions: ['v-new'],
			signup: [claimedSignup],
			lists: [[]],
			creates: [tenantSummary('builds')],
			// The kept pair fails; after the new pair is set, the Worker still
			// answers with the old env once before the restart lands.
			controlChecks: [
				{ result: 'rejected', status: 403 },
				{ result: 'rejected', status: 403 },
				{ result: 'ok' }
			],
			publicKeys: ['pk-1']
		});

		const outcome = await onboardDeployment({
			...baseOptions(ui, client),
			api,
			r2: keptR2,
			checkCredentials: ({ credentials }) => {
				probed.push(credentials.accessKeyId);

				return Promise.resolve(
					credentials.accessKeyId === goodKey
						? { kind: 'valid' }
						: { kind: 'rejected', status: 403 }
				);
			}
		});

		expect({
			kind: outcome.kind,
			probed,
			secretsSet,
			rejectionsSaid: warnings.filter((message) =>
				message.includes('R2 rejected')
			).length
		}).toStrictEqual({
			kind: 'ready',
			probed: ['a'.repeat(32), goodKey],
			secretsSet: [
				'cupboard-tenant:R2_ACCESS_KEY_ID',
				'cupboard-tenant:R2_SECRET_ACCESS_KEY'
			],
			rejectionsSaid: 2
		});
	});

	it('continues unchanged when the replacement prompt is dismissed', async () => {
		const { ui, infos } = scriptedUi({
			slugs: ['builds'],
			textEdits: [{ kind: 'cancelled' }]
		});
		const client = scriptedClient({
			versions: ['v-new'],
			signup: [claimedSignup],
			lists: [[]],
			creates: [tenantSummary('builds')],
			controlChecks: [{ result: 'rejected', status: 403 }],
			publicKeys: ['pk-1']
		});

		const outcome = await onboardDeployment({
			...baseOptions(ui, client),
			r2: keptR2
		});

		expect({
			kind: outcome.kind,
			unchanged: infos.some((message) =>
				message.includes('credentials are unchanged')
			)
		}).toStrictEqual({ kind: 'ready', unchanged: true });
	});

	it('re-prompts when the slug is claimed first, and converges on the next', async () => {
		const { ui, warnings } = scriptedUi({ slugs: ['builds', 'builds-2'] });
		const client = scriptedClient({
			versions: ['v-new'],
			signup: [{ ...claimedSignup, claimed: false }],
			lists: [[]],
			creates: [409, tenantSummary('builds-2')],
			publicKeys: ['pk-2']
		});

		const outcome = await onboardDeployment(baseOptions(ui, client));

		expect({
			kind: outcome.kind,
			slug: outcome.kind === 'ready' ? outcome.slug : undefined,
			warnings
		}).toStrictEqual({
			kind: 'ready',
			slug: 'builds-2',
			warnings: ['"builds" is already taken; choose another.']
		});
	});

	it('keeps an existing sole cache instead of prompting again', async () => {
		const { ui, infos } = scriptedUi();
		const client = scriptedClient({
			versions: ['v-new'],
			signup: [{ ...claimedSignup, claimed: false }],
			lists: [[tenantSummary('laney')]],
			publicKeys: ['pk-1']
		});

		const outcome = await onboardDeployment(baseOptions(ui, client));

		expect({ outcome, infos }).toStrictEqual({
			outcome: {
				kind: 'ready',
				url: 'https://cache.example.com',
				slug: 'laney',
				cacheUrl: 'https://cache.example.com/t/laney',
				publicKey: 'pk-1'
			} satisfies OnboardOutcome,
			infos: ['The cache "laney" already exists; nothing to create.']
		});
	});

	it('lists several existing caches and creates nothing', async () => {
		const { ui } = scriptedUi();
		const client = scriptedClient({
			versions: ['v-new'],
			signup: [{ ...claimedSignup, claimed: false }],
			lists: [[tenantSummary('laney'), tenantSummary('builds')]]
		});

		expect(await onboardDeployment(baseOptions(ui, client))).toStrictEqual({
			kind: 'already-initialised',
			url: 'https://cache.example.com',
			slugs: ['laney', 'builds']
		});
	});

	it('stops with the claim intact when the slug prompt is cancelled', async () => {
		const { ui } = scriptedUi({ slugs: [undefined] });
		const client = scriptedClient({
			versions: ['v-new'],
			signup: [claimedSignup],
			lists: [[]]
		});

		expect(await onboardDeployment(baseOptions(ui, client))).toStrictEqual({
			kind: 'cancelled',
			url: 'https://cache.example.com'
		});
	});

	it('reports a refused claim with the server response, not as a failure', async () => {
		const { ui } = scriptedUi();
		const client = scriptedClient({
			versions: ['v-new'],
			signup: [403]
		});

		expect(await onboardDeployment(baseOptions(ui, client))).toStrictEqual({
			kind: 'claim-refused',
			url: 'https://cache.example.com',
			status: 403,
			detail: 'GET /signup answered HTTP 403: computer says no'
		});
	});

	it('stops after the version wait when no admin is bound', async () => {
		const { ui } = scriptedUi();
		const client = scriptedClient({ versions: ['v-new'] });

		expect(
			await onboardDeployment({
				...baseOptions(ui, client),
				admin: { kind: 'none' }
			})
		).toStrictEqual({
			kind: 'no-admin',
			url: 'https://cache.example.com'
		});
	});

	it('leaves the setup to an admin who is someone else', async () => {
		const { ui } = scriptedUi();
		const other: OwnerBinding = { ...owner, subject: 'cf-user-2' };
		const client = scriptedClient({ versions: ['v-new'] });

		expect(
			await onboardDeployment({
				...baseOptions(ui, client),
				admin: { kind: 'other', owner: other }
			})
		).toStrictEqual({
			kind: 'admin-elsewhere',
			url: 'https://cache.example.com',
			owner: other
		});
	});

	it('stops short when the session cannot prove the admin is the deployer', async () => {
		const { ui } = scriptedUi();
		const client = scriptedClient({ versions: ['v-new'] });

		expect(
			await onboardDeployment({
				...baseOptions(ui, client),
				admin: { kind: 'unproven', owner }
			})
		).toStrictEqual({
			kind: 'identity-unproven',
			url: 'https://cache.example.com',
			owner
		});
	});

	it('enables the workers.dev route when no custom domain is set', async () => {
		const enabled: string[] = [];
		const api: CloudflareApi = {
			...baseApi,
			getWorkersDevSubdomain: subdomainOf('laney'),
			enableWorkersDevRoute: (scriptName) => {
				enabled.push(scriptName);
				return Promise.resolve();
			}
		};
		const { ui } = scriptedUi();
		const client = scriptedClient({ versions: ['v-new'] });

		const outcome = await onboardDeployment({
			...baseOptions(ui, client),
			api,
			domain: undefined,
			admin: { kind: 'none' }
		});

		expect({ outcome, enabled, urls: client.urls }).toStrictEqual({
			outcome: {
				kind: 'no-admin',
				url: 'https://cupboard.laney.workers.dev'
			} satisfies OnboardOutcome,
			enabled: ['cupboard'],
			urls: ['https://cupboard.laney.workers.dev']
		});
	});

	it('reports a missing workers.dev subdomain', async () => {
		const api: CloudflareApi = {
			...baseApi,
			getWorkersDevSubdomain: subdomainOf()
		};
		const { ui } = scriptedUi();
		const client = scriptedClient({});

		expect(
			await onboardDeployment({
				...baseOptions(ui, client),
				api,
				domain: undefined,
				admin: { kind: 'none' },
				clientFactory: unexpected('clientFactory')
			})
		).toStrictEqual({ kind: 'no-subdomain' });
	});

	it('gives up when the Worker never comes up', async () => {
		const { ui } = scriptedUi();
		const client = scriptedClient({ versions: ['offline', 'offline', 404] });

		expect(
			await onboardDeployment({
				...baseOptions(ui, client),
				attempts: 3
			})
		).toStrictEqual({
			kind: 'unreachable',
			url: 'https://cache.example.com',
			lastProbe: 'HTTP 404: computer says no'
		});
	});

	it('gives up on the cache URL when the new tenant never answers', async () => {
		const { ui } = scriptedUi({ slugs: ['builds'] });
		const client = scriptedClient({
			versions: ['v-new'],
			signup: [claimedSignup],
			lists: [[]],
			creates: [tenantSummary('builds')],
			publicKeys: [503, 503]
		});

		expect(
			await onboardDeployment({
				...baseOptions(ui, client),
				attempts: 2
			})
		).toStrictEqual({
			kind: 'unreachable',
			url: 'https://cache.example.com/t/builds',
			lastProbe: 'HTTP 503: computer says no'
		});
	});

	it('propagates a genuine failure on the version route', async () => {
		const { ui } = scriptedUi();
		const client = scriptedClient({ versions: [403] });

		await expect(
			onboardDeployment(baseOptions(ui, client))
		).rejects.toBeInstanceOf(CupboardHttpError);
	});
});
