import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	capturingReporter as reporter,
	fakeCliUi
} from '@cupboard/cli-ui/testing';
import { cacheNameSchema, type CacheScope } from '@cupboard/nix-store/scalars';
import { isGrantPermittedByRule } from '@cupboard/protocol/grant-match';
import type { AuthorizationDetail } from '@cupboard/protocol/grants';
import {
	type OidcTrustAddBodyInput,
	oidcTrustListResponseSchema,
	type OidcTrustSummary,
	type OidcTrustSummaryInput,
	oidcTrustSummarySchema,
	trustRuleIdSchema
} from '@cupboard/protocol/oidc';
import type { ResultPayload, ResultRow } from '@cupboard/reporter';
import { ORPCError } from '@orpc/client';
import { Command } from 'commander';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildProgram } from '../cli.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import {
	CliUsageError,
	InvalidClaimError,
	OwnerTrustRuleImmutableError,
	TrustGrantsFileConflictError,
	TrustGrantsRequiredError,
	TrustRuleChangedError,
	TrustRuleDisabledError,
	TrustRuleGrantsPermittedError,
	TrustRuleRepositoryPinRequiredError,
	WorkflowReferenceMutableError
} from '../errors.ts';

import {
	claimsForAdd,
	githubBranchAddBody,
	githubPrAddBody,
	githubPrCloseAddBody,
	githubTagAddBody,
	type OidcTrustClient,
	type OidcTrustExtendClient,
	registerControlOidcTrustCommands,
	registerOidcTrustCommands,
	ruleOptionsGiven,
	runOidcTrustAdd,
	runOidcTrustExtend,
	runOidcTrustList,
	runOidcTrustRemove,
	runOidcTrustShow
} from './oidc-trust.ts';
import { type RepositoryIdentity } from './oidc-trust/github.ts';

const mocks = vi.hoisted(() => ({
	add: vi.fn<OidcTrustClient['add']>(),
	get: vi.fn<OidcTrustExtendClient['get']>(),
	extend: vi.fn<OidcTrustExtendClient['extend']>(),
	readBuildInputs: vi.fn<(input: { hash: string }) => Promise<unknown>>(),
	lookup: vi.fn<(repository: string) => Promise<RepositoryIdentity>>(),
	verify:
		vi.fn<
			typeof import('./github/workflow-reference.ts').verifyWorkflowReference
		>(),
	resolveWorkflowRef:
		vi.fn<(repository: string, reference: string) => Promise<string>>()
}));

vi.mock('./github/discovery.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('./github/discovery.ts')>()),
	githubWorkflowSource: () => ({
		resolveWorkflowReference: mocks.resolveWorkflowRef
	})
}));

vi.mock('./github/workflow-reference.ts', () => ({
	verifyWorkflowReference: mocks.verify
}));

// The commands build their oRPC clients from these functions, so a command
// parsed from argv sends its rule to `mocks.add`.
vi.mock('../client/orpc.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../client/orpc.ts')>()),
	tenantRpc: () => ({
		oidcTrust: { add: mocks.add, get: mocks.get, extend: mocks.extend },
		buildInputs: { read: { inDefaultCache: mocks.readBuildInputs } }
	}),
	controlRpc: () => ({ oidcTrust: { add: mocks.add } })
}));

vi.mock('./oidc-trust/github.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('./oidc-trust/github.ts')>()),
	lookupRepository: mocks.lookup
}));

// A current server answers the probe for build inputs, so the presets include
// the `build-inputs` grant unless a test answers as an earlier server.
beforeEach(() => {
	mocks.readBuildInputs.mockReset();
	mocks.readBuildInputs.mockResolvedValue({ status: 'absent' });
});

const identity: RepositoryIdentity = {
	repositoryId: 1234,
	repositoryOwnerId: 5678,
	fullName: 'acme/infra',
	defaultBranch: 'main'
};
const tenantUrl = 'https://cache.example.workers.dev/t/acme';
const tenantBase = parseWorkerUrl(tenantUrl);
const uploadActions = [
	'upload:negotiate',
	'upload:status',
	'upload:commit',
	'upload:confirm'
];
const attestActions = ['attestation:negotiate', 'attestation:attach'];
// The branch and tag presets publish trusted builds, so they may add build
// inputs to paths that the cache already has. The pull-request preset may not.
const buildInputsActions = ['build-inputs:record'];
// A preset rule covers a run's whole retention conversation: replacing a
// target root's list, reading that list, and attaching to the run root every
// push binds.
const rootActions = ['root:set', 'root:list', 'root:attach'];
// Only the pull-request preset manages the cache itself. Its cache does not
// exist before the first run and does not outlive the pull request.
const cacheLifecycleActions = ['cache:create', 'cache:close', 'cache:reopen'];
const prCaptureSubstitution = {
	pr: {
		claim: 'ref',
		capture: { pattern: '^refs/pull/(?<pr>[0-9]+)/merge$', group: 'pr' }
	}
};
const prCacheBinding = {
	kind: 'named',
	equalsTemplate: 'gh-{repository_id}-pr-{pr}',
	substitutions: {
		repository_id: { claim: 'repository_id' },
		...prCaptureSubstitution
	},
	validate: 'cacheName'
};
const prRootBinding = {
	equalsTemplate: 'github:acme/infra/pr-{pr}/',
	substitutions: prCaptureSubstitution,
	validate: 'rootName'
};
const tagSubstitutions = {
	tag: {
		claim: 'ref',
		capture: {
			pattern: '^refs/tags/(?<tag>[a-z0-9][a-z0-9._-]*)$',
			group: 'tag'
		}
	}
};
const tagCacheBinding = {
	kind: 'named',
	equalsTemplate: '{tag}',
	substitutions: tagSubstitutions,
	validate: 'cacheName'
};
const tagRootBinding = {
	equalsTemplate: 'github:acme/infra/{tag}/',
	substitutions: tagSubstitutions,
	validate: 'rootName'
};

const ciGrant: OidcTrustSummary['permittedGrants'][number] = {
	type: 'cupboard_cache',
	actions: ['upload:negotiate', 'upload:status', 'upload:commit'],
	resources: {
		cache: { kind: 'named', exact: 'owner-ci', validate: 'cacheName' }
	}
};
const ciRuleRows: ResultRow[] = [
	{ label: 'Rule', value: 'rule-1' },
	{ label: 'Issuer', value: 'https://token.actions.githubusercontent.com' },
	{ label: 'Audience', value: 'https://cache.example.workers.dev' },
	{ label: 'Claims', value: 'repository_owner_id=5678' },
	{ label: '', value: 'repository_id=1234' },
	{
		label: 'Access',
		value:
			'Cache owner-ci: request publication of paths, check publication status, complete publication of uploaded paths'
	},
	{ label: 'State', value: 'enabled' }
];

function summary(overrides: Partial<OidcTrustSummaryInput>) {
	return oidcTrustSummarySchema.parse({
		id: 'rule-1',
		issuer: 'https://token.actions.githubusercontent.com',
		audience: 'https://cache.example.workers.dev',
		claims: { repository_owner_id: '5678' },
		permittedGrants: [ciGrant],
		disabled: false,
		...overrides
	});
}

function trustClient(overrides: Partial<OidcTrustClient>): OidcTrustClient {
	return {
		list: () => Promise.resolve({ rules: [] }),
		get: ({ id }) => Promise.resolve(summary({ id })),
		add: (body) => Promise.resolve(summary({ ...body, id: 'rule-1' })),
		remove: ({ id }) => Promise.resolve({ id, removed: false }),
		...overrides
	};
}

describe('runOidcTrustList', () => {
	it('reports a row per rule, flagging disabled ones', async () => {
		const results: ResultRow[][] = [];
		const payloads: ResultPayload[] = [];
		const response = oidcTrustListResponseSchema.parse({
			rules: [
				summary({
					id: 'owner',
					permittedGrants: [{ type: 'cupboard_wildcard' }],
					issuer: 'https://idp.example.test/realms/a',
					claims: { sub: 'owner-1' }
				}),
				summary({ id: 'rule-1', disabled: true })
			]
		});

		const captured = reporter(results);

		await runOidcTrustList(
			{
				...captured,
				result(payload) {
					payloads.push(payload);
					captured.result(payload);
				}
			},
			{
				list: () => Promise.resolve(response)
			}
		);

		const rows = [
			{ label: 'Rule', value: 'owner' },
			{ label: 'Issuer', value: 'https://idp.example.test/realms/a' },
			{ label: 'Audience', value: 'https://cache.example.workers.dev' },
			{ label: 'Claims', value: 'sub=owner-1' },
			{ label: 'Access', value: 'Every operation on every resource' },
			{ label: 'State', value: 'enabled' },
			...ciRuleRows.filter((row) => row.label !== '' && row.label !== 'State'),
			{ label: 'State', value: 'disabled' }
		];

		expect({ results, payloads }).toStrictEqual({
			results: [rows],
			payloads: [
				{
					kind: 'oidc-trust-rules',
					title: 'Trust rules',
					data: response.rules,
					rows,
					empty: 'No OIDC trust rules.'
				}
			]
		});
	});

	it('warns about an enabled rule that the server cannot read, and notes a disabled one', async () => {
		const results: ResultRow[][] = [];
		const infos: string[] = [];
		const warns: string[] = [];
		const response = oidcTrustListResponseSchema.parse({
			rules: [summary({ id: 'rule-1' })],
			unreadable: [
				{ id: 'rule-2', disabled: false },
				{ id: 'rule-3', disabled: true }
			]
		});

		await runOidcTrustList(reporter(results, infos, warns), {
			list: () => Promise.resolve(response)
		});

		expect({ results, infos, warns }).toStrictEqual({
			results: [ciRuleRows.filter((row) => row.label !== '')],
			infos: [
				'The server cannot read trust rule rule-3. The rule is disabled and remains only as a record.'
			],
			warns: [
				'Trust rule rule-2 cannot authorise new sign-ins. Repair or remove the rule. Other readable rules can still authorise access.'
			]
		});
	});

	it('marks GitHub Actions rules without a repository pin, and warns about the enabled ones', async () => {
		const results: ResultRow[][] = [];
		const warns: string[] = [];
		const response = oidcTrustListResponseSchema.parse({
			rules: [
				summary({ id: 'rule-1' }),
				summary({ id: 'branch-only', claims: { ref: 'refs/heads/main' } }),
				summary({
					id: 'retired',
					claims: { sub: 'repo:acme/infra:ref:refs/heads/main' },
					disabled: true
				})
			]
		});

		await runOidcTrustList(
			reporter(results, [], warns),
			{ list: () => Promise.resolve(response) },
			'tenant',
			new URL(tenantUrl)
		);

		const unpinnedRows = (
			id: string,
			claim: string,
			state: string
		): ResultRow[] => [
			{ label: 'Rule', value: id },
			{ label: 'Issuer', value: 'https://token.actions.githubusercontent.com' },
			{ label: 'Audience', value: 'https://cache.example.workers.dev' },
			{ label: 'Claims', value: claim },
			{
				label: 'Repository pin',
				value:
					'None. The rule requires no exact repository_id or repository_owner_id claim.'
			},
			...ciRuleRows.filter((row) => row.label === 'Access'),
			{ label: 'State', value: state }
		];

		expect({ results, warns }).toStrictEqual({
			results: [
				[
					...ciRuleRows.filter((row) => row.label !== ''),
					...unpinnedRows('branch-only', 'ref=refs/heads/main', 'enabled'),
					...unpinnedRows(
						'retired',
						'sub=repo:acme/infra:ref:refs/heads/main',
						'disabled'
					)
				]
			],
			warns: [
				'Trust rule branch-only accepts GitHub Actions tokens without an exact repository_id or repository_owner_id claim. Any repository whose tokens satisfy its other claims can use it. Add a rule that pins the repository, then remove this rule with `cupboard oidc-trust remove https://cache.example.workers.dev/t/acme branch-only`.'
			]
		});
	});

	it.each([
		{
			plane: 'tenant' as const,
			id: 'owner',
			warning:
				"Trust rule owner is the tenant's owner rule, and it accepts GitHub Actions tokens without an exact repository_id or repository_owner_id claim. Its subject binds at most the repository's name. The owner rule cannot be removed, and a tenant's owner cannot be changed. Do not rename or delete the repository in its subject, or the account that owns the repository. Either change frees the name, and a new repository with the same name would match the rule. To stop trusting it, ask the operator to remove the tenant and create a new one whose owner is a person."
		},
		{
			plane: 'control' as const,
			id: 'signup',
			warning:
				"Trust rule signup is the rule for the deployment's admin, and it accepts GitHub Actions tokens without an exact repository_id or repository_owner_id claim. Its subject binds at most the repository's name. Before you remove it, add a control trust rule with the same issuer, audience and sub claim, the repository's exact repository_id and repository_owner_id, and the wildcard grant. Without such a rule, the admin can no longer sign in and cupboard init stops. Then remove this rule with `cupboard control-oidc-trust remove https://cache.example.workers.dev signup`."
		},
		{
			plane: 'control' as const,
			id: 'ci-deploy',
			warning:
				'Trust rule ci-deploy accepts GitHub Actions tokens without an exact repository_id or repository_owner_id claim. Any repository whose tokens satisfy its other claims can use it. Add a rule that pins the repository, then remove this rule with `cupboard control-oidc-trust remove https://cache.example.workers.dev ci-deploy`.'
		}
	])(
		'gives $plane advice for the unpinned GitHub Actions rule $id',
		async ({ plane, id, warning }) => {
			const warns: string[] = [];

			await runOidcTrustList(
				reporter([], [], warns),
				{
					list: () =>
						Promise.resolve(
							oidcTrustListResponseSchema.parse({
								rules: [
									summary({
										id,
										claims: { sub: 'repo:acme/infra:ref:refs/heads/main' },
										permittedGrants: [{ type: 'cupboard_wildcard' }]
									})
								]
							})
						)
				},
				plane,
				new URL(
					plane === 'tenant' ? tenantUrl : 'https://cache.example.workers.dev'
				)
			);

			expect(warns).toStrictEqual([warning]);
		}
	);

	it('gives the machine-readable warning for an unpinned owner rule', async () => {
		const details: { label: string; value: string | undefined }[] = [];

		await runOidcTrustList(
			{
				...reporter([]),
				warn: (label, value) => {
					details.push({ label, value });
				}
			},
			{
				list: () =>
					Promise.resolve(
						oidcTrustListResponseSchema.parse({
							rules: [
								summary({
									id: 'owner',
									claims: { sub: 'repo:acme/infra:ref:refs/heads/main' },
									permittedGrants: [{ type: 'cupboard_wildcard' }]
								})
							]
						})
					)
			},
			'tenant',
			new URL(tenantUrl)
		);

		expect(details).toStrictEqual([
			{
				label: 'The owner rule does not pin a GitHub repository',
				value:
					'The owner rule cannot be removed. Do not rename or delete the repository in its subject or the account that owns it. To stop trusting it, ask the operator to remove the tenant.'
			}
		]);
	});

	it('warns that an unreadable operator rule blocks operator sign-ins', async () => {
		const results: ResultRow[][] = [];
		const warns: string[] = [];
		await runOidcTrustList(
			reporter(results, [], warns),
			{
				list: () =>
					Promise.resolve({
						rules: [],
						unreadable: [
							{ id: trustRuleIdSchema.parse('broken'), disabled: false }
						]
					})
			},
			'control',
			new URL('https://cache.example.workers.dev')
		);
		expect({ results, warns }).toStrictEqual({
			results: [[]],
			warns: [
				'Operator sign-ins are blocked by unreadable trust rule broken. Repair or remove it with `cupboard control-oidc-trust remove https://cache.example.workers.dev broken`.'
			]
		});
	});

	it('does not report an empty rule list when an unreadable rule exists', async () => {
		const results: ResultRow[][] = [];
		const payloads: ResultPayload[] = [];
		const infos: string[] = [];
		const warns: string[] = [];
		const captured = reporter(results, infos, warns);

		await runOidcTrustList(
			{
				...captured,
				result(payload) {
					payloads.push(payload);
					captured.result(payload);
				}
			},
			{
				list: () =>
					Promise.resolve({
						rules: [],
						unreadable: [
							{ id: trustRuleIdSchema.parse('rule-2'), disabled: false }
						]
					})
			}
		);

		expect({ results, payloads, infos, warns }).toStrictEqual({
			results: [[]],
			payloads: [
				{
					kind: 'oidc-trust-rules',
					title: 'Trust rules',
					data: [{ id: 'rule-2', disabled: false, unreadable: true }],
					rows: [],
					empty: undefined
				}
			],
			infos: [],
			warns: [
				'Trust rule rule-2 cannot authorise new sign-ins. Repair or remove the rule. Other readable rules can still authorise access.'
			]
		});
	});

	it('reports nothing when there are no rules', async () => {
		const results: ResultRow[][] = [];
		const infos: string[] = [];

		await runOidcTrustList(reporter(results, infos), {
			list: () => Promise.resolve({ rules: [] })
		});

		expect({ results, infos }).toStrictEqual({
			results: [[]],
			infos: ['No OIDC trust rules.']
		});
	});
});

describe('runOidcTrustAdd', () => {
	it('adds the rule and reports its summary', async () => {
		const calls: OidcTrustAddBodyInput[] = [];
		const results: ResultRow[][] = [];
		const body: OidcTrustAddBodyInput = {
			issuer: 'https://token.actions.githubusercontent.com',
			audience: 'https://cache.example.workers.dev',
			claims: { repository_owner_id: '5678', repository_id: '1234' },
			permittedGrants: [ciGrant]
		};

		await runOidcTrustAdd(body, reporter(results), {
			add(added) {
				calls.push(added);
				return Promise.resolve(summary({ id: 'rule-1', claims: body.claims }));
			}
		});

		expect({ calls, results }).toStrictEqual({
			calls: [body],
			results: [ciRuleRows]
		});
	});
});

const controlRule: OidcTrustAddBodyInput = {
	issuer: 'https://dash.cloudflare.com',
	audience: 'client-id',
	claims: { sub: 'operator-2' },
	permittedGrants: [{ type: 'cupboard_wildcard' }]
};

const tenantRule: OidcTrustAddBodyInput = {
	issuer: 'https://token.actions.githubusercontent.com',
	audience: tenantUrl,
	claims: { repository_owner_id: '5678' },
	permittedGrants: [ciGrant]
};

/**
Runs `add --from-file` through the command line with the rule written to a
temporary file. Returns 'added', or the error that the command threw.
*/
async function addFromFile(
	command: 'oidc-trust' | 'control-oidc-trust',
	url: string,
	rule: object
): Promise<unknown> {
	const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-rule-'));
	const file = path.join(directory, 'rule.json');

	try {
		await writeFile(file, JSON.stringify(rule));
		await buildProgram().parseAsync([
			'node',
			'cupboard',
			'--output-mode',
			'json',
			command,
			'add',
			url,
			'--from-file',
			file
		]);

		return 'added';
	} catch (error) {
		return error;
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

describe('oidc-trust add --from-file', () => {
	beforeEach(() => {
		mocks.add.mockReset();
		mocks.add.mockImplementation((body) =>
			Promise.resolve(summary({ ...body, id: 'rule-1' }))
		);
	});

	const fileCases: readonly {
		readonly name: string;
		readonly command: 'oidc-trust' | 'control-oidc-trust';
		readonly url: string;
		readonly rule: OidcTrustAddBodyInput;
	}[] = [
		{
			name: 'a control-plane rule',
			command: 'control-oidc-trust',
			url: 'https://cupboard.example.workers.dev',
			rule: controlRule
		},
		{
			name: 'a tenant rule',
			command: 'oidc-trust',
			url: tenantUrl,
			rule: tenantRule
		}
	];

	it.each(fileCases)(
		'sends $name from the file',
		async ({ command, url, rule }) => {
			const outcome = await addFromFile(command, url, rule);

			expect({ outcome, calls: mocks.add.mock.calls }).toStrictEqual({
				outcome: 'added',
				calls: [[rule]]
			});
		}
	);

	it('refuses a control-plane rule without an exact sub claim before sending it', async () => {
		const outcome = await addFromFile(
			'control-oidc-trust',
			'https://cupboard.example.workers.dev',
			{ ...controlRule, claims: { email: 'operator@example.com' } }
		);

		expect({
			refused: outcome instanceof InvalidClaimError,
			calls: mocks.add.mock.calls
		}).toStrictEqual({ refused: true, calls: [] });
	});
});

describe('runOidcTrustShow', () => {
	it('fetches the rule by id and reports its summary', async () => {
		const calls: { id: string }[] = [];
		const results: ResultRow[][] = [];

		await runOidcTrustShow(
			trustRuleIdSchema.parse('rule-1'),
			reporter(results),
			{
				get(input) {
					calls.push(input);
					return Promise.resolve(
						summary({
							id: 'rule-1',
							claims: { repository_owner_id: '5678', repository_id: '1234' }
						})
					);
				}
			}
		);

		expect({ calls, results }).toStrictEqual({
			calls: [{ id: 'rule-1' }],
			results: [ciRuleRows]
		});
	});
});

describe('runOidcTrustRemove', () => {
	it.each([
		{ removed: true, value: 'yes' },
		{ removed: false, value: 'not present' }
	])('reports removed=$removed once confirmed', async ({ removed, value }) => {
		const { ui, captured } = fakeCliUi({ confirm: 'yes' });
		const response = { id: trustRuleIdSchema.parse('rule-1'), removed };

		await runOidcTrustRemove(
			trustRuleIdSchema.parse('rule-1'),
			ui,
			trustClient({ remove: () => Promise.resolve(response) })
		);

		expect(captured.results).toStrictEqual([
			{
				kind: 'oidc-trust-rule',
				title: 'Trust rule',
				data: response,
				rows: [
					{ label: 'Rule', value: 'rule-1' },
					{ label: 'Removed', value }
				]
			}
		]);
	});

	it('leaves the rule in place when the confirmation is declined', async () => {
		const { ui, captured } = fakeCliUi({ confirm: 'no' });

		await runOidcTrustRemove(
			trustRuleIdSchema.parse('rule-1'),
			ui,
			trustClient({})
		);

		expect({
			results: captured.results,
			cancellations: captured.cancellations
		}).toStrictEqual({
			results: [],
			cancellations: ['The trust rule was left in place.']
		});
	});
});

type Grant = OidcTrustSummary['permittedGrants'][number];

const extendedRule = summary({
	claims: { repository_owner_id: '5678', repository_id: '1234' }
});
const buildInputsGrant: Grant = {
	type: 'cupboard_cache',
	actions: ['build-inputs:record'],
	resources: {
		cache: { kind: 'named', exact: 'owner-ci', validate: 'cacheName' }
	}
};
const branchRootGrant: Grant = {
	type: 'cupboard_cache',
	actions: ['root:set', 'root:list'],
	resources: {
		cache: { kind: 'default' },
		root: { exact: 'github:acme/infra/main/', validate: 'rootName' }
	}
};
function parseGrant(grant: unknown): Grant {
	return oidcTrustSummarySchema.shape.permittedGrants.element.parse(grant);
}

const prCacheGrant = parseGrant({
	type: 'cupboard_cache',
	actions: uploadActions,
	resources: { cache: prCacheBinding }
});

interface ExtendCalls {
	readonly gets: { id: string }[];
	readonly extends: Parameters<OidcTrustExtendClient['extend']>[0][];
}

/**
An extend client that reads `rule` and records each request. `extend` answers
with the rule that the server would store, unless `refusal` is given.
*/
function extendClient(
	rule: OidcTrustSummary,
	refusal?: Error
): { client: OidcTrustExtendClient; calls: ExtendCalls } {
	const calls: ExtendCalls = { gets: [], extends: [] };

	return {
		calls,
		client: {
			get(input) {
				calls.gets.push(input);
				return Promise.resolve(rule);
			},
			extend(input) {
				calls.extends.push(input);

				if (refusal !== undefined) {
					return Promise.reject(refusal);
				}

				return Promise.resolve(
					oidcTrustSummarySchema.parse({
						...input.expected,
						permittedGrants: [
							...input.expected.permittedGrants,
							...input.permittedGrants
						]
					})
				);
			}
		}
	};
}

/**
Runs `runOidcTrustExtend` and confirms the extension. Returns 'extended', or
the error that it threw.
*/
async function extendOutcome(
	id: string,
	grants: readonly Grant[],
	client: OidcTrustExtendClient
): Promise<unknown> {
	const { ui } = fakeCliUi({ confirm: 'yes' });

	try {
		await runOidcTrustExtend(trustRuleIdSchema.parse(id), grants, ui, client);

		return 'extended';
	} catch (error) {
		return error;
	}
}

function noteBody(rows: readonly ResultRow[]): string {
	return rows.map((row) => `${row.label}\t${row.value}`).join('\n');
}

describe('runOidcTrustExtend', () => {
	const ruleId = trustRuleIdSchema.parse('rule-1');
	const addedAccess = 'Cache owner-ci: record the build inputs of cached paths';
	const extendedRows: ResultRow[] = [
		...ciRuleRows.slice(0, 6),
		{ label: '', value: addedAccess },
		{ label: 'State', value: 'enabled' }
	];
	const planRows: ResultRow[] = [
		{ label: 'Grants to add', value: addedAccess },
		{ label: 'Resulting rule', value: 'rule-1' },
		...extendedRows.slice(1)
	];
	const extended = summary({
		...extendedRule,
		permittedGrants: [ciGrant, buildInputsGrant]
	});
	const finalResult: ResultPayload = {
		kind: 'oidc-trust-rule',
		title: 'Trust rule',
		data: extended,
		rows: extendedRows
	};

	it.each([
		{
			mode: 'shows the plan as a note at a terminal',
			interactive: true,
			notes: [
				{ title: 'Planned trust rule extension', body: noteBody(planRows) }
			],
			results: [finalResult]
		},
		{
			mode: 'reports the plan as a result when it cannot prompt',
			interactive: false,
			notes: [],
			results: [
				{
					kind: 'oidc-trust-extension-plan',
					title: 'Planned trust rule extension',
					data: {
						id: 'rule-1',
						expected: extendedRule,
						permittedGrants: [buildInputsGrant]
					},
					rows: planRows
				},
				finalResult
			]
		}
	])(
		'$mode, then appends the grants to the rule that it read',
		async ({ interactive, notes, results }) => {
			const { ui, captured } = fakeCliUi({ interactive, confirm: 'yes' });
			const { client, calls } = extendClient(extendedRule);

			await runOidcTrustExtend(ruleId, [buildInputsGrant], ui, client);

			expect({
				calls,
				notes: captured.notes,
				confirms: captured.confirms,
				results: captured.results
			}).toStrictEqual({
				calls: {
					gets: [{ id: 'rule-1' }],
					extends: [
						{
							id: 'rule-1',
							expected: extendedRule,
							permittedGrants: [buildInputsGrant]
						}
					]
				},
				notes,
				confirms: [
					{
						message: 'Add these grants to OIDC trust rule rule-1?',
						detail:
							'Every token that the rule accepts can then also be exchanged for the added grants.'
					}
				],
				results
			});
		}
	);

	it('leaves the rule unchanged when the confirmation is declined', async () => {
		const { ui, captured } = fakeCliUi({ interactive: true, confirm: 'no' });
		const { client, calls } = extendClient(extendedRule);

		await runOidcTrustExtend(ruleId, [buildInputsGrant], ui, client);

		expect({
			extends: calls.extends,
			results: captured.results,
			cancellations: captured.cancellations
		}).toStrictEqual({
			extends: [],
			results: [],
			cancellations: ['The trust rule was left unchanged.']
		});
	});

	it.each([
		{
			name: 'the same grant',
			grants: [ciGrant],
			requested: [ciGrant],
			descriptions: [
				'Cache owner-ci: request publication of paths, check publication status, complete publication of uploaded paths'
			]
		},
		{
			name: 'some of the operations of a grant',
			grants: [ciGrant],
			requested: [
				{
					type: 'cupboard_cache',
					actions: ['upload:negotiate'],
					resources: ciGrant.resources
				}
			],
			descriptions: ['Cache owner-ci: request publication of paths']
		},
		{
			name: 'a root under a granted root prefix',
			grants: [branchRootGrant],
			requested: [
				{
					type: 'cupboard_cache',
					actions: ['root:set'],
					resources: {
						cache: { kind: 'default' },
						root: {
							exact: 'github:acme/infra/main/x86_64-linux',
							validate: 'rootName'
						}
					}
				}
			],
			descriptions: [
				"Tenant's default cache: set retention roots (root restriction: github:acme/infra/main/x86_64-linux (exact root))"
			]
		},
		{
			name: 'a cache that a template makes from an exact claim',
			grants: [
				{
					type: 'cupboard_cache',
					actions: ['build-inputs:record'],
					resources: {
						cache: {
							kind: 'named',
							equalsTemplate: 'owner-{repository_owner_id}',
							substitutions: {
								repository_owner_id: { claim: 'repository_owner_id' }
							},
							validate: 'cacheName'
						}
					}
				}
			],
			requested: [
				{
					type: 'cupboard_cache',
					actions: ['build-inputs:record'],
					resources: {
						cache: { kind: 'named', exact: 'owner-5678', validate: 'cacheName' }
					}
				}
			],
			descriptions: [
				'Cache owner-5678: record the build inputs of cached paths'
			]
		},
		{
			name: 'the same template grant',
			grants: [prCacheGrant],
			requested: [prCacheGrant],
			descriptions: [
				'Cache from template gh-{repository_id}-pr-{pr}: request publication of paths, check publication status, complete publication of uploaded paths, confirm paths and extend their retention (cache variable {repository_id}: claim repository_id; cache variable {pr}: group pr from claim ref matching ^refs/pull/(?<pr>[0-9]+)/merge$)'
			]
		},
		{
			name: 'any grant of a wildcard rule',
			grants: [{ type: 'cupboard_wildcard' }],
			requested: [buildInputsGrant],
			descriptions: ['Cache owner-ci: record the build inputs of cached paths']
		}
	] satisfies {
		name: string;
		grants: Grant[];
		requested: Grant[];
		descriptions: string[];
	}[])(
		'refuses $name, which the rule already permits',
		async ({ grants, requested, descriptions }) => {
			const rule = summary({ ...extendedRule, permittedGrants: grants });
			const { client, calls } = extendClient(rule);

			const error = await extendOutcome('rule-1', requested, client);

			expect({
				refusal:
					error instanceof TrustRuleGrantsPermittedError
						? {
								id: error.id,
								grants: error.grants,
								descriptions: error.descriptions
							}
						: error,
				extends: calls.extends
			}).toStrictEqual({
				refusal: { id: 'rule-1', grants: requested, descriptions },
				extends: []
			});
		}
	);

	it('refuses only the grants that the rule already permits', async () => {
		const { client } = extendClient(extendedRule);

		const error = await extendOutcome(
			'rule-1',
			[buildInputsGrant, ciGrant],
			client
		);

		expect(
			error instanceof TrustRuleGrantsPermittedError
				? {
						id: error.id,
						grants: error.grants,
						descriptions: error.descriptions
					}
				: error
		).toStrictEqual({
			id: 'rule-1',
			grants: [ciGrant],
			descriptions: [
				'Cache owner-ci: request publication of paths, check publication status, complete publication of uploaded paths'
			]
		});
	});

	it('appends and previews a repeated grant once', async () => {
		const { ui, captured } = fakeCliUi({ confirm: 'yes' });
		const { client, calls } = extendClient(extendedRule);

		await runOidcTrustExtend(
			ruleId,
			[buildInputsGrant, buildInputsGrant],
			ui,
			client
		);

		expect({
			extends: calls.extends,
			plan: captured.results[0]
		}).toStrictEqual({
			extends: [
				{
					id: 'rule-1',
					expected: extendedRule,
					permittedGrants: [buildInputsGrant]
				}
			],
			plan: {
				kind: 'oidc-trust-extension-plan',
				title: 'Planned trust rule extension',
				data: {
					id: 'rule-1',
					expected: extendedRule,
					permittedGrants: [buildInputsGrant]
				},
				rows: planRows
			}
		});
	});

	it.each([
		{
			name: 'a new operation on a granted cache',
			grants: [ciGrant],
			requested: buildInputsGrant
		},
		{
			name: 'a granted operation on another cache',
			grants: [ciGrant],
			requested: {
				type: 'cupboard_cache',
				actions: ['upload:negotiate'],
				resources: {
					cache: { kind: 'named', exact: 'other', validate: 'cacheName' }
				}
			}
		},
		{
			name: 'a root outside the granted root prefix',
			grants: [branchRootGrant],
			requested: {
				type: 'cupboard_cache',
				actions: ['root:set'],
				resources: {
					cache: { kind: 'default' },
					root: { exact: 'github:acme/infra/dev/', validate: 'rootName' }
				}
			}
		},
		{
			name: 'a cache that a template makes only for some tokens',
			grants: [prCacheGrant],
			requested: {
				type: 'cupboard_cache',
				actions: ['upload:negotiate'],
				resources: {
					cache: { kind: 'named', exact: 'gh-1234-pr-7', validate: 'cacheName' }
				}
			}
		},
		{
			name: 'a template grant with another operation',
			grants: [prCacheGrant],
			requested: parseGrant({
				type: 'cupboard_cache',
				actions: ['build-inputs:record'],
				resources: { cache: prCacheBinding }
			})
		}
	] satisfies {
		name: string;
		grants: Grant[];
		requested: Grant;
	}[])('appends $name', async ({ grants, requested }) => {
		const rule = summary({ ...extendedRule, permittedGrants: grants });
		const { client, calls } = extendClient(rule);
		const { ui } = fakeCliUi({ confirm: 'yes' });

		await runOidcTrustExtend(ruleId, [requested], ui, client);

		expect(calls.extends).toStrictEqual([
			{ id: 'rule-1', expected: rule, permittedGrants: [requested] }
		]);
	});

	it.each([
		{
			name: "the tenant's owner rule",
			id: 'owner',
			rule: summary({ ...extendedRule, id: 'owner' }),
			errorClass: OwnerTrustRuleImmutableError,
			gets: []
		},
		{
			name: 'a disabled rule',
			id: 'rule-1',
			rule: summary({ ...extendedRule, disabled: true }),
			errorClass: TrustRuleDisabledError,
			gets: [{ id: 'rule-1' }]
		},
		{
			name: 'a GitHub Actions rule without a repository pin',
			id: 'rule-1',
			rule: summary({ ...extendedRule, claims: { ref: 'refs/heads/main' } }),
			errorClass: TrustRuleRepositoryPinRequiredError,
			gets: [{ id: 'rule-1' }]
		}
	])('refuses $name before sending a request', async (testCase) => {
		const { client, calls } = extendClient(testCase.rule);

		const error = await extendOutcome(testCase.id, [buildInputsGrant], client);

		expect({
			refusal: error instanceof testCase.errorClass ? { id: error.id } : error,
			calls
		}).toStrictEqual({
			refusal: { id: testCase.id },
			calls: { gets: testCase.gets, extends: [] }
		});
	});

	it('reports a rule that changed after the command read it', async () => {
		const refusal = new ORPCError('OIDC_TRUST_RULE_CHANGED', {
			status: StatusCodes.CONFLICT
		});
		const { client } = extendClient(extendedRule, refusal);

		const error = await extendOutcome('rule-1', [buildInputsGrant], client);

		expect(
			error instanceof TrustRuleChangedError
				? { id: error.id, cause: error.cause }
				: error
		).toStrictEqual({ id: 'rule-1', cause: refusal });
	});
});

/**
Runs `oidc-trust <command>` through the command line in JSON mode. Returns
'done', or the error that the command threw.
*/
async function runTrustCommand(
	commandArguments: readonly string[]
): Promise<unknown> {
	try {
		await buildProgram().parseAsync([
			'node',
			'cupboard',
			'--output-mode',
			'json',
			'oidc-trust',
			...commandArguments
		]);

		return 'done';
	} catch (error) {
		return error;
	}
}

describe('oidc-trust extend', () => {
	beforeEach(() => {
		mocks.add.mockReset();
		mocks.add.mockImplementation((body) =>
			Promise.resolve(summary({ ...body, id: 'rule-1' }))
		);
		mocks.get.mockReset();
		mocks.get.mockResolvedValue(extendedRule);
		mocks.extend.mockReset();
		mocks.extend.mockImplementation((input) =>
			Promise.resolve(
				summary({
					...input.expected,
					permittedGrants: [
						...input.expected.permittedGrants,
						...input.permittedGrants
					]
				})
			)
		);
	});

	it.each([
		{
			name: 'a build-inputs grant on the default cache',
			args: ['--allow', 'build-inputs'],
			grants: [
				{
					type: 'cupboard_cache',
					actions: ['build-inputs:record'],
					resources: { cache: { kind: 'default' } }
				}
			]
		},
		{
			name: 'publication and content reads on a named cache',
			args: ['--allow', 'read', '--allow', 'push', '--cache', 'ci'],
			grants: [
				{
					type: 'cupboard_cache',
					actions: uploadActions,
					resources: {
						cache: { kind: 'named', exact: 'ci', validate: 'cacheName' }
					}
				},
				{
					type: 'cupboard_cache',
					actions: ['cache:content-read'],
					resources: {
						cache: { kind: 'named', exact: 'ci', validate: 'cacheName' }
					}
				}
			]
		},
		{
			name: 'root management through templates',
			args: [
				'--allow',
				'root',
				'--template-source',
				'github-pr',
				'--cache-template',
				'gh-{repository_id}-pr-{pr}',
				'--root-template',
				'github:acme/infra/pr-{pr}/'
			],
			grants: [
				{
					type: 'cupboard_cache',
					actions: ['root:set', 'root:list'],
					resources: { cache: prCacheBinding, root: prRootBinding }
				}
			]
		}
	])('builds $name as add builds it', async ({ args, grants }) => {
		const added = await runTrustCommand([
			'add',
			tenantUrl,
			'--issuer',
			'https://token.actions.githubusercontent.com',
			'--audience',
			tenantUrl,
			'--claim',
			'repository_id=1234',
			...args
		]);
		const extended = await runTrustCommand([
			'extend',
			tenantUrl,
			'rule-1',
			'--yes',
			...args
		]);

		expect({
			added,
			extended,
			addedGrants: mocks.add.mock.calls.map(([body]) => body.permittedGrants),
			extends: mocks.extend.mock.calls
		}).toStrictEqual({
			added: 'done',
			extended: 'done',
			addedGrants: [grants],
			extends: [
				[{ id: 'rule-1', expected: extendedRule, permittedGrants: grants }]
			]
		});
	});

	// An earlier release wrote these presets without the build-inputs grant. The
	// documented commands add it so that the token service grants the request
	// for build inputs that the flake publish workflow makes.
	it.each([
		{
			name: 'a branch rule',
			body: githubBranchAddBody(tenantBase, identity, {
				repo: 'acme/infra',
				branch: 'main'
			}),
			args: ['--allow', 'build-inputs'],
			cache: { kind: 'default' },
			claims: { ref: 'refs/heads/main' },
			request: { kind: 'default' }
		},
		{
			name: 'a tag rule with the default cache template',
			body: githubTagAddBody(tenantBase, identity, { repo: 'acme/infra' }),
			args: [
				'--allow',
				'build-inputs',
				'--template-source',
				'github-tag',
				'--cache-template',
				'{tag}'
			],
			cache: tagCacheBinding,
			claims: { ref: 'refs/tags/v1.2.3', ref_type: 'tag' },
			request: { kind: 'named', name: cacheNameSchema.parse('v1.2.3') }
		},
		{
			name: 'a tag rule with another cache template',
			body: githubTagAddBody(tenantBase, identity, {
				repo: 'acme/infra',
				cacheTemplate: 'release-{tag}'
			}),
			args: [
				'--allow',
				'build-inputs',
				'--template-source',
				'github-tag',
				'--cache-template',
				'release-{tag}'
			],
			cache: { ...tagCacheBinding, equalsTemplate: 'release-{tag}' },
			claims: { ref: 'refs/tags/v1.2.3', ref_type: 'tag' },
			request: { kind: 'named', name: cacheNameSchema.parse('release-v1.2.3') }
		}
	] satisfies {
		name: string;
		body: OidcTrustAddBodyInput;
		args: string[];
		cache: unknown;
		claims: Record<string, string>;
		request: CacheScope;
	}[])(
		'adds the documented build-inputs grant to $name',
		async ({ body, args, cache, claims, request }) => {
			const rule = summary({ ...body, id: 'rule-1' });
			const grant = parseGrant({
				type: 'cupboard_cache',
				actions: ['build-inputs:record'],
				resources: { cache }
			});
			const tokenClaims = {
				repository_id: '1234',
				repository_owner_id: '5678',
				...claims
			};
			const detail: AuthorizationDetail = {
				type: 'cupboard_cache',
				actions: ['build-inputs:record'],
				cache: request
			};
			mocks.get.mockResolvedValue(rule);

			const outcome = await runTrustCommand([
				'extend',
				tenantUrl,
				'rule-1',
				'--yes',
				...args
			]);

			expect({
				outcome,
				extends: mocks.extend.mock.calls,
				permittedBefore: isGrantPermittedByRule(
					rule.permittedGrants,
					detail,
					tokenClaims
				),
				permittedAfter: isGrantPermittedByRule(
					[...rule.permittedGrants, grant],
					detail,
					tokenClaims
				)
			}).toStrictEqual({
				outcome: 'done',
				extends: [[{ id: 'rule-1', expected: rule, permittedGrants: [grant] }]],
				permittedBefore: false,
				permittedAfter: true
			});
		}
	);

	it('appends the grants listed in --from-file', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-grants-'));
		const file = path.join(directory, 'grants.json');

		try {
			await writeFile(file, JSON.stringify([buildInputsGrant]));

			const outcome = await runTrustCommand([
				'extend',
				tenantUrl,
				'rule-1',
				'--yes',
				'--from-file',
				file
			]);

			expect({ outcome, extends: mocks.extend.mock.calls }).toStrictEqual({
				outcome: 'done',
				extends: [
					[
						{
							id: 'rule-1',
							expected: extendedRule,
							permittedGrants: [buildInputsGrant]
						}
					]
				]
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each([
		{
			name: 'grant options alongside --from-file',
			args: ['--from-file', 'grants.json', '--allow', 'push', '--cache', 'ci'],
			expected: {
				name: 'TrustGrantsFileConflictError',
				options: ['--allow', '--cache']
			}
		},
		{
			name: 'neither --allow nor --from-file',
			args: ['--cache', 'ci'],
			expected: { name: 'TrustGrantsRequiredError' }
		}
	])('refuses $name', async ({ args, expected }) => {
		const refusal = await runTrustCommand([
			'extend',
			tenantUrl,
			'rule-1',
			'--yes',
			...args
		]);

		expect({
			refusal:
				refusal instanceof TrustGrantsFileConflictError
					? { name: refusal.name, options: refusal.options }
					: refusal instanceof TrustGrantsRequiredError
						? { name: refusal.name }
						: refusal,
			gets: mocks.get.mock.calls,
			extends: mocks.extend.mock.calls
		}).toStrictEqual({ refusal: expected, gets: [], extends: [] });
	});
});

describe('ruleOptionsGiven', () => {
	const none = { claim: [], allow: [], capture: [] };

	it.each([
		{ options: none, expected: [] },
		{
			options: { ...none, issuer: 'https://idp.example.com', allow: ['push'] },
			expected: ['--issuer', '--allow']
		},
		{
			options: { ...none, claim: ['sub=me'], templateSource: 'github-pr' },
			expected: ['--claim', '--template-source']
		}
	])('lists $expected', ({ options, expected }) => {
		expect(ruleOptionsGiven(options)).toStrictEqual(expected);
	});
});

describe('claimsForAdd', () => {
	const jobWorkflowReference =
		'acme/ci/.github/workflows/push.yml@refs/heads/main';

	it('merges the job_workflow_ref shorthand with the claim pairs', () => {
		expect(
			claimsForAdd(['repository_id=1234'], jobWorkflowReference)
		).toStrictEqual({
			repository_id: '1234',
			job_workflow_ref: jobWorkflowReference
		});
	});

	it('returns the claim pairs unchanged when no shorthand is given', () => {
		expect(claimsForAdd(['repository_id=1234'], undefined)).toStrictEqual({
			repository_id: '1234'
		});
	});

	it('rejects job_workflow_ref set by both the shorthand and a claim', () => {
		expect(() =>
			claimsForAdd(['job_workflow_ref=other'], jobWorkflowReference)
		).toThrow(InvalidClaimError);
	});
});

describe('githubPrAddBody', () => {
	it('adds a separate content-read grant for a private PR cache', () => {
		const original = githubPrAddBody(tenantBase, identity, {
			repo: 'acme/infra'
		});
		const privateRule = githubPrAddBody(tenantBase, identity, {
			repo: 'acme/infra',
			readCache: true
		});

		expect(privateRule.permittedGrants).toStrictEqual([
			...original.permittedGrants,
			{
				type: 'cupboard_cache',
				actions: ['cache:content-read'],
				resources: { cache: prCacheBinding }
			}
		]);
	});

	it('grants the upload, retention and attestation operations a publication performs, scoped to the per-PR cache and root', () => {
		expect(
			githubPrAddBody(tenantBase, identity, { repo: 'acme/infra' })
		).toStrictEqual({
			issuer: 'https://token.actions.githubusercontent.com',
			audience: tenantUrl,
			claims: {
				repository_id: '1234',
				repository_owner_id: '5678',
				event_name: 'pull_request'
			},
			permittedGrants: [
				{
					type: 'cupboard_cache',
					actions: [
						...uploadActions,
						...cacheLifecycleActions,
						...attestActions,
						...rootActions
					],
					resources: { cache: prCacheBinding, root: prRootBinding }
				}
			],
			display: { provider: 'github', repository: 'acme/infra' }
		});
	});

	it('pins the pull-request event so the rule matches only PR tokens', () => {
		const body = githubPrAddBody(tenantBase, identity, { repo: 'acme/infra' });

		expect(body.claims.event_name).toBe('pull_request');
	});

	it('omits attestation operations when --no-attest is given', () => {
		expect(
			githubPrAddBody(tenantBase, identity, {
				repo: 'acme/infra',
				attest: false
			})
		).toStrictEqual({
			issuer: 'https://token.actions.githubusercontent.com',
			audience: tenantUrl,
			claims: {
				repository_id: '1234',
				repository_owner_id: '5678',
				event_name: 'pull_request'
			},
			permittedGrants: [
				{
					type: 'cupboard_cache',
					actions: [...uploadActions, ...cacheLifecycleActions, ...rootActions],
					resources: { cache: prCacheBinding, root: prRootBinding }
				}
			],
			display: { provider: 'github', repository: 'acme/infra' }
		});
	});
});

describe('githubTagAddBody', () => {
	it('includes an exact content-read grant for the per-tag cache when requested', () => {
		expect(
			githubTagAddBody(tenantBase, identity, {
				shouldGrantBuildInputs: true,
				repo: 'acme/infra',
				readCache: true
			})
		).toStrictEqual({
			issuer: 'https://token.actions.githubusercontent.com',
			audience: tenantUrl,
			claims: {
				repository_id: '1234',
				repository_owner_id: '5678',
				ref_type: 'tag'
			},
			permittedGrants: [
				{
					type: 'cupboard_cache',
					actions: [
						...uploadActions,
						...buildInputsActions,
						...attestActions,
						...rootActions
					],
					resources: { cache: tagCacheBinding, root: tagRootBinding }
				},
				{
					type: 'cupboard_cache',
					actions: ['cache:content-read'],
					resources: { cache: tagCacheBinding }
				}
			],
			display: { provider: 'github', repository: 'acme/infra' }
		});
	});
	it('grants the upload, retention and attestation operations a publication performs, scoped to the per-tag cache and root', () => {
		expect(
			githubTagAddBody(tenantBase, identity, {
				shouldGrantBuildInputs: true,
				repo: 'acme/infra'
			})
		).toStrictEqual({
			issuer: 'https://token.actions.githubusercontent.com',
			audience: tenantUrl,
			claims: {
				repository_id: '1234',
				repository_owner_id: '5678',
				ref_type: 'tag'
			},
			permittedGrants: [
				{
					type: 'cupboard_cache',
					actions: [
						...uploadActions,
						...buildInputsActions,
						...attestActions,
						...rootActions
					],
					resources: { cache: tagCacheBinding, root: tagRootBinding }
				}
			],
			display: { provider: 'github', repository: 'acme/infra' }
		});
	});

	it('leaves out the build-inputs grant for a server without it', () => {
		expect(
			githubTagAddBody(tenantBase, identity, { repo: 'acme/infra' })
				.permittedGrants
		).toStrictEqual([
			{
				type: 'cupboard_cache',
				actions: [...uploadActions, ...attestActions, ...rootActions],
				resources: { cache: tagCacheBinding, root: tagRootBinding }
			}
		]);
	});

	it('pins the tag ref type so the rule matches only tag tokens', () => {
		const body = githubTagAddBody(tenantBase, identity, {
			shouldGrantBuildInputs: true,
			repo: 'acme/infra'
		});

		expect(body.claims.ref_type).toBe('tag');
	});

	it('omits attestation operations when --no-attest is given', () => {
		expect(
			githubTagAddBody(tenantBase, identity, {
				shouldGrantBuildInputs: true,
				repo: 'acme/infra',
				attest: false
			})
		).toStrictEqual({
			issuer: 'https://token.actions.githubusercontent.com',
			audience: tenantUrl,
			claims: {
				repository_id: '1234',
				repository_owner_id: '5678',
				ref_type: 'tag'
			},
			permittedGrants: [
				{
					type: 'cupboard_cache',
					actions: [...uploadActions, ...buildInputsActions, ...rootActions],
					resources: { cache: tagCacheBinding, root: tagRootBinding }
				}
			],
			display: { provider: 'github', repository: 'acme/infra' }
		});
	});
});

describe('githubBranchAddBody', () => {
	it('adds exact cache and view content-read grants to a private branch rule', () => {
		const original = githubBranchAddBody(tenantBase, identity, {
			shouldGrantBuildInputs: true,
			repo: 'acme/infra',
			branch: 'main'
		});
		const privateRule = githubBranchAddBody(tenantBase, identity, {
			shouldGrantBuildInputs: true,
			repo: 'acme/infra',
			branch: 'main',
			readCache: true,
			readView: 'pull-requests-1234'
		});

		expect(privateRule.permittedGrants).toStrictEqual([
			...original.permittedGrants,
			{
				type: 'cupboard_cache',
				actions: ['cache:content-read'],
				resources: { cache: { kind: 'default' } }
			},
			{
				type: 'cupboard_view',
				actions: ['view:content-read'],
				resources: {
					view: { exact: 'pull-requests-1234', validate: 'reuseViewName' }
				}
			}
		]);
	});

	it('gates the branch via the ref claim and matches the workflow file at any ref', () => {
		expect(
			githubBranchAddBody(tenantBase, identity, {
				shouldGrantBuildInputs: true,
				repo: 'acme/infra',
				branch: 'main',
				jobWorkflowRef: 'acme/infra/.github/workflows/cupboard-publish.yml'
			})
		).toStrictEqual({
			issuer: 'https://token.actions.githubusercontent.com',
			audience: tenantUrl,
			claims: {
				repository_id: '1234',
				repository_owner_id: '5678',
				ref: 'refs/heads/main',
				job_workflow_ref: {
					pattern: String.raw`^acme/infra/\.github/workflows/cupboard-publish\.yml@.+$`
				}
			},
			permittedGrants: [
				{
					type: 'cupboard_cache',
					actions: [
						...uploadActions,
						...buildInputsActions,
						...attestActions,
						...rootActions
					],
					resources: {
						cache: { kind: 'default' },
						root: {
							validate: 'rootName',
							exact: 'github:acme/infra/main/'
						}
					}
				}
			],
			display: { provider: 'github', repository: 'acme/infra' }
		});
	});

	it('matches the job_workflow_ref exactly when the value carries an @ref', () => {
		const body = githubBranchAddBody(tenantBase, identity, {
			shouldGrantBuildInputs: true,
			repo: 'acme/infra',
			branch: 'release',
			jobWorkflowRef:
				'acme/infra/.github/workflows/cupboard-publish.yml@refs/heads/main',
			attest: false
		});

		expect(body.claims).toStrictEqual({
			repository_id: '1234',
			repository_owner_id: '5678',
			ref: 'refs/heads/release',
			job_workflow_ref:
				'acme/infra/.github/workflows/cupboard-publish.yml@refs/heads/main'
		});
		expect(body.permittedGrants).toStrictEqual([
			{
				type: 'cupboard_cache',
				actions: [...uploadActions, ...buildInputsActions, ...rootActions],
				resources: {
					cache: { kind: 'default' },
					root: { validate: 'rootName', exact: 'github:acme/infra/release/' }
				}
			}
		]);
	});

	it('gates only the branch when no job_workflow_ref is given', () => {
		const body = githubBranchAddBody(tenantBase, identity, {
			shouldGrantBuildInputs: true,
			repo: 'acme/infra',
			branch: 'main'
		});

		expect(body.claims).toStrictEqual({
			repository_id: '1234',
			repository_owner_id: '5678',
			ref: 'refs/heads/main'
		});
	});
});

describe('claim rendering', () => {
	it('renders exact and pattern claims in the rule summary', async () => {
		const results: ResultRow[][] = [];

		await runOidcTrustShow(
			trustRuleIdSchema.parse('rule-1'),
			reporter(results),
			{
				get: () =>
					Promise.resolve(
						summary({
							claims: {
								repository_id: '1234',
								job_workflow_ref: { pattern: '^acme/infra/.+@.+$' }
							}
						})
					)
			}
		);

		expect(results).toStrictEqual([
			[
				{ label: 'Rule', value: 'rule-1' },
				{
					label: 'Issuer',
					value: 'https://token.actions.githubusercontent.com'
				},
				{ label: 'Audience', value: 'https://cache.example.workers.dev' },
				{ label: 'Claims', value: 'repository_id=1234' },
				{ label: '', value: 'job_workflow_ref matches ^acme/infra/.+@.+$' },
				{
					label: 'Access',
					value:
						'Cache owner-ci: request publication of paths, check publication status, complete publication of uploaded paths'
				},
				{ label: 'State', value: 'enabled' }
			]
		]);
	});
});

describe('githubPrAddBody job_workflow_ref', () => {
	it('adds the claim as a pattern or exact match, mirroring the value', () => {
		const anyReference = githubPrAddBody(tenantBase, identity, {
			repo: 'acme/infra',
			jobWorkflowRef: 'acme/infra/.github/workflows/publish.yml'
		});
		const exactReference = githubPrAddBody(tenantBase, identity, {
			repo: 'acme/infra',
			jobWorkflowRef: 'acme/infra/.github/workflows/publish.yml@refs/heads/main'
		});

		expect({
			anyRef: anyReference.claims.job_workflow_ref,
			exactRef: exactReference.claims.job_workflow_ref
		}).toStrictEqual({
			anyRef: {
				pattern: String.raw`^acme/infra/\.github/workflows/publish\.yml@.+$`
			},
			exactRef: 'acme/infra/.github/workflows/publish.yml@refs/heads/main'
		});
	});
});

// A tenant can serve several repositories, and their pull-request numbers
// collide. The rule permits `cache:close`, so two repositories with the same
// cache could close each other's publication.
describe('pull-request cache naming across repositories', () => {
	const first: RepositoryIdentity = {
		repositoryId: 1234,
		repositoryOwnerId: 5678,
		fullName: 'acme/infra',
		defaultBranch: 'main'
	};
	const second: RepositoryIdentity = {
		repositoryId: 4321,
		repositoryOwnerId: 5678,
		fullName: 'acme/tools',
		defaultBranch: 'main'
	};
	const candidates = ['pr-1', 'gh-1234-pr-1', 'gh-4321-pr-1'];

	function permittedCaches(identity: RepositoryIdentity): string[] {
		const body = githubPrAddBody(tenantBase, identity, {
			repo: identity.fullName
		});

		return candidates.filter((name) =>
			isGrantPermittedByRule(
				body.permittedGrants,
				{
					type: 'cupboard_cache',
					actions: ['cache:close'],
					cache: { kind: 'named', name: cacheNameSchema.parse(name) }
				},
				{
					iss: 'https://token.actions.githubusercontent.com',
					aud: tenantUrl,
					repository_id: String(identity.repositoryId),
					repository_owner_id: String(identity.repositoryOwnerId),
					event_name: 'pull_request',
					ref: 'refs/pull/1/merge'
				}
			)
		);
	}

	it('gives two repositories different caches for the same pull-request number', () => {
		expect({
			first: permittedCaches(first),
			second: permittedCaches(second)
		}).toStrictEqual({
			first: ['gh-1234-pr-1'],
			second: ['gh-4321-pr-1']
		});
	});
});

function oidcTrustProgram(): Command {
	const program = new Command().option('--output-mode <mode>');

	registerOidcTrustCommands(program);
	registerControlOidcTrustCommands(program);

	return program;
}

describe('parsed generic read rules', () => {
	beforeEach(() => {
		mocks.add.mockReset();
		mocks.add.mockImplementation((body) =>
			Promise.resolve(summary({ ...body, id: 'rule-1' }))
		);
	});

	const claims = {
		repository_id: '1234',
		repository_owner_id: '5678',
		ref: 'refs/heads/main',
		workflow_ref: 'acme/infra/.github/workflows/publish.yml@refs/heads/main'
	};
	const baseArguments = [
		'node',
		'cupboard',
		'--output-mode',
		'json',
		'oidc-trust',
		'add',
		tenantUrl,
		'--issuer',
		'https://token.actions.githubusercontent.com',
		'--audience',
		tenantUrl
	];
	const claimArguments = Object.entries(claims).flatMap(([key, value]) => [
		'--claim',
		`${key}=${value}`
	]);
	const selectors = [
		{
			label: 'default',
			ref: 'refs/heads/main',
			args: [],
			cache: { kind: 'default' },
			rootArgs: ['--root', 'github:acme/infra/main/'],
			root: { exact: 'github:acme/infra/main/', validate: 'rootName' }
		},
		{
			label: 'named',
			ref: 'refs/heads/main',
			args: ['--cache', 'ci'],
			cache: { kind: 'named', exact: 'ci', validate: 'cacheName' },
			rootArgs: ['--root', 'github:acme/infra/main/'],
			root: { exact: 'github:acme/infra/main/', validate: 'rootName' }
		},
		{
			label: 'template',
			ref: 'refs/pull/37/merge',
			args: [
				'--cache-template',
				'gh-{repository_id}-pr-{pr}',
				'--template-source',
				'github-pr'
			],
			cache: prCacheBinding,
			rootArgs: ['--root-template', 'github:acme/infra/pr-{pr}/'],
			root: prRootBinding
		}
	];
	const permissions = [
		{
			permission: 'read',
			allow: ['read'],
			read: true,
			actions: [],
			root: false
		},
		{
			permission: 'root',
			allow: ['root'],
			read: false,
			actions: ['root:set', 'root:list'],
			root: true
		},
		{
			permission: 'read and push',
			allow: ['read', 'push'],
			read: true,
			actions: uploadActions,
			root: false
		},
		{
			permission: 'read and publication',
			allow: ['read', 'push', 'root', 'attach', 'attest'],
			read: true,
			actions: [...uploadActions, ...attestActions, ...rootActions],
			root: true
		}
	];

	it.each(
		selectors.flatMap((selector) =>
			permissions.map((permission) => ({
				...selector,
				...permission,
				selector
			}))
		)
	)(
		'preserves the $label selector for $permission permissions',
		async ({ selector, allow, read, actions, root }) => {
			const ruleClaims = { ...claims, ref: selector.ref };
			await oidcTrustProgram().parseAsync([
				...baseArguments,
				...Object.entries(ruleClaims).flatMap(([key, value]) => [
					'--claim',
					`${key}=${value}`
				]),
				...selector.args,
				...allow.flatMap((value) => ['--allow', value]),
				...(root ? selector.rootArgs : [])
			]);
			expect(mocks.add.mock.calls).toStrictEqual([
				[
					{
						issuer: 'https://token.actions.githubusercontent.com',
						audience: tenantUrl,
						claims: ruleClaims,
						permittedGrants: [
							...(actions.length > 0
								? [
										{
											type: 'cupboard_cache',
											actions,
											resources: {
												cache: selector.cache,
												...(root && { root: selector.root })
											}
										}
									]
								: []),
							...(read
								? [
										{
											type: 'cupboard_cache',
											actions: ['cache:content-read'],
											resources: { cache: selector.cache }
										}
									]
								: [])
						]
					}
				]
			]);
		}
	);

	it.each([
		{ args: ['--root', 'github:acme/infra/main'] },
		{ args: ['--root', 'github:acme/infra/main/'] },
		{ args: ['--root-template', 'pr-{pr}', '--template-source', 'github-pr'] }
	])(
		'refuses a read-only root selector $args before sending',
		async ({ args }) => {
			let outcome: unknown;
			try {
				await oidcTrustProgram().parseAsync([
					...baseArguments,
					...claimArguments,
					'--allow',
					'read',
					...args
				]);
			} catch (error) {
				outcome =
					error instanceof Error
						? { usage: error instanceof CliUsageError, message: error.message }
						: error;
			}
			expect({ outcome, calls: mocks.add.mock.calls }).toStrictEqual({
				outcome: {
					usage: true,
					message:
						'Content reads cannot be restricted to a root. Remove --root and --root-template from a read-only rule, or include publication permissions for the selected root.'
				},
				calls: []
			});
		}
	);

	it.each([
		{ allow: ['read', 'attach'], error: 'Specify which root' },
		{ allow: ['read', 'unknown'], error: 'Unknown --allow value' }
	])('keeps validation for $allow', async ({ allow, error: expectedError }) => {
		let outcome: unknown;
		try {
			await oidcTrustProgram().parseAsync([
				...baseArguments,
				...claimArguments,
				...allow.flatMap((value) => ['--allow', value])
			]);
		} catch (error) {
			outcome = error instanceof Error && error.message.includes(expectedError);
		}
		expect({ refused: outcome, calls: mocks.add.mock.calls }).toStrictEqual({
			refused: true,
			calls: []
		});
	});

	it.each([
		{ root: { exact: 'github:acme/infra/main/', validate: 'rootName' } },
		{ extra: 'unexpected' }
	])('keeps strict JSON read constraints for %j', async (resources) => {
		const outcome = await addFromFile('oidc-trust', tenantUrl, {
			...tenantRule,
			permittedGrants: [
				{
					type: 'cupboard_cache',
					actions: ['cache:content-read'],
					resources: { cache: { kind: 'default' }, ...resources }
				}
			]
		});
		expect({
			refused: outcome instanceof InvalidClaimError,
			calls: mocks.add.mock.calls
		}).toStrictEqual({ refused: true, calls: [] });
	});
});

describe('parsed GitHub read presets', () => {
	it.each(
		['add-github-pr', 'add-github-tag', 'add-github-branch'].flatMap(
			(command) =>
				['main', 'refs/heads/main'].flatMap((pin) =>
					[false, true].map((allowBranchWorkflow) => ({
						command,
						pin,
						allowBranchWorkflow
					}))
				)
		)
	)(
		'guards branch trust at $command boundary for $pin with opt-in $allowBranchWorkflow',
		async ({ command, pin, allowBranchWorkflow }) => {
			mocks.add.mockReset();
			mocks.add.mockImplementation((input) =>
				Promise.resolve(summary({ ...input, id: 'branch' }))
			);
			mocks.lookup.mockResolvedValue(identity);
			mocks.verify.mockReset();
			mocks.verify.mockResolvedValue();
			mocks.resolveWorkflowRef.mockReset();
			mocks.resolveWorkflowRef.mockResolvedValue('refs/heads/main');
			const reference = 'acme/ci/.github/workflows/publish.yml@refs/heads/main';
			let failure: unknown;
			try {
				await oidcTrustProgram()
					.exitOverride()
					.parseAsync([
						'node',
						'cupboard',
						'--output-mode',
						'json',
						'oidc-trust',
						command,
						tenantUrl,
						'--repo',
						identity.fullName,
						'--workflow-ref',
						`acme/ci/.github/workflows/publish.yml@${pin}`,
						...(command === 'add-github-branch' ? ['--branch', 'main'] : []),
						...(allowBranchWorkflow ? ['--allow-branch-workflow'] : [])
					]);
			} catch (error) {
				failure = error;
			}
			const expectedBody =
				command === 'add-github-pr'
					? githubPrAddBody(tenantBase, identity, {
							repo: identity.fullName,
							jobWorkflowRef: reference
						})
					: command === 'add-github-tag'
						? githubTagAddBody(tenantBase, identity, {
								shouldGrantBuildInputs: true,
								repo: identity.fullName,
								jobWorkflowRef: reference
							})
						: githubBranchAddBody(tenantBase, identity, {
								shouldGrantBuildInputs: true,
								repo: identity.fullName,
								branch: 'main',
								jobWorkflowRef: reference
							});
			expect({
				failure,
				resolved: mocks.resolveWorkflowRef.mock.calls,
				verified: mocks.verify.mock.calls,
				added: mocks.add.mock.calls
			}).toStrictEqual({
				failure: allowBranchWorkflow
					? undefined
					: new WorkflowReferenceMutableError(reference, 'refs/heads/main'),
				resolved: pin === 'main' ? [['acme/ci', 'main']] : [],
				verified: allowBranchWorkflow
					? [
							[
								{
									reference,
									owner: 'acme',
									repo: 'ci',
									path: '.github/workflows/publish.yml',
									pin: {
										kind: 'branch',
										value: 'refs/heads/main',
										branch: 'main'
									}
								},
								{ allowBranchWorkflow: true }
							]
						]
					: [],
				added: allowBranchWorkflow ? [[expectedBody]] : []
			});
		}
	);

	it.each([false, true])(
		'requires branch workflow opt-in for closure trust: %s',
		async (allowBranchWorkflow) => {
			mocks.add.mockReset();
			mocks.add.mockImplementation((input) =>
				Promise.resolve(summary({ ...input, id: 'close' }))
			);
			mocks.lookup.mockResolvedValue(identity);
			mocks.verify.mockReset();
			mocks.verify.mockResolvedValue();
			const workflow = 'acme/ci/.github/workflows/publish.yml@refs/heads/main';
			let failure: unknown;
			try {
				await oidcTrustProgram()
					.exitOverride()
					.parseAsync([
						'node',
						'cupboard',
						'--output-mode',
						'json',
						'oidc-trust',
						'add-github-pr-close',
						tenantUrl,
						'--repo',
						identity.fullName,
						'--workflow-ref',
						workflow,
						...(allowBranchWorkflow ? ['--allow-branch-workflow'] : [])
					]);
			} catch (error) {
				failure = error;
			}
			expect({
				failure,
				verified: mocks.verify.mock.calls,
				rules: mocks.add.mock.calls
			}).toStrictEqual(
				allowBranchWorkflow
					? {
							failure: undefined,
							verified: [
								[
									{
										reference: workflow,
										owner: 'acme',
										repo: 'ci',
										path: '.github/workflows/publish.yml',
										pin: {
											kind: 'branch',
											value: 'refs/heads/main',
											branch: 'main'
										}
									},
									{ allowBranchWorkflow: true }
								]
							],
							rules: [
								[
									{
										issuer: 'https://token.actions.githubusercontent.com',
										audience: tenantUrl,
										claims: {
											repository_id: '1234',
											repository_owner_id: '5678',
											event_name: 'pull_request',
											ref: { pattern: '^refs/heads/.+$' },
											job_workflow_ref: workflow
										},
										permittedGrants: [
											{
												type: 'cupboard_cache',
												actions: ['cache:close'],
												resources: {
													cache: {
														kind: 'named',
														pattern: '^gh-1234-pr-[0-9]+$',
														validate: 'cacheName'
													}
												}
											}
										],
										display: {
											provider: 'github',
											repository: identity.fullName
										}
									}
								]
							]
						}
					: {
							failure: new WorkflowReferenceMutableError(
								workflow,
								'refs/heads/main'
							),
							verified: [],
							rules: []
						}
			);
		}
	);

	it.each(
		['--job-workflow-ref', '--workflow-ref'].flatMap((flag) =>
			[
				'https://token.actions.githubusercontent.com',
				'https://tokenXactionsXgithubusercontentXcom',
				'https://token.actions.githubusercontent.com.evil.example'
			].map((issuer) => ({ flag, issuer }))
		)
	)(
		'parses $flag with the exact issuer $issuer on a manual rule',
		async ({ flag, issuer }) => {
			mocks.add.mockReset();
			mocks.lookup.mockClear();
			mocks.add.mockImplementation((body) =>
				Promise.resolve(summary({ ...body, id: 'rule-1' }))
			);
			const workflowReference =
				'acme/ci/.github/workflows/publish.yml@refs/heads/main';
			await oidcTrustProgram()
				.exitOverride()
				.parseAsync([
					'node',
					'cupboard',
					'--output-mode',
					'json',
					'oidc-trust',
					'add',
					tenantUrl,
					'--issuer',
					issuer,
					'--audience',
					tenantUrl,
					'--allow',
					'read',
					flag,
					workflowReference
				]);
			expect({
				lookup: mocks.lookup.mock.calls,
				add: mocks.add.mock.calls
			}).toStrictEqual({
				lookup: [],
				add: [
					[
						{
							issuer,
							audience: tenantUrl,
							claims: { job_workflow_ref: workflowReference },
							permittedGrants: [
								{
									type: 'cupboard_cache',
									actions: ['cache:content-read'],
									resources: { cache: { kind: 'default' } }
								}
							]
						}
					]
				]
			});
		}
	);

	it.each(['--job-workflow-ref', '--workflow-ref'])(
		'adds a closure-only rule with %s',
		async (flag) => {
			const workflow =
				'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/vX.Y.Z';
			mocks.add.mockReset();
			mocks.add.mockImplementation((input) =>
				Promise.resolve(summary({ ...input, id: 'rule-close' }))
			);
			mocks.lookup.mockReset();
			mocks.lookup.mockResolvedValue(identity);
			await oidcTrustProgram()
				.exitOverride()
				.parseAsync([
					'node',
					'cupboard',
					'--output-mode',
					'json',
					'oidc-trust',
					'add-github-pr-close',
					tenantUrl,
					'--repo',
					identity.fullName,
					flag,
					workflow,
					'--cache-template',
					'pr-{pr}'
				]);
			expect({
				lookup: mocks.lookup.mock.calls,
				add: mocks.add.mock.calls
			}).toStrictEqual({
				lookup: [[identity.fullName]],
				add: [
					[
						githubPrCloseAddBody(tenantBase, identity, {
							repo: identity.fullName,
							jobWorkflowRef: workflow,
							cacheTemplate: 'pr-{pr}'
						})
					]
				]
			});
		}
	);

	const probeAnswers = [
		{
			server: 'a server without the procedure',
			// oRPC keeps the raw response of a plain 404 in the error data.
			failure: new ORPCError('NOT_FOUND', {
				status: StatusCodes.NOT_FOUND,
				data: {
					status: StatusCodes.NOT_FOUND,
					headers: {},
					body: 'Not found\n'
				}
			}),
			shouldGrantBuildInputs: false
		},
		{
			server: 'a token without cache:content-read',
			failure: new ORPCError('FORBIDDEN', {
				status: StatusCodes.FORBIDDEN
			}),
			shouldGrantBuildInputs: true
		}
	];

	it.each(
		probeAnswers.flatMap(({ server, failure, shouldGrantBuildInputs }) => [
			{
				command: 'add-github-branch',
				server,
				failure,
				args: ['--branch', 'main'],
				body: githubBranchAddBody(tenantBase, identity, {
					shouldGrantBuildInputs,
					repo: identity.fullName,
					branch: 'main'
				})
			},
			{
				command: 'add-github-tag',
				server,
				failure,
				args: [],
				body: githubTagAddBody(tenantBase, identity, {
					shouldGrantBuildInputs,
					repo: identity.fullName
				})
			}
		])
	)(
		'decides the build-inputs grant of $command for $server',
		async ({ command, failure, args, body }) => {
			mocks.add.mockReset();
			mocks.add.mockImplementation((input) =>
				Promise.resolve(summary({ ...input, id: 'rule-1' }))
			);
			mocks.lookup.mockReset();
			mocks.lookup.mockResolvedValue(identity);
			mocks.readBuildInputs.mockRejectedValue(failure);

			await oidcTrustProgram()
				.exitOverride()
				.parseAsync([
					'node',
					'cupboard',
					'--output-mode',
					'json',
					'oidc-trust',
					command,
					tenantUrl,
					'--repo',
					identity.fullName,
					...args
				]);

			expect(mocks.add.mock.calls).toStrictEqual([[body]]);
		}
	);

	const presets = [
		{
			command: 'add-github-pr',
			args: [],
			body: githubPrAddBody(tenantBase, identity, {
				repo: identity.fullName,
				readCache: true
			})
		},
		{
			command: 'add-github-branch',
			args: ['--branch', 'main'],
			body: githubBranchAddBody(tenantBase, identity, {
				shouldGrantBuildInputs: true,
				repo: identity.fullName,
				branch: 'main',
				readCache: true
			})
		},
		{
			command: 'add-github-tag',
			args: [],
			body: githubTagAddBody(tenantBase, identity, {
				shouldGrantBuildInputs: true,
				repo: identity.fullName,
				readCache: true
			})
		}
	];
	it.each(
		presets
			.flatMap((preset) => [
				{ ...preset, audience: undefined },
				{
					...preset,
					audience: 'cupboard-ci-client',
					body: { ...preset.body, audience: 'cupboard-ci-client' }
				}
			])
			.flatMap((preset) =>
				['--job-workflow-ref', '--workflow-ref'].map((flag) => ({
					...preset,
					flag
				}))
			)
	)(
		'parses --read-cache and audience $audience for $command',
		async ({ command, args, body, audience, flag }) => {
			mocks.add.mockReset();
			mocks.add.mockImplementation((input) =>
				Promise.resolve(summary({ ...input, id: 'rule-1' }))
			);
			mocks.lookup.mockReset();
			mocks.lookup.mockResolvedValue(identity);
			await oidcTrustProgram()
				.exitOverride()
				.parseAsync([
					'node',
					'cupboard',
					'--output-mode',
					'json',
					'oidc-trust',
					command,
					tenantUrl,
					'--repo',
					identity.fullName,
					'--read-cache',
					flag,
					'acme/ci/.github/workflows/publish.yml@refs/tags/v*',
					...(audience === undefined ? [] : ['--audience', audience]),
					...args
				]);
			expect({
				lookup: mocks.lookup.mock.calls,
				add: mocks.add.mock.calls
			}).toStrictEqual({
				lookup: [[identity.fullName]],
				add: [
					[
						{
							...body,
							claims: {
								...body.claims,
								job_workflow_ref: {
									pattern: String.raw`^acme/ci/\.github/workflows/publish\.yml@refs/tags/v[^/]*$`
								}
							}
						}
					]
				]
			});
		}
	);
});
