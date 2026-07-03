import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import type { ParsedR2CredentialCheck } from '@cupboard/protocol/reports';
import type {
	ParsedMembershipRebuildResponse,
	ParsedTenantSummary
} from '@cupboard/protocol/tenants';
import type { ProgressHandle, StepLog } from '@cupboard/reporter';
import { ORPCError } from '@orpc/client';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

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
import { type DeployUi, terminalLink, type TextEdit } from './ui.ts';

const absentValues: { readonly choice?: never } = {};

interface UiScript {
	readonly menuChoices?: readonly (string | undefined)[];
	readonly slugs?: readonly (string | undefined)[];
	readonly secrets?: readonly (string | undefined)[];
	readonly textEdits?: readonly TextEdit[];
	readonly accountChoices?: readonly (string | undefined)[];
}

interface UiCall {
	readonly method: string;
}

interface ScriptedUi {
	readonly ui: DeployUi;
	readonly uiCalls: UiCall[];
	readonly warnings: string[];
	readonly successes: string[];
	readonly infos: string[];
}

const defaultApiCalls: ApiCall[] = [];
const unscriptedInteractiveCalls: UiCall[] = [];

afterEach(() => {
	expect({
		defaultApiCalls,
		unscriptedInteractiveCalls
	}).toStrictEqual({
		defaultApiCalls: [],
		unscriptedInteractiveCalls: []
	});

	defaultApiCalls.length = 0;
	unscriptedInteractiveCalls.length = 0;
});

/** A UI whose prompts answer from the script and which records what it says. */
function scriptedUi(script: UiScript = {}): ScriptedUi {
	const remainingMenuChoices = [...(script.menuChoices ?? [])];
	const remainingSlugs = [...(script.slugs ?? [])];
	const remainingSecrets = [...(script.secrets ?? [])];
	const remainingTextEdits = [...(script.textEdits ?? [])];
	const remainingAccountChoices = [...(script.accountChoices ?? [])];
	const uiCalls: UiCall[] = [];
	const warnings: string[] = [];
	const successes: string[] = [];
	const infos: string[] = [];
	const facts: string[] = [];

	const ui: DeployUi = {
		intro: () => {
			unscriptedInteractiveCalls.push({ method: 'intro' });
		},
		outro: () => {
			unscriptedInteractiveCalls.push({ method: 'outro' });
		},
		cancelled: () => {
			unscriptedInteractiveCalls.push({ method: 'cancelled' });
		},
		info: (message) => {
			uiCalls.push({ method: 'info' });
			infos.push(message);
		},
		success: (message) => {
			uiCalls.push({ method: 'success' });
			successes.push(message);
		},
		step: (message) => {
			uiCalls.push({ method: 'step' });
			infos.push(message);
		},
		warn: (message) => {
			uiCalls.push({ method: 'warn' });
			warnings.push(message);
		},
		note: () => {
			unscriptedInteractiveCalls.push({ method: 'note' });
		},
		menu: (_message, entries) => {
			uiCalls.push({ method: 'menu' });
			const taken =
				remainingMenuChoices.length > 0 ? [remainingMenuChoices.shift()] : [];
			const [scripted] = z.array(z.string().optional()).length(1).parse(taken);

			if (scripted === undefined) {
				return Promise.resolve(absentValues.choice);
			}

			const choice = z
				.custom<
					(typeof entries)[number]['value']
				>((value) => value === scripted)
				.parse(entries.find((entry) => entry.value === scripted)?.value);

			return Promise.resolve(choice);
		},
		editText: () => {
			uiCalls.push({ method: 'editText' });
			const edit = remainingTextEdits.shift();

			if (edit === undefined) {
				unscriptedInteractiveCalls.push({ method: 'editText' });

				return Promise.resolve({ kind: 'cancelled' });
			}

			return Promise.resolve(edit);
		},
		prefixedText: ({ prefix }) => {
			uiCalls.push({ method: 'prefixedText' });
			const taken = remainingSlugs.length > 0 ? [remainingSlugs.shift()] : [];
			const [slug] = z.array(z.string().optional()).length(1).parse(taken);
			expect({ prefix }).toStrictEqual({
				prefix: 'https://cache.example.com/t/'
			});

			return Promise.resolve(slug);
		},
		secret: () => {
			uiCalls.push({ method: 'secret' });
			const taken =
				remainingSecrets.length > 0 ? [remainingSecrets.shift()] : [];
			const [secret] = z.array(z.string().optional()).length(1).parse(taken);

			return Promise.resolve(secret);
		},
		chooseAccount: () => {
			uiCalls.push({ method: 'chooseAccount' });
			const taken =
				remainingAccountChoices.length > 0
					? [remainingAccountChoices.shift()]
					: [];
			const [choice] = z.array(z.string().optional()).length(1).parse(taken);

			return Promise.resolve(choice);
		},
		openBrowser: () => {
			uiCalls.push({ method: 'openBrowser' });
			unscriptedInteractiveCalls.push({ method: 'openBrowser' });
		},
		interactive: true,
		data: () => {
			unscriptedInteractiveCalls.push({ method: 'data' });
		},
		confirm: (options) => {
			void options;
			unscriptedInteractiveCalls.push({ method: 'confirm' });

			return Promise.resolve('no');
		},
		reporter: () => ({
			phase: (_label, body) =>
				Promise.resolve(
					body({
						fact: (label, value) => {
							uiCalls.push({ method: 'fact' });
							facts.push(`${label} ${String(value)}`);
						},
						warn: (label, value) => {
							uiCalls.push({ method: 'reporter.warn' });
							warnings.push(value === undefined ? label : `${label}: ${value}`);
						}
					})
				),
			progress: (_label, _options, body) => {
				uiCalls.push({ method: 'reporter.progress' });
				const handle: ProgressHandle = {
					advance: () => {
						uiCalls.push({ method: 'reporter.progress.advance' });
					},
					fact: (label, value) => {
						uiCalls.push({ method: 'reporter.progress.fact' });
						facts.push(`${label} ${String(value)}`);
					},
					warn: (label, value) => {
						uiCalls.push({ method: 'reporter.warn' });
						warnings.push(value === undefined ? label : `${label}: ${value}`);
					}
				};

				return Promise.resolve(body(handle));
			},
			steps: (_label, body) => {
				uiCalls.push({ method: 'reporter.steps' });
				const log: StepLog = {
					message: () => {
						uiCalls.push({ method: 'reporter.steps.message' });
					},
					group: () => ({
						message: () => {
							uiCalls.push({ method: 'reporter.steps.group.message' });
						},
						success: () => {
							uiCalls.push({ method: 'reporter.steps.group.success' });
						},
						error: () => {
							uiCalls.push({ method: 'reporter.steps.group.error' });
						}
					}),
					warn: (label, value) => {
						uiCalls.push({ method: 'reporter.warn' });
						warnings.push(value === undefined ? label : `${label}: ${value}`);
					}
				};

				return Promise.resolve(body(log));
			},
			result: () => {
				unscriptedInteractiveCalls.push({ method: 'result' });
			},
			data: () => {
				unscriptedInteractiveCalls.push({ method: 'reporter.data' });
			},
			warn: (message) => {
				uiCalls.push({ method: 'reporter.warn' });
				warnings.push(message);
			},
			info: (message) => {
				uiCalls.push({ method: 'reporter.info' });
				infos.push(message);
			},
			success: (message) => {
				uiCalls.push({ method: 'reporter.success' });
				successes.push(message);
			},
			step: (message) => {
				uiCalls.push({ method: 'reporter.step' });
				infos.push(message);
			},
			error: () => {
				unscriptedInteractiveCalls.push({ method: 'reporter.error' });
			}
		})
	};

	return { ui, uiCalls, warnings, successes, infos };
}

type ApiCall =
	| { readonly method: keyof CloudflareApi }
	| {
			readonly method: 'putSecret';
			readonly scriptName: string;
			readonly name: string;
	  }
	| { readonly method: 'enableWorkersDevRoute'; readonly scriptName: string };

const absentString: string | undefined = undefined;
const absentBindings: readonly unknown[] | undefined = undefined;

function recordApiCall(apiCalls: ApiCall[], method: keyof CloudflareApi): void {
	apiCalls.push({ method });
}

function baseApi(apiCalls: ApiCall[] = []): CloudflareApi {
	return {
		listAccounts: () => {
			recordApiCall(apiCalls, 'listAccounts');
			return Promise.resolve([]);
		},
		r2BucketExists: () => {
			recordApiCall(apiCalls, 'r2BucketExists');
			return Promise.resolve(false);
		},
		ensureR2Bucket: () => {
			recordApiCall(apiCalls, 'ensureR2Bucket');
			return Promise.resolve();
		},
		ensureStagingLifecycleRule: () => {
			recordApiCall(apiCalls, 'ensureStagingLifecycleRule');
			return Promise.resolve();
		},
		ensureD1Database: () => {
			recordApiCall(apiCalls, 'ensureD1Database');
			return Promise.resolve('database-id');
		},
		ensureKvNamespace: () => {
			recordApiCall(apiCalls, 'ensureKvNamespace');
			return Promise.resolve('namespace-id');
		},
		ensureQueue: () => {
			recordApiCall(apiCalls, 'ensureQueue');
			return Promise.resolve('queue-id');
		},
		d1Query: () => {
			recordApiCall(apiCalls, 'd1Query');
			return Promise.resolve();
		},
		d1QueryRows: () => {
			recordApiCall(apiCalls, 'd1QueryRows');
			return Promise.resolve([]);
		},
		getScriptMigrationTag: () => {
			recordApiCall(apiCalls, 'getScriptMigrationTag');
			return Promise.resolve(absentString);
		},
		getScriptBindings: () => {
			recordApiCall(apiCalls, 'getScriptBindings');
			return Promise.resolve(absentBindings);
		},
		uploadScript: () => {
			recordApiCall(apiCalls, 'uploadScript');
			return Promise.resolve();
		},
		ensureQueueConsumer: () => {
			recordApiCall(apiCalls, 'ensureQueueConsumer');
			return Promise.resolve();
		},
		ensureSchedules: () => {
			recordApiCall(apiCalls, 'ensureSchedules');
			return Promise.resolve();
		},
		putSecret: (scriptName, secret) => {
			apiCalls.push({ method: 'putSecret', scriptName, name: secret.name });

			return Promise.resolve();
		},
		listScriptSecrets: () => {
			recordApiCall(apiCalls, 'listScriptSecrets');
			return Promise.resolve([]);
		},
		findZoneId: () => {
			recordApiCall(apiCalls, 'findZoneId');
			return Promise.resolve(absentString);
		},
		findCustomDomain: () => {
			recordApiCall(apiCalls, 'findCustomDomain');
			return Promise.resolve(absentString);
		},
		ensureCustomDomain: () => {
			recordApiCall(apiCalls, 'ensureCustomDomain');
			return Promise.resolve();
		},
		listTokenPermissionGroups: () => {
			recordApiCall(apiCalls, 'listTokenPermissionGroups');
			return Promise.resolve([]);
		},
		findApiTokenId: () => {
			recordApiCall(apiCalls, 'findApiTokenId');
			return Promise.resolve(absentString);
		},
		createApiToken: () => {
			recordApiCall(apiCalls, 'createApiToken');
			return Promise.resolve({ id: 'token-id', value: 'token-value' });
		},
		rollApiTokenSecret: () => {
			recordApiCall(apiCalls, 'rollApiTokenSecret');
			return Promise.resolve('token-value');
		},
		getWorkersDevSubdomain: () => {
			recordApiCall(apiCalls, 'getWorkersDevSubdomain');
			return Promise.resolve(absentString);
		},
		enableWorkersDevRoute: (scriptName) => {
			apiCalls.push({ method: 'enableWorkersDevRoute', scriptName });

			return Promise.resolve();
		},
		queryWorkerLogs: () => Promise.resolve([])
	};
}

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
		id: tenantIdSchema.parse(id),
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
	const taken = remaining.length > 0 ? [remaining.shift()] : [];
	const [scripted] = z
		.tuple([z.custom<Scripted<T>>((value) => value !== undefined)])
		.parse(taken);

	if (scripted === 'offline') {
		return Promise.reject(new TypeError('fetch failed'));
	}

	if (typeof scripted === 'number') {
		return Promise.reject(rejection(scripted, member));
	}

	return Promise.resolve(scripted);
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
	readonly rebuilds?: Scripted<ParsedMembershipRebuildResponse>[];
	readonly controlChecks?: Scripted<ParsedR2CredentialCheck>[];
	readonly publicKeys?: Scripted<string>[];
}

interface ScriptedClient {
	readonly factory: (url: string) => OnboardClient;
	readonly urls: string[];
	readonly signupBodies: unknown[];
	readonly createdBodies: unknown[];
	readonly membershipRebuildTokens: string[];
	readonly controlCheckTokens: string[];
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
	const rebuilds = [...(script.rebuilds ?? [])];
	const controlChecks = [...(script.controlChecks ?? [])];
	const publicKeys = [...(script.publicKeys ?? [])];
	const urls: string[] = [];
	const signupBodies: unknown[] = [];
	const createdBodies: unknown[] = [];
	const membershipRebuildTokens: string[] = [];
	const controlCheckTokens: string[] = [];
	const cachedSessions: { session: CachedSession; target: string }[] = [];

	return {
		urls,
		signupBodies,
		createdBodies,
		membershipRebuildTokens,
		controlCheckTokens,
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
				rebuildMembership: (token) => {
					membershipRebuildTokens.push(token);
					return answer(rebuilds, '/control/membership/rebuild', orpcRejection);
				},
				controlCheck: async (token) => {
					controlCheckTokens.push(token);

					return {
						db: { result: 'ok' },
						r2: await answer(controlChecks, '/control/check', orpcRejection)
					};
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

/** The options every test starts from; spread and override per case. */
function baseOptions(ui: DeployUi, client: ScriptedClient): OnboardOptions {
	return {
		api: baseApi(defaultApiCalls),
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

function claimRefusedShape(outcome: OnboardOutcome): {
	readonly kind: string;
	readonly url: string | undefined;
	readonly status: number | undefined;
	readonly detail: string;
} {
	const refused = z
		.object({
			kind: z.literal('claim-refused'),
			url: z.string(),
			status: z.number(),
			detail: z.string()
		})
		.parse(outcome);

	return {
		kind: refused.kind,
		url: refused.url,
		status: refused.status,
		detail: refused.detail
	};
}

function unreachableShape(outcome: OnboardOutcome): {
	readonly kind: string;
	readonly url: string | undefined;
	readonly lastProbe: string;
} {
	const unreachable = z
		.object({
			kind: z.literal('unreachable'),
			url: z.string(),
			lastProbe: z.string()
		})
		.parse(outcome);

	return {
		kind: unreachable.kind,
		url: unreachable.url,
		lastProbe: unreachable.lastProbe
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
		['', 'empty'],
		['-leading', 'invalid-format'],
		['UPPER', 'invalid-format'],
		['has space', 'invalid-format']
	])('rejects %j', (value, problem) => {
		expect(slugProblem(value)).toBe(problem);
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

		expect({
			outcome,
			urls: client.urls,
			signupBodies: client.signupBodies,
			createdBodies: client.createdBodies,
			cachedSessions: client.cachedSessions
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
			]
		});
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
			lastProbe: 'still serving v-old',
			worker: 'cupboard'
		});
	});

	it('stops at the first 500 from the cache, naming the tenant Worker', async () => {
		const { ui } = scriptedUi({ slugs: ['builds'] });
		// A single scripted 500 with the default 30 attempts: a retry would run
		// the script dry and throw, so reaching the outcome proves it stopped at
		// once on a terminal error.
		const client = scriptedClient({
			versions: ['v-new'],
			signup: [claimedSignup],
			lists: [[]],
			creates: [tenantSummary('builds')],
			publicKeys: [500]
		});

		expect(await onboardDeployment(baseOptions(ui, client))).toStrictEqual({
			kind: 'unreachable',
			url: 'https://cache.example.com/t/builds',
			lastProbe: 'HTTP 500: computer says no',
			lastStatus: 500,
			worker: 'cupboard-tenant'
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
			outcome,
			signupBodies: client.signupBodies,
			infos
		}).toStrictEqual({
			outcome: {
				kind: 'ready',
				url: 'https://cache.example.com',
				slug: 'builds',
				cacheUrl: 'https://cache.example.com/t/builds',
				publicKey: 'pk-1'
			} satisfies OnboardOutcome,
			signupBodies: [{ subject_token: 'id-token-1', claim_secret: 'hunter2' }],
			infos: [
				'This deployment is protected by a claim secret (the CUPBOARD_SIGNUP_SECRET Worker secret), which must be presented to become the admin.'
			]
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

		expect({
			outcome,
			urls: client.urls,
			createdBodies: client.createdBodies,
			controlCheckTokens: client.controlCheckTokens
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
			controlCheckTokens: ['admin-jwt']
		});
	});

	it('replaces a rejected kept pair, looping until R2 accepts one', async () => {
		const apiCalls: ApiCall[] = [];
		const api: CloudflareApi = {
			...baseApi(apiCalls),
			putSecret: (scriptName, secret) => {
				apiCalls.push({ method: 'putSecret', scriptName, name: secret.name });
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
			outcome,
			probed,
			apiCalls,
			warnings
		}).toStrictEqual({
			outcome: {
				kind: 'ready',
				url: 'https://cache.example.com',
				slug: 'builds',
				cacheUrl: 'https://cache.example.com/t/builds',
				publicKey: 'pk-1'
			} satisfies OnboardOutcome,
			probed: ['a'.repeat(32), goodKey],
			apiCalls: [
				{
					method: 'putSecret',
					scriptName: 'cupboard-tenant',
					name: 'R2_ACCESS_KEY_ID'
				},
				{
					method: 'putSecret',
					scriptName: 'cupboard-tenant',
					name: 'R2_SECRET_ACCESS_KEY'
				}
			],
			warnings: [
				'R2 rejected the credentials on the Worker (HTTP 403), so pushes will fail.',
				'R2 rejected that pair too (HTTP 403); check the values and try again.'
			]
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
			outcome,
			infos
		}).toStrictEqual({
			outcome: {
				kind: 'ready',
				url: 'https://cache.example.com',
				slug: 'builds',
				cacheUrl: 'https://cache.example.com/t/builds',
				publicKey: 'pk-1'
			} satisfies OnboardOutcome,
			infos: [
				'Create an R2 API token (Object Read & Write on the cache bucket) at\n' +
					terminalLink(
						'https://dash.cloudflare.com/acc-1/r2/api-tokens',
						'https://dash.cloudflare.com/acc-1/r2/api-tokens'
					),
				'The credentials are unchanged. Re-run `cupboard init` to replace them later.'
			]
		});
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
			outcome,
			warnings
		}).toStrictEqual({
			outcome: {
				kind: 'ready',
				url: 'https://cache.example.com',
				slug: 'builds-2',
				cacheUrl: 'https://cache.example.com/t/builds-2',
				publicKey: 'pk-2'
			} satisfies OnboardOutcome,
			warnings: ['"builds" is already taken; choose another.']
		});
	});

	it('keeps an existing sole cache instead of prompting again', async () => {
		const { ui, infos } = scriptedUi();
		const client = scriptedClient({
			versions: ['v-new'],
			signup: [{ ...claimedSignup, claimed: false }],
			lists: [[tenantSummary('laney')]],
			rebuilds: [{ tenants: 1 }],
			publicKeys: ['pk-1']
		});

		const outcome = await onboardDeployment(baseOptions(ui, client));

		expect({
			outcome,
			infos,
			membershipRebuildTokens: client.membershipRebuildTokens
		}).toStrictEqual({
			outcome: {
				kind: 'ready',
				url: 'https://cache.example.com',
				slug: 'laney',
				cacheUrl: 'https://cache.example.com/t/laney',
				publicKey: 'pk-1'
			} satisfies OnboardOutcome,
			infos: ['The cache "laney" already exists; nothing to create.'],
			membershipRebuildTokens: ['admin-jwt']
		});
	});

	it('lists several existing caches and creates nothing', async () => {
		const { ui } = scriptedUi();
		const client = scriptedClient({
			versions: ['v-new'],
			signup: [{ ...claimedSignup, claimed: false }],
			lists: [[tenantSummary('laney'), tenantSummary('builds')]],
			rebuilds: [{ tenants: 2 }]
		});

		const outcome = await onboardDeployment(baseOptions(ui, client));

		expect({
			outcome,
			membershipRebuildTokens: client.membershipRebuildTokens
		}).toStrictEqual({
			outcome: {
				kind: 'already-initialised',
				url: 'https://cache.example.com',
				slugs: ['laney', 'builds']
			} satisfies OnboardOutcome,
			membershipRebuildTokens: ['admin-jwt']
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

		const options = baseOptions(ui, client);
		const outcome = await onboardDeployment(options);

		expect(claimRefusedShape(outcome)).toStrictEqual({
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
		const apiCalls: ApiCall[] = [];
		const api: CloudflareApi = {
			...baseApi(apiCalls),
			getWorkersDevSubdomain: () => {
				apiCalls.push({ method: 'getWorkersDevSubdomain' });
				return subdomainOf('laney')();
			},
			enableWorkersDevRoute: (scriptName) => {
				apiCalls.push({ method: 'enableWorkersDevRoute', scriptName });
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

		expect({ outcome, apiCalls, urls: client.urls }).toStrictEqual({
			outcome: {
				kind: 'no-admin',
				url: 'https://cupboard.laney.workers.dev'
			} satisfies OnboardOutcome,
			apiCalls: [
				{ method: 'getWorkersDevSubdomain' },
				{ method: 'enableWorkersDevRoute', scriptName: 'cupboard' }
			],
			urls: ['https://cupboard.laney.workers.dev']
		});
	});

	it('reports a missing workers.dev subdomain', async () => {
		const apiCalls: ApiCall[] = [];
		const api: CloudflareApi = {
			...baseApi(apiCalls),
			getWorkersDevSubdomain: () => {
				apiCalls.push({ method: 'getWorkersDevSubdomain' });
				return subdomainOf()();
			}
		};
		const { ui } = scriptedUi();
		const client = scriptedClient({});

		const outcome = await onboardDeployment({
			...baseOptions(ui, client),
			api,
			domain: undefined,
			admin: { kind: 'none' }
		});

		expect({ outcome, apiCalls }).toStrictEqual({
			outcome: { kind: 'no-subdomain' },
			apiCalls: [{ method: 'getWorkersDevSubdomain' }]
		});
	});

	it('gives up when the Worker never comes up', async () => {
		const { ui } = scriptedUi();
		const client = scriptedClient({ versions: ['offline', 'offline', 404] });

		const outcome = await onboardDeployment({
			...baseOptions(ui, client),
			attempts: 3
		});

		expect(unreachableShape(outcome)).toStrictEqual({
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

		const outcome = await onboardDeployment({
			...baseOptions(ui, client),
			attempts: 2
		});

		expect(unreachableShape(outcome)).toStrictEqual({
			kind: 'unreachable',
			url: 'https://cache.example.com/t/builds',
			lastProbe: 'HTTP 503: computer says no'
		});
	});

	it('propagates a genuine failure on the version route', async () => {
		const { ui } = scriptedUi();
		const client = scriptedClient({ versions: [403] });

		const resolveOutcome = async (): Promise<
			| { value: unknown }
			| { error: { method: string; path: string; status: number } }
		> => {
			try {
				const value = await onboardDeployment(baseOptions(ui, client));

				return { value };
			} catch (error_: unknown) {
				expect(error_).toBeInstanceOf(CupboardHttpError);

				if (error_ instanceof CupboardHttpError) {
					return {
						error: {
							method: error_.method,
							path: error_.path,
							status: error_.status
						}
					};
				}

				throw error_;
			}
		};

		const outcome = await resolveOutcome();

		expect(outcome).toStrictEqual({
			error: {
				method: 'GET',
				path: '/_version',
				status: 403
			}
		});
	});
});
