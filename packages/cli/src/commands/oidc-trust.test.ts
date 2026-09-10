import {
	capturingReporter as reporter,
	fakeCliUi
} from '@cupboard/cli-ui/testing';
import {
	type OidcTrustAddBodyInput,
	oidcTrustListResponseSchema,
	type OidcTrustSummary,
	type OidcTrustSummaryInput,
	oidcTrustSummarySchema,
	trustRuleIdSchema
} from '@cupboard/protocol/oidc';
import type { ResultRow } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import { parseWorkerUrl } from '../client/transport.ts';
import { InvalidClaimError } from '../errors.ts';

import {
	claimsForAdd,
	githubBranchAddBody,
	githubPrAddBody,
	githubTagAddBody,
	type OidcTrustClient,
	runOidcTrustAdd,
	runOidcTrustList,
	runOidcTrustRemove,
	runOidcTrustShow
} from './oidc-trust.ts';
import { type RepositoryIdentity } from './oidc-trust/github.ts';

const identity: RepositoryIdentity = {
	repositoryId: 1234,
	repositoryOwnerId: 5678,
	fullName: 'acme/infra'
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
const prSubstitutions = {
	pr: {
		claim: 'ref',
		capture: { pattern: '^refs/pull/(?<pr>[0-9]+)/merge$', group: 'pr' }
	}
};
const prCacheBinding = {
	equalsTemplate: 'pr-{pr}',
	substitutions: prSubstitutions,
	kind: 'named',
	validate: 'cacheName'
};
const prRootBinding = {
	equalsTemplate: 'github:acme/infra/pr-{pr}/',
	substitutions: prSubstitutions,
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
	equalsTemplate: '{tag}',
	substitutions: tagSubstitutions,
	kind: 'named',
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
		cache: { exact: 'owner-ci', kind: 'named', validate: 'cacheName' }
	}
};
const ciGrantRow =
	'cache owner-ci: upload:negotiate, upload:status, upload:commit';

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
		const response = oidcTrustListResponseSchema.parse({
			rules: [
				summary({
					id: 'owner',
					permittedGrants: [{ type: 'cupboard_wildcard' }],
					issuer: 'https://accounts.google.com'
				}),
				summary({ id: 'rule-1', disabled: true })
			]
		});

		await runOidcTrustList(reporter(results), {
			list: () => Promise.resolve(response)
		});

		expect(results).toStrictEqual([
			[
				{
					label: 'owner',
					value:
						'wildcard https://accounts.google.com aud=https://cache.example.workers.dev'
				},
				{
					label: 'rule-1',
					value:
						'1 grant(s) https://token.actions.githubusercontent.com aud=https://cache.example.workers.dev (disabled)'
				}
			]
		]);
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
			results: [
				[
					{ label: 'Rule', value: 'rule-1' },
					{
						label: 'Issuer',
						value: 'https://token.actions.githubusercontent.com'
					},
					{ label: 'Audience', value: 'https://cache.example.workers.dev' },
					{ label: 'Claims', value: 'repository_owner_id=5678' },
					{ label: '', value: 'repository_id=1234' },
					{ label: 'Grants', value: ciGrantRow }
				]
			]
		});
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
			results: [
				[
					{ label: 'Rule', value: 'rule-1' },
					{
						label: 'Issuer',
						value: 'https://token.actions.githubusercontent.com'
					},
					{ label: 'Audience', value: 'https://cache.example.workers.dev' },
					{ label: 'Claims', value: 'repository_owner_id=5678' },
					{ label: '', value: 'repository_id=1234' },
					{ label: 'Grants', value: ciGrantRow }
				]
			]
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
					actions: [...uploadActions, ...attestActions, ...rootActions],
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
					actions: [...uploadActions, ...rootActions],
					resources: { cache: prCacheBinding, root: prRootBinding }
				}
			],
			display: { provider: 'github', repository: 'acme/infra' }
		});
	});
});

describe('githubTagAddBody', () => {
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
	it('renders an exact claim with = and a pattern claim with =~', async () => {
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

		expect(results[0]).toContainEqual({
			label: 'Claims',
			value: 'repository_id=1234'
		});
		expect(results[0]).toContainEqual({
			label: '',
			value: 'job_workflow_ref=~^acme/infra/.+@.+$'
		});
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
