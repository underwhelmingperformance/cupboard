import { createServer } from 'node:http';

import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import {
	type InstanceName,
	instanceNameSchema
} from '@cupboard/protocol/instance';
import {
	oidcAudienceSchema,
	oidcIssuerSchema,
	oidcSubjectSchema
} from '@cupboard/protocol/oidc';
import type { R2CredentialCheck } from '@cupboard/protocol/reports';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import type { SignupResponse } from '@cupboard/protocol/signup';
import {
	defaultReadUser,
	type MembershipRebuildResponse,
	type TenantSummary
} from '@cupboard/protocol/tenants';
import type { ProgressHandle, StepLog } from '@cupboard/reporter';
import { ORPCError } from '@orpc/client';
import { StatusCodes } from 'http-status-codes';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { CachedSession } from '../auth/token-store.ts';
import { type AccessCredential, CupboardClient } from '../client/client.ts';
import { CupboardHttpError, UnreachableHostError } from '../errors.ts';

import type { DeployAuthority } from './authority.ts';
import type { CloudflareApi } from './cloudflare-api.ts';
import {
	cloudflareAccountIdSchema,
	databaseIdSchema,
	kvNamespaceIdSchema,
	queueIdSchema,
	scriptNameSchema
} from './identifiers.ts';
import {
	AdminSessionNotCachedError,
	ClaimantChangedError,
	DeploymentClaimFailedError,
	type OnboardClient,
	onboardDeployment,
	type OnboardOptions,
	type OnboardOutcome,
	slugProblem
} from './onboard.ts';
import type { OwnerBinding } from './owner.ts';
import { claimSecretSchema } from './secrets.ts';
import {
	type DeployUi,
	type MenuEntry,
	terminalLink,
	type TextEdit
} from './ui.ts';

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
	readonly notes: { readonly title: string; readonly rows: unknown }[];
	readonly menuMessages: string[];
	readonly menuEntries: (readonly MenuEntry<string>[])[];
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

/**
A UI whose prompts answer from the script and which records what it says.
*/
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
	const notes: { title: string; rows: unknown }[] = [];
	const menuMessages: string[] = [];
	const menuEntries: (readonly MenuEntry<string>[])[] = [];
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
		note: (title, rows) => {
			notes.push({ title, rows });
		},
		menu: (message, entries) => {
			uiCalls.push({ method: 'menu' });
			menuMessages.push(message);
			menuEntries.push(entries);
			const taken =
				remainingMenuChoices.length > 0 ? [remainingMenuChoices.shift()] : [];
			const [scripted] = z.array(z.string().optional()).length(1).parse(taken);

			if (scripted === undefined) {
				return Promise.resolve(absentValues.choice);
			}

			const choice = z
				.custom<(typeof entries)[number]['value']>(
					(value) => value === scripted
				)
				.parse(entries.find((entry) => entry.value === scripted)?.value);

			return Promise.resolve(choice);
		},
		multiSelect: () => Promise.resolve(undefined),
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

			return Promise.resolve(
				choice === undefined
					? undefined
					: cloudflareAccountIdSchema.parse(choice)
			);
		},
		openBrowser: () => {
			uiCalls.push({ method: 'openBrowser' });
			unscriptedInteractiveCalls.push({ method: 'openBrowser' });
		},
		interactive: true,
		data: () => {
			unscriptedInteractiveCalls.push({ method: 'data' });
		},
		confirm: () => {
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

	return {
		ui,
		uiCalls,
		warnings,
		successes,
		infos,
		notes,
		menuMessages,
		menuEntries
	};
}

type ApiCall =
	| { readonly method: keyof CloudflareApi }
	| {
			readonly method: 'putSecret' | 'deleteSecret';
			readonly scriptName: string;
			readonly name: string;
	  }
	| {
			readonly method: 'setWorkersDevRoutes';
			readonly scriptName: string;
			readonly workersDev: boolean;
			readonly previewUrls: boolean;
	  };

const absentString: string | undefined = undefined;
const absentScriptConfiguration = undefined;

function recordApiCall(apiCalls: ApiCall[], method: keyof CloudflareApi): void {
	apiCalls.push({ method });
}

function baseApi(apiCalls: ApiCall[] = []): CloudflareApi {
	return {
		listAccounts: () => {
			recordApiCall(apiCalls, 'listAccounts');
			return Promise.resolve([]);
		},
		listAccountSubscriptions: () => {
			recordApiCall(apiCalls, 'listAccountSubscriptions');
			return Promise.resolve({ kind: 'listed' as const, subscriptions: [] });
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
		findD1Database: () => Promise.resolve(undefined),
		findD1DatabaseName: () => Promise.resolve(undefined),
		listSchedules: () => Promise.resolve([]),
		findConsumerDeadLetterQueue: () => Promise.resolve(undefined),
		ensureD1Database: () => {
			recordApiCall(apiCalls, 'ensureD1Database');
			return Promise.resolve(databaseIdSchema.parse('database-id'));
		},
		ensureKvNamespace: () => {
			recordApiCall(apiCalls, 'ensureKvNamespace');
			return Promise.resolve(kvNamespaceIdSchema.parse('namespace-id'));
		},
		ensureQueue: () => {
			recordApiCall(apiCalls, 'ensureQueue');
			return Promise.resolve(queueIdSchema.parse('queue-id'));
		},
		d1QueryBatch: () => {
			recordApiCall(apiCalls, 'd1QueryBatch');
			return Promise.resolve();
		},
		d1QueryRows: () => {
			recordApiCall(apiCalls, 'd1QueryRows');
			return Promise.resolve([]);
		},
		getScriptConfiguration: () => {
			recordApiCall(apiCalls, 'getScriptConfiguration');
			return Promise.resolve(absentScriptConfiguration);
		},
		uploadScript: () => {
			recordApiCall(apiCalls, 'uploadScript');
			return Promise.resolve();
		},
		listDeployedVersions: () => {
			recordApiCall(apiCalls, 'listDeployedVersions');
			return Promise.resolve([]);
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
		deleteSecret: (scriptName, name) => {
			apiCalls.push({ method: 'deleteSecret', scriptName, name });

			return Promise.resolve();
		},
		listScriptSecrets: () => {
			recordApiCall(apiCalls, 'listScriptSecrets');
			return Promise.resolve([]);
		},
		findZoneId: () => {
			recordApiCall(apiCalls, 'findZoneId');
			return Promise.resolve(undefined);
		},
		findCustomDomain: () => {
			recordApiCall(apiCalls, 'findCustomDomain');
			return Promise.resolve(absentString);
		},
		setCustomDomain: () => {
			recordApiCall(apiCalls, 'setCustomDomain');
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
		setWorkersDevRoutes: (scriptName, routes) => {
			apiCalls.push({ method: 'setWorkersDevRoutes', scriptName, ...routes });
			return Promise.resolve();
		},
		queryWorkerLogs: () => Promise.resolve([])
	};
}

const subdomainOf = (value?: string) => (): Promise<string | undefined> =>
	Promise.resolve(value);

const owner = {
	issuer: oidcIssuerSchema.parse('https://dash.cloudflare.com'),
	subject: oidcSubjectSchema.parse('cf-user-1'),
	audience: oidcAudienceSchema.parse('cupboard-client')
} satisfies OwnerBinding;

function idTokenWith(claims: Record<string, unknown>): string {
	const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');

	return `e30.${payload}.signature`;
}

// The operator's id_token for the claimant that `bootstrapAuthority` confirms.
const claimIdToken = idTokenWith({
	iss: owner.issuer,
	sub: owner.subject,
	aud: owner.audience
});

const adminAuthority: DeployAuthority = { kind: 'admin', admin: owner };

function bootstrapAuthority(
	idToken: () => Promise<string> = () => Promise.resolve(claimIdToken)
): DeployAuthority {
	return {
		kind: 'bootstrap',
		claimSecret: claimSecretSchema.parse('claim-1'),
		idToken,
		claimant: { ...owner, displayName: undefined }
	};
}

function tokenOf(credential: AccessCredential): Promise<string> {
	return typeof credential === 'string'
		? Promise.resolve(credential)
		: credential.get();
}

function tenantSummary(id: string): TenantSummary {
	return {
		id: tenantIdSchema.parse(id),
		status: 'active',
		ownerIssuer: owner.issuer,
		ownerSubject: owner.subject,
		ownerAudience: owner.audience,
		configVersion: 1,
		createdAt: isoTimestampSchema.parse('2026-06-12T00:00:00Z')
	};
}

/**
 * One scripted answer: a value, an HTTP status to fail with, a `fetch` that
 * fails before any response, or a network failure as `CupboardClient`
 * reports it.
 */
type Scripted<T> = T | number | 'offline' | 'unreachable';

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

	if (scripted === 'unreachable') {
		return Promise.reject(
			new UnreachableHostError(
				'cache.example.com',
				new TypeError('fetch failed')
			)
		);
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

function signupRejection(status: number, member: string): Error {
	return new CupboardHttpError('POST', member, status, 'computer says no\n');
}

const notFoundStatus: number = StatusCodes.NOT_FOUND;

function orpcRejection(status: number): Error {
	return new ORPCError(
		status === notFoundStatus ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR',
		{
			status,
			message: 'computer says no'
		}
	);
}

interface ClientScript {
	readonly versions?: Scripted<string>[];
	readonly signup?: Scripted<SignupResponse>[];
	readonly lists?: Scripted<TenantSummary[]>[];
	readonly creates?: Scripted<TenantSummary>[];
	readonly rebuilds?: Scripted<MembershipRebuildResponse>[];
	readonly controlChecks?: Scripted<R2CredentialCheck>[];
	readonly publicKeys?: Scripted<string>[];
	readonly instanceName?: InstanceName;
	readonly instanceConfigured?: boolean;
	readonly cacheAccess?: 'public' | 'private';
}

interface ScriptedClient {
	readonly factory: (url: string) => OnboardClient;
	readonly urls: string[];
	readonly signupBodies: unknown[];
	readonly createdBodies: unknown[];
	readonly membershipRebuildTokens: string[];
	readonly controlCheckTokens: string[];
	readonly cacheAccessTokens: string[];
	readonly initialisedInstanceNames: InstanceName[];
	readonly cachedSessions: { session: CachedSession; target: URL }[];
	readonly cacheSession: (session: CachedSession, target: URL) => Promise<void>;
	/**
	The claim-relevant calls, in order.
	*/
	readonly events: string[];
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
	const cacheAccessTokens: string[] = [];
	const cachedSessions: { session: CachedSession; target: URL }[] = [];
	const initialisedInstanceNames: InstanceName[] = [];
	const events: string[] = [];
	const currentInstanceName =
		script.instanceName ?? instanceNameSchema.parse('cupboard');

	return {
		urls,
		signupBodies,
		createdBodies,
		membershipRebuildTokens,
		controlCheckTokens,
		cacheAccessTokens,
		initialisedInstanceNames,
		cachedSessions,
		events,
		cacheSession: (session, target) => {
			events.push('cacheSession');
			cachedSessions.push({ session, target });
			return Promise.resolve();
		},
		factory: (url) => {
			urls.push(url);

			return {
				cacheAccess: (subjectToken) => {
					cacheAccessTokens.push(subjectToken);
					return Promise.resolve(script.cacheAccess ?? 'public');
				},
				version: () => answer(versions, '/_version'),
				getInstance: async (credential) => {
					events.push(`getInstance:${await tokenOf(credential)}`);

					return script.instanceConfigured === false
						? { state: 'unconfigured' }
						: { state: 'configured', name: currentInstanceName };
				},
				initialiseInstance: (_token, name) => {
					initialisedInstanceNames.push(name);
					return Promise.resolve({ state: 'configured', name });
				},
				signup: (request) => {
					events.push('signup');
					signupBodies.push(request);
					return answer(signups, '/signup', signupRejection);
				},
				listTenants: async () => ({
					tenants: await answer(lists, '/control/tenants', orpcRejection)
				}),
				tokenExchange: () => {
					events.push('tokenExchange');

					return Promise.resolve({
						access_token: 'admin-jwt',
						token_type: 'Bearer',
						expires_in: 900,
						scope: 'admin',
						issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
						refresh_token: 'refresh-1'
					});
				},
				createTenant: (_token, body) => {
					createdBodies.push(body);
					return answer(creates, '/control/tenants', orpcRejection);
				},
				rebuildMembership: async (credential) => {
					membershipRebuildTokens.push(await tokenOf(credential));
					return answer(rebuilds, '/control/membership/rebuild', orpcRejection);
				},
				controlCheck: async (credential) => {
					controlCheckTokens.push(await tokenOf(credential));

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

const unreachableTwice: Scripted<SignupResponse>[] = [
	'unreachable',
	'unreachable'
];

const claimedSignup = { ...owner, claimed: true };

/**
The options every test starts from; spread and override per case.
*/
function baseOptions(ui: DeployUi, client: ScriptedClient): OnboardOptions {
	return {
		api: baseApi(defaultApiCalls),
		ui,
		controlScriptName: scriptNameSchema.parse('cupboard'),
		tenantScriptName: scriptNameSchema.parse('cupboard-tenant'),
		domain: 'cache.example.com',
		instanceName: instanceNameSchema.parse('cupboard'),
		authority: adminAuthority,
		buildVersion: 'v-new',
		cacheAccess: 'public',
		r2: { kind: 'fresh' },
		readPassword: () => readPassword,
		clientFactory: client.factory,
		cacheSession: client.cacheSession,
		sessionCredential: () => 'session-jwt',
		sleep: () => Promise.resolve()
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

/**
 * A loopback port with nothing listening on it, so a connection is refused.
 */
async function closedLoopbackPort(): Promise<number> {
	const server = createServer();

	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve);
	});

	const address = server.address();

	await new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error === undefined) {
				resolve();
			} else {
				reject(error);
			}
		});
	});

	if (address === null || typeof address === 'string') {
		throw new Error('the server has no TCP address');
	}

	return address.port;
}

const readPassword = 'A'.repeat(43);
const read = { user: defaultReadUser, password: readPassword };

const keptR2 = {
	kind: 'kept',
	accountId: cloudflareAccountIdSchema.parse('acc-1'),
	bucketName: 'cupboard-blobs'
} as const;

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
	it('claims the deployment, then deletes the secret and creates the first cache', async () => {
		const { ui, successes } = scriptedUi({ slugs: ['builds'] });
		const client = scriptedClient({
			versions: ['offline', StatusCodes.NOT_FOUND, 'v-new'],
			signup: [claimedSignup],
			lists: [[]],
			creates: [tenantSummary('builds')],
			publicKeys: [StatusCodes.SERVICE_UNAVAILABLE, 'pk-1']
		});
		const apiCalls: ApiCall[] = [];
		const api: CloudflareApi = {
			...baseApi(apiCalls),
			deleteSecret: (scriptName, name) => {
				client.events.push(`deleteSecret:${scriptName}:${name}`);
				apiCalls.push({ method: 'deleteSecret', scriptName, name });
				return Promise.resolve();
			}
		};

		const outcome = await onboardDeployment({
			...baseOptions(ui, client),
			api,
			authority: bootstrapAuthority()
		});

		expect({
			outcome,
			events: client.events,
			signupBodies: client.signupBodies,
			cachedSessions: client.cachedSessions,
			createdBodies: client.createdBodies,
			apiCalls,
			successes
		}).toStrictEqual({
			outcome: {
				kind: 'ready',
				url: 'https://cache.example.com',
				slug: 'builds',
				cacheUrl: new URL('https://cache.example.com/t/builds'),
				publicKey: 'pk-1',
				created: { access: 'public', read }
			} satisfies OnboardOutcome,
			// The secret is gone as soon as `/signup` has answered.
			events: [
				'signup',
				'deleteSecret:cupboard:CUPBOARD_SIGNUP_SECRET',
				'tokenExchange',
				'cacheSession',
				'getInstance:session-jwt'
			],
			signupBodies: [{ subject_token: claimIdToken, claim_secret: 'claim-1' }],
			cachedSessions: [
				{
					session: { accessToken: 'admin-jwt', refreshToken: 'refresh-1' },
					target: new URL('https://cache.example.com')
				}
			],
			// The first cache belongs to the principal that the claim seeded.
			createdBodies: [
				{
					id: 'builds',
					defaultCacheAccess: 'public',
					ownerIssuer: owner.issuer,
					ownerSubject: owner.subject,
					ownerAudience: owner.audience,
					read
				}
			],
			apiCalls: [
				{
					method: 'deleteSecret',
					scriptName: 'cupboard',
					name: 'CUPBOARD_SIGNUP_SECRET'
				}
			],
			successes: ['You are now the admin of this deployment (cf-user-1).']
		});
	});

	it('shows the new admin by the display name in their id_token', async () => {
		const { ui, successes } = scriptedUi({ slugs: [undefined] });
		const client = scriptedClient({
			versions: ['v-new'],
			signup: [claimedSignup],
			lists: [[]]
		});
		const idToken = idTokenWith({
			iss: owner.issuer,
			sub: owner.subject,
			email: 'ada@example.com'
		});

		await onboardDeployment({
			...baseOptions(ui, client),
			api: baseApi(),
			authority: bootstrapAuthority(() => Promise.resolve(idToken))
		});

		expect(successes).toStrictEqual([
			'You are now the admin of this deployment (ada@example.com).'
		]);
	});

	it.each<{
		readonly name: string;
		readonly exchangeFailure?: Error;
		readonly writeFailure?: Error;
		readonly cause: abstract new (...parameters: never[]) => Error;
	}>([
		{
			name: 'the token exchange fails',
			exchangeFailure: new CupboardHttpError('POST', '/token', 500, 'boom'),
			cause: CupboardHttpError
		},
		{
			name: 'the session cannot be written',
			writeFailure: new Error('disk full'),
			cause: Error
		}
	])(
		'reports a successful claim whose session is not cached when $name',
		async ({ exchangeFailure, writeFailure, cause }) => {
			const { ui } = scriptedUi();
			const client = scriptedClient({
				versions: ['v-new'],
				signup: [claimedSignup]
			});
			const apiCalls: ApiCall[] = [];

			let refusal: unknown;

			try {
				await onboardDeployment({
					...baseOptions(ui, client),
					api: baseApi(apiCalls),
					authority: bootstrapAuthority(),
					clientFactory: (url) => ({
						...client.factory(url),
						...(exchangeFailure !== undefined && {
							tokenExchange: () => Promise.reject(exchangeFailure)
						})
					}),
					cacheSession: (session, target) =>
						writeFailure === undefined
							? client.cacheSession(session, target)
							: Promise.reject(writeFailure)
				});
			} catch (error) {
				refusal = error;
			}

			expect({
				refusal:
					refusal instanceof AdminSessionNotCachedError
						? {
								url: refusal.url.href,
								admin: refusal.admin,
								isExpectedCause: refusal.cause instanceof cause
							}
						: refusal,
				apiCalls
			}).toStrictEqual({
				refusal: {
					url: 'https://cache.example.com/',
					admin: owner,
					isExpectedCause: true
				},
				apiCalls: [
					{
						method: 'deleteSecret',
						scriptName: 'cupboard',
						name: 'CUPBOARD_SIGNUP_SECRET'
					}
				]
			});
		}
	);

	it('refuses to claim with an id_token for a different identity from the confirmed one', async () => {
		const { ui } = scriptedUi();
		const client = scriptedClient({ versions: ['v-new'] });
		const apiCalls: ApiCall[] = [];
		const confirmed = {
			issuer: oidcIssuerSchema.parse('https://idp.example.test'),
			subject: oidcSubjectSchema.parse('founder'),
			audience: oidcAudienceSchema.parse('cupboard-cli'),
			displayName: undefined
		};
		const idToken = idTokenWith({
			iss: 'https://idp.example.test',
			sub: 'intruder'
		});

		let refusal: unknown;

		try {
			await onboardDeployment({
				...baseOptions(ui, client),
				api: baseApi(apiCalls),
				authority: {
					kind: 'bootstrap',
					claimSecret: claimSecretSchema.parse('claim-1'),
					idToken: () => Promise.resolve(idToken),
					claimant: confirmed
				}
			});
		} catch (error) {
			refusal = error;
		}

		expect({
			refusal:
				refusal instanceof ClaimantChangedError
					? { confirmed: refusal.confirmed, presented: refusal.presented }
					: refusal,
			events: client.events,
			apiCalls
		}).toStrictEqual({
			refusal: {
				confirmed,
				presented: {
					issuer: 'https://idp.example.test',
					subject: 'intruder'
				}
			},
			events: [],
			apiCalls: [
				{
					method: 'deleteSecret',
					scriptName: 'cupboard',
					name: 'CUPBOARD_SIGNUP_SECRET'
				}
			]
		});
	});

	it('retries the claim when the version read after a 403 fails', async () => {
		const { ui } = scriptedUi({ slugs: [undefined] });
		const client = scriptedClient({
			versions: ['v-new', 'offline'],
			signup: [StatusCodes.FORBIDDEN, claimedSignup],
			lists: [[]]
		});

		const outcome = await onboardDeployment({
			...baseOptions(ui, client),
			api: baseApi(),
			authority: bootstrapAuthority()
		});

		expect({ outcome, signups: client.signupBodies.length }).toStrictEqual({
			outcome: { kind: 'cancelled', url: 'https://cache.example.com' },
			signups: 2
		});
	});

	it('retries the claim while the claim secret takes effect', async () => {
		const { ui } = scriptedUi({ slugs: [undefined] });
		const client = scriptedClient({
			versions: ['v-new', 'v-new'],
			signup: [StatusCodes.FORBIDDEN, claimedSignup],
			lists: [[]]
		});

		const outcome = await onboardDeployment({
			...baseOptions(ui, client),
			api: baseApi(),
			authority: bootstrapAuthority()
		});

		expect({ outcome, events: client.events }).toStrictEqual({
			outcome: { kind: 'cancelled', url: 'https://cache.example.com' },
			events: [
				'signup',
				'signup',
				'tokenExchange',
				'cacheSession',
				'getInstance:session-jwt'
			]
		});
	});

	it.each([
		{
			name: 'a second principal',
			signup: [StatusCodes.CONFLICT],
			isDeleteFailing: false,
			detail: 'POST /signup returned HTTP 409: computer says no',
			status: StatusCodes.CONFLICT,
			advice: 'already-claimed',
			warningCount: 0
		},
		{
			name: 'a secret that never takes effect',
			signup: [StatusCodes.FORBIDDEN, StatusCodes.FORBIDDEN],
			isDeleteFailing: false,
			detail: 'HTTP 403: computer says no',
			status: StatusCodes.FORBIDDEN,
			advice: 'fresh-secret',
			warningCount: 0
		},
		{
			name: 'a server fault',
			signup: [StatusCodes.INTERNAL_SERVER_ERROR],
			isDeleteFailing: false,
			detail: 'HTTP 500: computer says no',
			status: StatusCodes.INTERNAL_SERVER_ERROR,
			advice: 'server-fault',
			warningCount: 0
		},
		{
			name: 'a rejected id_token',
			signup: [StatusCodes.BAD_REQUEST],
			isDeleteFailing: false,
			detail: 'POST /signup returned HTTP 400: computer says no',
			status: StatusCodes.BAD_REQUEST,
			advice: 'rejected-token',
			warningCount: 0
		},
		{
			name: 'a route that is not found',
			signup: [StatusCodes.NOT_FOUND, StatusCodes.NOT_FOUND],
			isDeleteFailing: false,
			detail: 'HTTP 404: computer says no',
			status: StatusCodes.NOT_FOUND,
			advice: 'unexpected-status',
			warningCount: 0
		},
		{
			name: 'rate limiting',
			signup: [StatusCodes.TOO_MANY_REQUESTS, StatusCodes.TOO_MANY_REQUESTS],
			isDeleteFailing: false,
			detail: 'HTTP 429: computer says no',
			status: StatusCodes.TOO_MANY_REQUESTS,
			advice: 'rate-limited',
			warningCount: 0
		},
		{
			name: 'a deployment that cannot be reached',
			signup: unreachableTwice,
			isDeleteFailing: false,
			detail: 'unreachable',
			status: undefined,
			advice: 'unreachable',
			warningCount: 0
		},
		{
			name: 'a second principal, when the secret cannot be removed',
			signup: [StatusCodes.CONFLICT],
			isDeleteFailing: true,
			detail: 'POST /signup returned HTTP 409: computer says no',
			status: StatusCodes.CONFLICT,
			advice: 'already-claimed',
			warningCount: 1
		}
	])(
		'reports a failed claim for $name and still deletes the secret',
		async ({
			signup,
			isDeleteFailing,
			detail,
			status,
			advice,
			warningCount
		}) => {
			const { ui, warnings: shown } = scriptedUi();
			const client = scriptedClient({
				versions: ['v-new', 'v-new', 'v-new'],
				signup
			});
			const apiCalls: ApiCall[] = [];
			const api: CloudflareApi = {
				...baseApi(apiCalls),
				deleteSecret: (scriptName, name) => {
					apiCalls.push({ method: 'deleteSecret', scriptName, name });

					return isDeleteFailing
						? Promise.reject(new Error('Cloudflare is unavailable'))
						: Promise.resolve();
				}
			};

			let refusal: unknown;

			try {
				await onboardDeployment({
					...baseOptions(ui, client),
					api,
					authority: bootstrapAuthority(),
					attempts: 2
				});
			} catch (error) {
				refusal = error;
			}

			expect({
				refusal:
					refusal instanceof DeploymentClaimFailedError
						? {
								detail: refusal.detail,
								status: refusal.status,
								advice: refusal.advice
							}
						: refusal,
				cachedSessions: client.cachedSessions,
				apiCalls,
				warningCount: shown.length
			}).toStrictEqual({
				refusal: { detail, status, advice },
				cachedSessions: [],
				apiCalls: [
					{
						method: 'deleteSecret',
						scriptName: 'cupboard',
						name: 'CUPBOARD_SIGNUP_SECRET'
					}
				],
				warningCount
			});
		}
	);

	it('reports an unreachable deployment when the client cannot connect to /signup', async () => {
		const port = await closedLoopbackPort();
		const unreachable = CupboardClient.fromUrl(
			new URL(`http://127.0.0.1:${String(port)}`),
			{ cache: { kind: 'default' } }
		);
		const { ui } = scriptedUi();
		const client = scriptedClient({ versions: ['v-new'] });

		let refusal: unknown;

		try {
			await onboardDeployment({
				...baseOptions(ui, client),
				api: baseApi(),
				authority: bootstrapAuthority(),
				attempts: 2,
				clientFactory: (url) => ({
					...client.factory(url),
					signup: (request) => unreachable.signup(request)
				})
			});
		} catch (error) {
			refusal = error;
		}

		expect(
			refusal instanceof DeploymentClaimFailedError
				? {
						detail: refusal.detail,
						status: refusal.status,
						advice: refusal.advice
					}
				: refusal
		).toStrictEqual({
			detail: 'unreachable',
			status: undefined,
			advice: 'unreachable'
		});
	});

	it("reports the server's full reason when it rejects the id_token", async () => {
		const reason =
			'Subject token issuer must be an HTTPS URL, or loopback HTTP in local ' +
			'development, without a query or fragment';
		const { ui } = scriptedUi();
		const client = scriptedClient({ versions: ['v-new'] });

		let refusal: unknown;

		try {
			await onboardDeployment({
				...baseOptions(ui, client),
				api: baseApi(),
				authority: bootstrapAuthority(),
				clientFactory: (url) => ({
					...client.factory(url),
					signup: () =>
						Promise.reject(
							new CupboardHttpError(
								'POST',
								'/signup',
								StatusCodes.BAD_REQUEST,
								JSON.stringify({
									error: 'invalid_request',
									error_description: reason,
									problem: 'subject-token-invalid'
								})
							)
						)
				})
			});
		} catch (error) {
			refusal = error;
		}

		expect(
			refusal instanceof DeploymentClaimFailedError
				? { detail: refusal.detail, advice: refusal.advice }
				: refusal
		).toStrictEqual({
			detail: `POST /signup returned HTTP 400: ${reason}`,
			advice: 'rejected-token'
		});
	});

	it('keeps a successful claim when the secret cannot be removed', async () => {
		const { ui, warnings } = scriptedUi({ slugs: [undefined] });
		const client = scriptedClient({
			versions: ['v-new'],
			signup: [claimedSignup],
			lists: [[]]
		});

		const outcome = await onboardDeployment({
			...baseOptions(ui, client),
			api: {
				...baseApi(),
				deleteSecret: () =>
					Promise.reject(new Error('Cloudflare is unavailable'))
			},
			authority: bootstrapAuthority()
		});

		expect({
			outcome,
			events: client.events,
			warningCount: warnings.length
		}).toStrictEqual({
			outcome: { kind: 'cancelled', url: 'https://cache.example.com' },
			events: [
				'signup',
				'tokenExchange',
				'cacheSession',
				'getInstance:session-jwt'
			],
			warningCount: 1
		});
	});

	it.each([
		{
			name: 'stops after eight refusals from the new build',
			versions: Array.from({ length: 8 }, () => 'v-new'),
			signups: 8
		},
		{
			name: 'does not count a refusal from an older build',
			versions: ['v-old', ...Array.from({ length: 8 }, () => 'v-new')],
			signups: 9
		}
	])('$name', async ({ versions, signups }) => {
		const { ui } = scriptedUi();
		const client = scriptedClient({
			versions: ['v-new', ...versions],
			signup: Array.from({ length: signups }, () => StatusCodes.FORBIDDEN)
		});

		let refusal: unknown;

		try {
			await onboardDeployment({
				...baseOptions(ui, client),
				api: baseApi(),
				authority: bootstrapAuthority()
			});
		} catch (error) {
			refusal = error;
		}

		expect({
			isRefused: refusal instanceof DeploymentClaimFailedError,
			signups: client.events.filter((event) => event === 'signup').length
		}).toStrictEqual({ isRefused: true, signups });
	});

	it('updates with the cached admin session, without claiming', async () => {
		const { ui } = scriptedUi({ slugs: ['builds'] });
		const client = scriptedClient({
			versions: ['v-old', 'v-old', 'v-new'],
			lists: [[]],
			creates: [tenantSummary('builds')],
			publicKeys: ['pk-1']
		});

		const outcome = await onboardDeployment(baseOptions(ui, client));

		expect({
			outcome,
			urls: client.urls,
			events: client.events,
			createdBodies: client.createdBodies,
			cachedSessions: client.cachedSessions
		}).toStrictEqual({
			outcome: {
				kind: 'ready',
				url: 'https://cache.example.com',
				slug: 'builds',
				cacheUrl: new URL('https://cache.example.com/t/builds'),
				publicKey: 'pk-1',
				created: { access: 'public', read }
			} satisfies OnboardOutcome,
			urls: ['https://cache.example.com', 'https://cache.example.com/t/builds'],
			events: ['getInstance:session-jwt'],
			createdBodies: [
				{
					id: 'builds',
					defaultCacheAccess: 'public',
					ownerIssuer: owner.issuer,
					ownerSubject: owner.subject,
					ownerAudience: owner.audience,
					read
				}
			],
			cachedSessions: []
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
			lists: [[]],
			creates: [tenantSummary('builds')],
			publicKeys: [StatusCodes.INTERNAL_SERVER_ERROR]
		});

		expect(await onboardDeployment(baseOptions(ui, client))).toStrictEqual({
			kind: 'unreachable',
			url: 'https://cache.example.com/t/builds',
			lastProbe: 'HTTP 500: computer says no',
			lastStatus: 500,
			worker: 'cupboard-tenant'
		});
	});

	it('proves a kept R2 pair through the new cache', async () => {
		const { ui } = scriptedUi({ slugs: ['builds'] });
		const client = scriptedClient({
			versions: ['v-new'],
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
				cacheUrl: new URL('https://cache.example.com/t/builds'),
				publicKey: 'pk-1',
				created: { access: 'public', read }
			} satisfies OnboardOutcome,
			urls: ['https://cache.example.com', 'https://cache.example.com/t/builds'],
			createdBodies: [
				{
					id: 'builds',
					defaultCacheAccess: 'public',
					ownerIssuer: owner.issuer,
					ownerSubject: owner.subject,
					ownerAudience: owner.audience,
					read
				}
			],
			controlCheckTokens: ['session-jwt']
		});
	});

	it('continues when an older deployment has no R2 check procedure', async () => {
		const { ui, warnings } = scriptedUi({ slugs: ['builds'] });
		const client = scriptedClient({
			versions: ['v-new'],
			lists: [[]],
			creates: [tenantSummary('builds')],
			controlChecks: [StatusCodes.NOT_FOUND],
			publicKeys: ['pk-1']
		});

		await onboardDeployment({ ...baseOptions(ui, client), r2: keptR2 });

		expect(warnings).toStrictEqual([
			'Could not check the R2 credentials (the deployment returned HTTP 404).'
		]);
	});

	it('surfaces a server failure from the R2 check procedure', async () => {
		const { ui } = scriptedUi({ slugs: ['builds'] });
		const client = scriptedClient({
			versions: ['v-new'],
			lists: [[]],
			creates: [tenantSummary('builds')],
			controlChecks: [StatusCodes.SERVICE_UNAVAILABLE],
			publicKeys: ['pk-1']
		});

		await expect(
			onboardDeployment({ ...baseOptions(ui, client), r2: keptR2 })
		).rejects.toMatchObject({
			code: 'INTERNAL_SERVER_ERROR',
			status: StatusCodes.SERVICE_UNAVAILABLE
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
			textEdits: [
				{ kind: 'set', value: 'a'.repeat(32) },
				{ kind: 'set', value: goodKey }
			],
			secrets: ['c'.repeat(64), 'd'.repeat(64)]
		});
		const client = scriptedClient({
			versions: ['v-new'],
			lists: [[]],
			creates: [tenantSummary('builds')],
			// After the replacement is stored, the existing Durable Object can
			// return one more result from its old environment before it restarts.
			controlChecks: [
				{ result: 'rejected', status: StatusCodes.FORBIDDEN },
				{ result: 'rejected', status: StatusCodes.FORBIDDEN },
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
						: { kind: 'rejected', status: StatusCodes.FORBIDDEN }
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
				cacheUrl: new URL('https://cache.example.com/t/builds'),
				publicKey: 'pk-1',
				created: { access: 'public', read }
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
			lists: [[]],
			creates: [tenantSummary('builds')],
			controlChecks: [{ result: 'rejected', status: StatusCodes.FORBIDDEN }],
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
				cacheUrl: new URL('https://cache.example.com/t/builds'),
				publicKey: 'pk-1',
				created: { access: 'public', read }
			} satisfies OnboardOutcome,
			infos: [
				'Save this credential now, even if a later onboarding step fails. `cupboard tenant rotate-credential` replaces it.',
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
		const { ui, warnings, menuMessages } = scriptedUi({
			slugs: ['builds', 'builds-2'],
			menuChoices: ['private']
		});
		const client = scriptedClient({
			versions: ['v-new'],
			lists: [[]],
			creates: [StatusCodes.CONFLICT, tenantSummary('builds-2')],
			publicKeys: ['pk-2']
		});

		const outcome = await onboardDeployment({
			...baseOptions(ui, client),
			cacheAccess: undefined
		});

		expect({
			outcome,
			menuMessages,
			createdBodies: client.createdBodies,
			warnings
		}).toStrictEqual({
			outcome: {
				kind: 'ready',
				url: 'https://cache.example.com',
				slug: 'builds-2',
				cacheUrl: new URL('https://cache.example.com/t/builds-2'),
				publicKey: 'pk-2',
				created: { access: 'private', read }
			} satisfies OnboardOutcome,
			menuMessages: ['Who may read from this cache?'],
			createdBodies: ['builds', 'builds-2'].map((id) => ({
				id,
				defaultCacheAccess: 'private',
				ownerIssuer: owner.issuer,
				ownerSubject: owner.subject,
				ownerAudience: owner.audience,
				read
			})),
			warnings: ['"builds" is already taken; choose another.']
		});
	});

	it.each(['public', 'private'] as const)(
		'keeps an existing sole %s cache instead of prompting again',
		async (cacheAccess) => {
			const { ui, infos } = scriptedUi();
			const client = scriptedClient({
				versions: ['v-new'],
				lists: [[tenantSummary('laney')]],
				cacheAccess,
				rebuilds: [{ tenants: 1 }],
				publicKeys: ['pk-1']
			});

			const outcome = await onboardDeployment({
				...baseOptions(ui, client),
				freshIdToken: () => Promise.resolve('id-token-1')
			});

			expect({
				outcome,
				infos,
				membershipRebuildTokens: client.membershipRebuildTokens
			}).toStrictEqual({
				outcome: {
					kind: 'ready',
					url: 'https://cache.example.com',
					slug: 'laney',
					cacheUrl: new URL('https://cache.example.com/t/laney'),
					publicKey: 'pk-1',
					access: cacheAccess
				} satisfies OnboardOutcome,
				infos: ['The cache "laney" already exists; nothing to create.'],
				membershipRebuildTokens: ['session-jwt']
			});
		}
	);

	it('fetches an id_token only to inspect an existing cache', async () => {
		const { ui } = scriptedUi();
		const client = scriptedClient({
			versions: ['v-new'],
			lists: [[tenantSummary('laney')]],
			rebuilds: [{ tenants: 1 }],
			publicKeys: ['pk-1']
		});
		let issued = 0;
		await onboardDeployment({
			...baseOptions(ui, client),
			freshIdToken: () => Promise.resolve(`id-token-${String(++issued)}`)
		});
		expect({
			signupBodies: client.signupBodies,
			cacheAccessTokens: client.cacheAccessTokens
		}).toStrictEqual({
			signupBodies: [],
			cacheAccessTokens: ['id-token-1']
		});
	});

	it('leaves the access of an existing cache unread without an id_token', async () => {
		const { ui } = scriptedUi();
		const client = scriptedClient({
			versions: ['v-new'],
			lists: [[tenantSummary('laney')]],
			rebuilds: [{ tenants: 1 }],
			publicKeys: ['pk-1']
		});

		const outcome = await onboardDeployment(baseOptions(ui, client));

		expect({
			outcome,
			cacheAccessTokens: client.cacheAccessTokens
		}).toStrictEqual({
			outcome: {
				kind: 'ready',
				url: 'https://cache.example.com',
				slug: 'laney',
				cacheUrl: new URL('https://cache.example.com/t/laney'),
				publicKey: 'pk-1'
			} satisfies OnboardOutcome,
			cacheAccessTokens: []
		});
	});
	it('keeps a custom instance name when a redeploy omits the option', async () => {
		const { ui } = scriptedUi();
		const forge = instanceNameSchema.parse('forge');
		const client = scriptedClient({
			instanceName: forge,
			versions: ['v-new'],
			lists: [[tenantSummary('laney')]],
			rebuilds: [{ tenants: 1 }],
			publicKeys: ['pk-1']
		});
		const options = { ...baseOptions(ui, client), instanceName: undefined };

		await onboardDeployment(options);

		expect(client.initialisedInstanceNames).toStrictEqual([forge]);
	});

	it('derives a deployment-specific name for an unconfigured instance', async () => {
		const { ui } = scriptedUi();
		const client = scriptedClient({
			instanceConfigured: false,
			versions: ['v-new'],
			lists: [[tenantSummary('laney')]],
			rebuilds: [{ tenants: 1 }],
			publicKeys: ['pk-1']
		});
		const options = { ...baseOptions(ui, client), instanceName: undefined };

		await onboardDeployment(options);

		expect(client.initialisedInstanceNames).toStrictEqual([
			'cupboard-052b3fa300f45d10'
		]);
	});

	it('returns already initialised when several caches exist', async () => {
		const { ui } = scriptedUi();
		const client = scriptedClient({
			versions: ['v-new'],
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
			membershipRebuildTokens: ['session-jwt']
		});
	});

	it('asks who may read the first cache, and creates it with a credential', async () => {
		const { ui, menuMessages, menuEntries, uiCalls } = scriptedUi({
			slugs: ['builds'],
			menuChoices: ['private']
		});
		const client = scriptedClient({
			versions: ['v-new'],
			lists: [[]],
			creates: [tenantSummary('builds')],
			publicKeys: ['pk-1']
		});

		await onboardDeployment({
			...baseOptions(ui, client),
			cacheAccess: undefined
		});

		expect({
			menuMessages,
			menuEntries,
			prompts: uiCalls.filter(
				({ method }) => method === 'prefixedText' || method === 'menu'
			),
			createdBodies: client.createdBodies
		}).toStrictEqual({
			menuMessages: ['Who may read from this cache?'],
			menuEntries: [
				[
					{
						value: 'private',
						label: 'Only clients with a read credential',
						hint: 'private'
					},
					{
						value: 'public',
						label: 'Anyone who learns the URL',
						hint: 'public'
					}
				]
			],
			prompts: [{ method: 'prefixedText' }, { method: 'menu' }],
			createdBodies: [
				{
					id: 'builds',
					defaultCacheAccess: 'private',
					ownerIssuer: owner.issuer,
					ownerSubject: owner.subject,
					ownerAudience: owner.audience,
					read
				}
			]
		});
	});

	it('takes the requested access without asking', async () => {
		const { ui, menuMessages } = scriptedUi({ slugs: ['builds'] });
		const client = scriptedClient({
			versions: ['v-new'],
			lists: [[]],
			creates: [tenantSummary('builds')],
			publicKeys: ['pk-1']
		});

		await onboardDeployment({
			...baseOptions(ui, client),
			cacheAccess: 'private'
		});

		expect({
			menuMessages,
			createdBodies: client.createdBodies
		}).toStrictEqual({
			menuMessages: [],
			createdBodies: [
				{
					id: 'builds',
					defaultCacheAccess: 'private',
					ownerIssuer: owner.issuer,
					ownerSubject: owner.subject,
					ownerAudience: owner.audience,
					read
				}
			]
		});
	});

	it('stops with the claim intact when the access prompt is cancelled', async () => {
		const { ui } = scriptedUi({ slugs: ['builds'], menuChoices: [undefined] });
		const client = scriptedClient({
			versions: ['v-new'],
			lists: [[]]
		});

		expect(
			await onboardDeployment({
				...baseOptions(ui, client),
				cacheAccess: undefined
			})
		).toStrictEqual({
			kind: 'cancelled',
			url: 'https://cache.example.com'
		});
	});

	it('stops with the claim intact when the slug prompt is cancelled', async () => {
		const { ui } = scriptedUi({ slugs: [undefined] });
		const client = scriptedClient({
			versions: ['v-new'],
			lists: [[]]
		});

		expect(await onboardDeployment(baseOptions(ui, client))).toStrictEqual({
			kind: 'cancelled',
			url: 'https://cache.example.com'
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
			setWorkersDevRoutes: (scriptName, routes) => {
				apiCalls.push({ method: 'setWorkersDevRoutes', scriptName, ...routes });
				return Promise.resolve();
			}
		};
		const { ui } = scriptedUi();
		const client = scriptedClient({ versions: ['v-new'] });

		const outcome = await onboardDeployment({
			...baseOptions(ui, client),
			api,
			domain: undefined,
			authority: { kind: 'unclaimed' }
		});

		expect({ outcome, apiCalls, urls: client.urls }).toStrictEqual({
			outcome: {
				kind: 'unclaimed',
				url: 'https://cupboard.laney.workers.dev'
			} satisfies OnboardOutcome,
			apiCalls: [
				{ method: 'getWorkersDevSubdomain' },
				{
					method: 'setWorkersDevRoutes',
					scriptName: 'cupboard',
					workersDev: true,
					previewUrls: true
				}
			],
			// A deployment without an admin gets no requests.
			urls: []
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
			domain: undefined
		});

		expect({ outcome, apiCalls }).toStrictEqual({
			outcome: { kind: 'no-subdomain' },
			apiCalls: [{ method: 'getWorkersDevSubdomain' }]
		});
	});

	it.each([
		{
			name: 'the account has no workers.dev subdomain',
			domain: undefined,
			outcome: { kind: 'unclaimed', url: undefined }
		},
		{
			name: 'the deployment has a URL',
			domain: 'cache.example.com',
			outcome: { kind: 'unclaimed', url: 'https://cache.example.com' }
		}
	])(
		'reports an unclaimed deployment without waiting for the build when $name',
		async ({ domain, outcome }) => {
			const { ui } = scriptedUi();
			const client = scriptedClient({
				versions: [StatusCodes.NOT_FOUND, StatusCodes.NOT_FOUND]
			});

			expect({
				outcome: await onboardDeployment({
					...baseOptions(ui, client),
					api: { ...baseApi(), getWorkersDevSubdomain: subdomainOf() },
					domain,
					authority: { kind: 'unclaimed' },
					attempts: 2
				}),
				urls: client.urls
			}).toStrictEqual({ outcome, urls: [] });
		}
	);

	it('gives up when the Worker never comes up', async () => {
		const { ui } = scriptedUi();
		const client = scriptedClient({
			versions: ['offline', 'offline', StatusCodes.NOT_FOUND]
		});

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

	it('retains the proposed credential when the create response is lost', async () => {
		const { ui, notes } = scriptedUi({ slugs: ['builds'] });
		const client = scriptedClient({
			versions: ['v-new'],
			lists: [[]],
			creates: ['offline']
		});
		await expect(onboardDeployment(baseOptions(ui, client))).rejects.toThrow(
			'fetch failed'
		);
		expect(notes).toStrictEqual([
			{
				title:
					'Unconfirmed read credential for https://cache.example.com/t/builds',
				rows: [
					{ label: 'Read user', value: read.user },
					{ label: 'Read password', value: read.password }
				]
			}
		]);
	});
	it('gives up on the cache URL when the new tenant never responds', async () => {
		const { ui, notes } = scriptedUi({ slugs: ['builds'] });
		const client = scriptedClient({
			versions: ['v-new'],
			lists: [[]],
			creates: [tenantSummary('builds')],
			publicKeys: [
				StatusCodes.SERVICE_UNAVAILABLE,
				StatusCodes.SERVICE_UNAVAILABLE
			]
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
		expect(notes).toContainEqual({
			title: 'Read credential for https://cache.example.com/t/builds',
			rows: [
				{ label: 'Read user', value: read.user },
				{ label: 'Read password', value: read.password }
			]
		});
	});

	it('propagates a genuine failure on the version route', async () => {
		const { ui } = scriptedUi();
		const client = scriptedClient({ versions: [StatusCodes.FORBIDDEN] });

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
				status: StatusCodes.FORBIDDEN
			}
		});
	});
});
