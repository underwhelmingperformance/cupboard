import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	capturingReporter as reporter,
	fakeCliUi
} from '@cupboard/cli-ui/testing';
import { cacheNameSchema } from '@cupboard/nix-store/scalars';
import { isGrantPermittedByRule } from '@cupboard/protocol/grant-match';
import {
	type OidcTrustAddBodyInput,
	oidcTrustListResponseSchema,
	type OidcTrustSummary,
	type OidcTrustSummaryInput,
	oidcTrustSummarySchema,
	trustRuleIdSchema
} from '@cupboard/protocol/oidc';
import type { ResultPayload, ResultRow } from '@cupboard/reporter';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildProgram } from '../cli.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { CliUsageError, InvalidClaimError } from '../errors.ts';

import {
	claimsForAdd,
	githubBranchAddBody,
	githubPrAddBody,
	githubPrCloseAddBody,
	githubTagAddBody,
	type OidcTrustClient,
	ruleOptionsGiven,
	runOidcTrustAdd,
	runOidcTrustList,
	runOidcTrustRemove,
	runOidcTrustShow
} from './oidc-trust.ts';
import { type RepositoryIdentity } from './oidc-trust/github.ts';

const mocks = vi.hoisted(() => ({
	add: vi.fn<OidcTrustClient['add']>(),
	lookup: vi.fn<(repo: string) => Promise<RepositoryIdentity>>()
}));

// The commands build their oRPC clients from these functions, so a command
// parsed from argv sends its rule to `mocks.add`.
vi.mock('../client/orpc.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../client/orpc.ts')>()),
	tenantRpc: () => ({ oidcTrust: { add: mocks.add } }),
	controlRpc: () => ({ oidcTrust: { add: mocks.add } })
}));

vi.mock('./oidc-trust/github.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('./oidc-trust/github.ts')>()),
	lookupRepository: mocks.lookup
}));

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
		label: 'Grants',
		value: 'cache owner-ci: upload:negotiate, upload:status, upload:commit'
	}
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
			{
				label: 'owner',
				value:
					'wildcard https://idp.example.test/realms/a · owner-1 aud=https://cache.example.workers.dev'
			},
			{
				label: 'rule-1',
				value:
					'1 grant(s) https://token.actions.githubusercontent.com aud=https://cache.example.workers.dev (disabled)'
			}
		];

		expect({ results, payloads }).toStrictEqual({
			results: [rows],
			payloads: [
				{
					kind: 'oidc-trust-rules',
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
			results: [
				[
					{
						label: 'rule-1',
						value:
							'1 grant(s) https://token.actions.githubusercontent.com aud=https://cache.example.workers.dev'
					}
				]
			],
			infos: [
				'The server cannot read trust rule rule-3. The rule is disabled and remains only as a record.'
			],
			warns: [
				'The server cannot read trust rule rule-2, which is enabled: ID token exchanges fail until you remove the rule'
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
					data: [{ id: 'rule-2', disabled: false, unreadable: true }],
					rows: [],
					empty: undefined
				}
			],
			infos: [],
			warns: [
				'The server cannot read trust rule rule-2, which is enabled: ID token exchanges fail until you remove the rule'
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
 * Runs `add --from-file` through the command line with the rule written to a
 * temporary file. Returns 'added', or the error that the command threw.
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
					actions: [...uploadActions, ...attestActions, ...rootActions],
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
			githubTagAddBody(tenantBase, identity, { repo: 'acme/infra' })
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
					actions: [...uploadActions, ...attestActions, ...rootActions],
					resources: { cache: tagCacheBinding, root: tagRootBinding }
				}
			],
			display: { provider: 'github', repository: 'acme/infra' }
		});
	});

	it('pins the tag ref type so the rule matches only tag tokens', () => {
		const body = githubTagAddBody(tenantBase, identity, { repo: 'acme/infra' });

		expect(body.claims.ref_type).toBe('tag');
	});

	it('omits attestation operations when --no-attest is given', () => {
		expect(
			githubTagAddBody(tenantBase, identity, {
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
					actions: [...uploadActions, ...rootActions],
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
			repo: 'acme/infra',
			branch: 'main'
		});
		const privateRule = githubBranchAddBody(tenantBase, identity, {
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
					actions: [...uploadActions, ...attestActions, ...rootActions],
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
				actions: [...uploadActions, ...rootActions],
				resources: {
					cache: { kind: 'default' },
					root: { validate: 'rootName', exact: 'github:acme/infra/release/' }
				}
			}
		]);
	});

	it('gates only the branch when no job_workflow_ref is given', () => {
		const body = githubBranchAddBody(tenantBase, identity, {
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
				{ label: '', value: 'job_workflow_ref=~^acme/infra/.+@.+$' },
				{
					label: 'Grants',
					value:
						'cache owner-ci: upload:negotiate, upload:status, upload:commit'
				}
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
			await buildProgram().parseAsync([
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
				await buildProgram().parseAsync([
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
			await buildProgram().parseAsync([
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
	it.each(['--job-workflow-ref', '--workflow-ref'])(
		'parses %s on a manual rule',
		async (flag) => {
			mocks.add.mockReset();
			mocks.lookup.mockClear();
			mocks.add.mockImplementation((body) =>
				Promise.resolve(summary({ ...body, id: 'rule-1' }))
			);
			const workflowReference =
				'acme/ci/.github/workflows/publish.yml@refs/heads/main';
			await buildProgram()
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
					'https://token.actions.githubusercontent.com',
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
							issuer: 'https://token.actions.githubusercontent.com',
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
			await buildProgram()
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
				repo: identity.fullName,
				branch: 'main',
				readCache: true
			})
		},
		{
			command: 'add-github-tag',
			args: [],
			body: githubTagAddBody(tenantBase, identity, {
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
			await buildProgram()
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
