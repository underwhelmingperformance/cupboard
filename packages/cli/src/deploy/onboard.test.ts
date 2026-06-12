import type { ParsedTenantSummary } from '@cupboard/protocol/tenants';
import { describe, expect, it } from 'vitest';

import { CupboardHttpError } from '../errors.ts';

import type { CloudflareApi } from './cloudflare-api.ts';
import {
	onboardAdminFor,
	type OnboardClient,
	onboardDeployment,
	type OnboardOutcome,
	slugProblem
} from './onboard.ts';
import { deployerOwner, type OwnerBinding } from './owner.ts';
import type { DeployUi } from './ui.ts';

const unexpected = (member: string) => (): never => {
	throw new Error(`${member} was not expected`);
};

interface ScriptedUi {
	readonly ui: DeployUi;
	readonly warnings: string[];
	readonly successes: string[];
}

/** A UI whose slug prompt answers from `slugs` and records what it is told. */
function scriptedUi(slugs: readonly (string | undefined)[] = []): ScriptedUi {
	const remainingSlugs = [...slugs];
	const warnings: string[] = [];
	const successes: string[] = [];
	const facts: string[] = [];

	const ui: DeployUi = {
		intro: unexpected('intro'),
		outro: unexpected('outro'),
		cancelled: unexpected('cancelled'),
		info: unexpected('info'),
		success: (message) => {
			successes.push(message);
		},
		warn: (message) => {
			warnings.push(message);
		},
		note: unexpected('note'),
		menu: unexpected('menu'),
		editText: unexpected('editText'),
		prefixedText: ({ prefix }) => {
			if (remainingSlugs.length === 0) {
				throw new Error('prefixedText asked more often than scripted');
			}

			expect(prefix).toBe('https://cache.example.com/t/');

			return Promise.resolve(remainingSlugs.shift());
		},
		secret: unexpected('secret'),
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
			result: unexpected('result'),
			warn: unexpected('reporter.warn'),
			info: unexpected('reporter.info')
		})
	};

	return { ui, warnings, successes };
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

function answer<T>(remaining: Scripted<T>[], member: string): Promise<T> {
	const next = remaining.shift();

	if (next === undefined) {
		throw new Error(`${member} called more often than scripted`);
	}

	if (next === 'offline') {
		return Promise.reject(new TypeError('fetch failed'));
	}

	if (typeof next === 'number') {
		return Promise.reject(new CupboardHttpError('GET', member, next, 'no'));
	}

	return Promise.resolve(next);
}

interface ClientScript {
	readonly health?: Scripted<'ok'>[];
	readonly signup?: Scripted<{
		issuer: string;
		subject: string;
		claimed: boolean;
	}>[];
	readonly creates?: Scripted<ParsedTenantSummary>[];
	readonly publicKeys?: Scripted<string>[];
}

interface ScriptedClient {
	readonly factory: (url: string) => OnboardClient;
	readonly urls: string[];
	readonly createdBodies: unknown[];
	readonly cachedTokens: { token: string; target: string }[];
	readonly cacheToken: (token: string, target: string) => Promise<void>;
}

function scriptedClient(script: ClientScript): ScriptedClient {
	const health = [...(script.health ?? [])];
	const signups = [...(script.signup ?? [])];
	const creates = [...(script.creates ?? [])];
	const publicKeys = [...(script.publicKeys ?? [])];
	const urls: string[] = [];
	const createdBodies: unknown[] = [];
	const cachedTokens: { token: string; target: string }[] = [];

	return {
		urls,
		createdBodies,
		cachedTokens,
		cacheToken: (token, target) => {
			cachedTokens.push({ token, target });
			return Promise.resolve();
		},
		factory: (url) => {
			urls.push(url);

			return {
				health: async () => {
					await answer(health, '/_health');
				},
				signup: () => answer(signups, '/signup'),
				tokenExchange: () =>
					Promise.resolve({
						access_token: 'admin-jwt',
						token_type: 'Bearer',
						expires_in: 900,
						scope: 'admin',
						issued_token_type: 'urn:ietf:params:oauth:token-type:access_token'
					}),
				createTenant: (_token, body) => {
					createdBodies.push(body);
					return answer(creates, '/control/tenants');
				},
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
		const { ui, successes } = scriptedUi(['builds']);
		const client = scriptedClient({
			health: ['offline', 404, 'ok'],
			signup: [claimedSignup],
			creates: [tenantSummary('builds')],
			publicKeys: [503, 'pk-1']
		});

		const outcome = await onboardDeployment({
			api: baseApi,
			ui,
			controlScriptName: 'cupboard',
			domain: 'cache.example.com',
			admin: claimable,
			clientFactory: client.factory,
			cacheToken: client.cacheToken,
			sleep: () => Promise.resolve()
		});

		expect({
			outcome,
			urls: client.urls,
			createdBodies: client.createdBodies,
			cachedTokens: client.cachedTokens,
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
			createdBodies: [
				{
					id: 'builds',
					readMode: 'public',
					ownerIssuer: owner.issuer,
					ownerSubject: owner.subject,
					ownerAudience: owner.audience
				}
			],
			cachedTokens: [
				{ token: 'admin-jwt', target: 'https://cache.example.com' }
			],
			successes: ['You are now the admin of this deployment (cf-user-1).']
		});
	});

	it('re-prompts when the slug is claimed first, and converges on the next', async () => {
		const { ui, warnings } = scriptedUi(['builds', 'builds-2']);
		const client = scriptedClient({
			health: ['ok'],
			signup: [{ ...claimedSignup, claimed: false }],
			creates: [409, tenantSummary('builds-2')],
			publicKeys: ['pk-2']
		});

		const outcome = await onboardDeployment({
			api: baseApi,
			ui,
			controlScriptName: 'cupboard',
			domain: 'cache.example.com',
			admin: claimable,
			clientFactory: client.factory,
			cacheToken: client.cacheToken,
			sleep: () => Promise.resolve()
		});

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

	it('stops with the claim intact when the slug prompt is cancelled', async () => {
		const { ui } = scriptedUi([undefined]);
		const client = scriptedClient({
			health: ['ok'],
			signup: [claimedSignup]
		});

		const outcome = await onboardDeployment({
			api: baseApi,
			ui,
			controlScriptName: 'cupboard',
			domain: 'cache.example.com',
			admin: claimable,
			clientFactory: client.factory,
			cacheToken: client.cacheToken,
			sleep: () => Promise.resolve()
		});

		expect(outcome).toStrictEqual({
			kind: 'cancelled',
			url: 'https://cache.example.com'
		});
	});

	it('reports a refused claim as an answer, not a failure', async () => {
		const { ui } = scriptedUi();
		const client = scriptedClient({
			health: ['ok'],
			signup: [403]
		});

		const outcome = await onboardDeployment({
			api: baseApi,
			ui,
			controlScriptName: 'cupboard',
			domain: 'cache.example.com',
			admin: claimable,
			clientFactory: client.factory,
			cacheToken: client.cacheToken,
			sleep: () => Promise.resolve()
		});

		expect(outcome).toStrictEqual({
			kind: 'claim-refused',
			url: 'https://cache.example.com',
			status: 403
		});
	});

	it('stops after the health poll when no admin is bound', async () => {
		const { ui } = scriptedUi();
		const client = scriptedClient({ health: ['ok'] });

		const outcome = await onboardDeployment({
			api: baseApi,
			ui,
			controlScriptName: 'cupboard',
			domain: 'cache.example.com',
			admin: { kind: 'none' },
			clientFactory: client.factory,
			cacheToken: client.cacheToken,
			sleep: () => Promise.resolve()
		});

		expect(outcome).toStrictEqual({
			kind: 'no-admin',
			url: 'https://cache.example.com'
		});
	});

	it('leaves the setup to an admin who is someone else', async () => {
		const { ui } = scriptedUi();
		const other: OwnerBinding = { ...owner, subject: 'cf-user-2' };
		const client = scriptedClient({ health: ['ok'] });

		const outcome = await onboardDeployment({
			api: baseApi,
			ui,
			controlScriptName: 'cupboard',
			domain: 'cache.example.com',
			admin: { kind: 'other', owner: other },
			clientFactory: client.factory,
			cacheToken: client.cacheToken,
			sleep: () => Promise.resolve()
		});

		expect(outcome).toStrictEqual({
			kind: 'admin-elsewhere',
			url: 'https://cache.example.com',
			owner: other
		});
	});

	it('stops short when the session cannot prove the admin is the deployer', async () => {
		const { ui } = scriptedUi();
		const client = scriptedClient({ health: ['ok'] });

		const outcome = await onboardDeployment({
			api: baseApi,
			ui,
			controlScriptName: 'cupboard',
			domain: 'cache.example.com',
			admin: { kind: 'unproven', owner },
			clientFactory: client.factory,
			cacheToken: client.cacheToken,
			sleep: () => Promise.resolve()
		});

		expect(outcome).toStrictEqual({
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
		const client = scriptedClient({ health: ['ok'] });

		const outcome = await onboardDeployment({
			api,
			ui,
			controlScriptName: 'cupboard',
			domain: undefined,
			admin: { kind: 'none' },
			clientFactory: client.factory,
			cacheToken: client.cacheToken,
			sleep: () => Promise.resolve()
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

		expect(
			await onboardDeployment({
				api,
				ui,
				controlScriptName: 'cupboard',
				domain: undefined,
				admin: { kind: 'none' },
				clientFactory: unexpected('clientFactory'),
				sleep: () => Promise.resolve()
			})
		).toStrictEqual({ kind: 'no-subdomain' });
	});

	it('gives up when the Worker never comes up', async () => {
		const { ui } = scriptedUi();
		const client = scriptedClient({ health: ['offline', 'offline', 404] });

		expect(
			await onboardDeployment({
				api: baseApi,
				ui,
				controlScriptName: 'cupboard',
				domain: 'cache.example.com',
				admin: claimable,
				clientFactory: client.factory,
				cacheToken: client.cacheToken,
				sleep: () => Promise.resolve(),
				attempts: 3
			})
		).toStrictEqual({
			kind: 'unreachable',
			url: 'https://cache.example.com',
			lastProbe: 'HTTP 404'
		});
	});

	it('gives up on the cache URL when the new tenant never answers', async () => {
		const { ui } = scriptedUi(['builds']);
		const client = scriptedClient({
			health: ['ok'],
			signup: [claimedSignup],
			creates: [tenantSummary('builds')],
			publicKeys: [503, 503]
		});

		expect(
			await onboardDeployment({
				api: baseApi,
				ui,
				controlScriptName: 'cupboard',
				domain: 'cache.example.com',
				admin: claimable,
				clientFactory: client.factory,
				cacheToken: client.cacheToken,
				sleep: () => Promise.resolve(),
				attempts: 2
			})
		).toStrictEqual({
			kind: 'unreachable',
			url: 'https://cache.example.com/t/builds',
			lastProbe: 'HTTP 503'
		});
	});

	it('propagates a genuine failure on the health route', async () => {
		const { ui } = scriptedUi();
		const client = scriptedClient({ health: [403] });

		await expect(
			onboardDeployment({
				api: baseApi,
				ui,
				controlScriptName: 'cupboard',
				domain: 'cache.example.com',
				admin: claimable,
				clientFactory: client.factory,
				cacheToken: client.cacheToken,
				sleep: () => Promise.resolve()
			})
		).rejects.toBeInstanceOf(CupboardHttpError);
	});
});
