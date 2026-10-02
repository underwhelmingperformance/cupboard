import { cacheNameSchema } from '@cupboard/nix-store/scalars';
import { authorizationDetailSchema } from '@cupboard/protocol/grants';
import { oidcTrustSummarySchema } from '@cupboard/protocol/oidc';
import { selectModelledOidcTrust } from '@cupboard/protocol/oidc-trust-diagnostics';
import { expect, it } from 'vitest';

import { CliUsageError } from '../../errors.ts';
import { githubPrAddBody, githubPrCloseAddBody } from '../oidc-trust.ts';

const identity = {
	repositoryId: 1234,
	repositoryOwnerId: 5678,
	fullName: 'acme/app',
	defaultBranch: 'main'
};
const url = new URL('https://cupboard.example.workers.dev/t/acme');
const workflow =
	'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/vX.Y.Z';
const options = { repo: identity.fullName, jobWorkflowRef: workflow };
const rules = [
	githubPrAddBody(url, identity, { ...options, readCache: true }),
	githubPrCloseAddBody(url, identity, options)
].map((body, index) =>
	oidcTrustSummarySchema.parse({
		...body,
		id: `rule-${String(index)}`,
		disabled: false
	})
);
const claims = {
	iss: 'https://token.actions.githubusercontent.com',
	aud: url.href,
	repository_id: '1234',
	repository_owner_id: '5678',
	event_name: 'pull_request',
	ref: 'refs/heads/main',
	job_workflow_ref: workflow
};

it.each([
	{
		scenario: 'merged close',
		cache: 'gh-1234-pr-7',
		action: 'cache:close',
		change: {},
		permitted: true
	},
	{
		scenario: 'merged close family',
		cache: 'gh-1234-pr-8',
		action: 'cache:close',
		change: {},
		permitted: true
	},
	{
		scenario: 'different repository',
		cache: 'gh-1234-pr-7',
		action: 'cache:close',
		change: { repository_id: '9999' },
		permitted: false
	},
	{
		scenario: 'different owner',
		cache: 'gh-1234-pr-7',
		action: 'cache:close',
		change: { repository_owner_id: '9999' },
		permitted: false
	},
	{
		scenario: 'different workflow',
		cache: 'gh-1234-pr-7',
		action: 'cache:close',
		change: {
			job_workflow_ref: 'acme/app/.github/workflows/other.yml@refs/heads/main'
		},
		permitted: false
	},
	{
		scenario: 'other audience',
		cache: 'gh-1234-pr-7',
		action: 'cache:close',
		change: { aud: 'other' },
		permitted: false
	},
	{
		scenario: 'other issuer',
		cache: 'gh-1234-pr-7',
		action: 'cache:close',
		change: { iss: 'https://other.example' },
		permitted: false
	},
	{
		scenario: 'tag ref',
		cache: 'gh-1234-pr-7',
		action: 'cache:close',
		change: { ref: 'refs/tags/vX.Y.Z' },
		permitted: false
	},
	{
		scenario: 'open publication other PR',
		cache: 'gh-1234-pr-8',
		action: 'upload:commit',
		change: { ref: 'refs/pull/7/merge' },
		permitted: false
	},
	{
		scenario: 'open reopen other PR',
		cache: 'gh-1234-pr-8',
		action: 'cache:reopen',
		change: { ref: 'refs/pull/7/merge' },
		permitted: false
	},

	{
		scenario: 'push event',
		cache: 'gh-1234-pr-7',
		action: 'cache:close',
		change: { event_name: 'push' },
		permitted: false
	},
	{
		scenario: 'other cache family',
		cache: 'gh-9999-pr-7',
		action: 'cache:close',
		change: {},
		permitted: false
	},
	{
		scenario: 'family suffix',
		cache: 'gh-1234-pr-7-other',
		action: 'cache:close',
		change: {},
		permitted: false
	},
	{
		scenario: 'release cache',
		cache: 'release',
		action: 'cache:close',
		change: {},
		permitted: false
	},
	{
		scenario: 'default cache',
		cache: undefined,
		action: 'cache:close',
		change: {},
		permitted: false
	},
	{
		scenario: 'merged reopen',
		cache: 'gh-1234-pr-7',
		action: 'cache:reopen',
		change: {},
		permitted: false
	},
	{
		scenario: 'merged publication',
		cache: 'gh-1234-pr-7',
		action: 'upload:commit',
		change: {},
		permitted: false
	},
	{
		scenario: 'merged content read',
		cache: 'gh-1234-pr-7',
		action: 'cache:content-read',
		change: {},
		permitted: false
	},
	{
		scenario: 'merged root update',
		cache: 'gh-1234-pr-7',
		action: 'root:set',
		change: {},
		permitted: false
	},
	{
		scenario: 'open close other PR',
		cache: 'gh-1234-pr-8',
		action: 'cache:close',
		change: { ref: 'refs/pull/7/merge' },
		permitted: false
	},
	{
		scenario: 'open close own PR',
		cache: 'gh-1234-pr-7',
		action: 'cache:close',
		change: { ref: 'refs/pull/7/merge' },
		permitted: true
	},
	{
		scenario: 'open reopen own PR',
		cache: 'gh-1234-pr-7',
		action: 'cache:reopen',
		change: { ref: 'refs/pull/7/merge' },
		permitted: true
	},
	{
		scenario: 'open publication own PR',
		cache: 'gh-1234-pr-7',
		action: 'upload:commit',
		change: { ref: 'refs/pull/7/merge' },
		permitted: true
	},
	{
		scenario: 'open read own PR',
		cache: 'gh-1234-pr-7',
		action: 'cache:content-read',
		change: { ref: 'refs/pull/7/merge' },
		permitted: true
	},
	{
		scenario: 'open read other PR',
		cache: 'gh-1234-pr-8',
		action: 'cache:content-read',
		change: { ref: 'refs/pull/7/merge' },
		permitted: false
	}
])('limits $scenario authority', ({ cache, action, change, permitted }) => {
	const detail = authorizationDetailSchema.parse({
		type: 'cupboard_cache',
		actions: [action],
		cache:
			cache === undefined
				? { kind: 'default' }
				: { kind: 'named', name: cacheNameSchema.parse(cache) }
	});
	expect(
		selectModelledOidcTrust(rules, { ...claims, ...change }, [detail])
			.outcome === 'selected'
	).toBe(permitted);
});

it.each([
	{
		template: 'ci.{repository_id}.{pr}',
		selected: 'ci.1234.7',
		other: 'cix1234x7'
	},
	{ template: 'pr-{pr}', selected: 'pr-7', other: 'pr-7-extra' },
	{
		template: 'fixed-{repository_id}',
		selected: 'fixed-1234',
		other: 'fixed-12345'
	}
])('preserves the custom $template family', ({ template, selected, other }) => {
	const body = githubPrCloseAddBody(url, identity, {
		...options,
		cacheTemplate: template
	});
	const rule = oidcTrustSummarySchema.parse({
		...body,
		id: 'custom',
		disabled: false
	});
	expect(
		[selected, other].map(
			(name) =>
				selectModelledOidcTrust([rule], claims, [
					authorizationDetailSchema.parse({
						type: 'cupboard_cache',
						actions: ['cache:close'],
						cache: { kind: 'named', name }
					})
				]).outcome === 'selected'
		)
	).toStrictEqual([true, false]);
});

it('refuses repeated PR placeholders only for explicit merged-close rule generation', () => {
	const publication = oidcTrustSummarySchema.parse({
		...githubPrAddBody(url, identity, {
			...options,
			cacheTemplate: 'pr-{pr}-{pr}'
		}),
		id: 'repeated',
		disabled: false
	});
	expect(
		['pr-7-7', 'pr-7-8'].map(
			(name) =>
				selectModelledOidcTrust(
					[publication],
					{ ...claims, ref: 'refs/pull/7/merge' },
					[
						authorizationDetailSchema.parse({
							type: 'cupboard_cache',
							actions: ['upload:commit'],
							cache: { kind: 'named', name }
						})
					]
				).outcome === 'selected'
		)
	).toStrictEqual([true, false]);
	expect(() =>
		githubPrCloseAddBody(url, identity, {
			...options,
			cacheTemplate: 'pr-{pr}-{pr}'
		})
	).toThrow(CliUsageError);
});

it.each([
	{
		ref: 'refs/pull/7/merge',
		cache: 'gh-1234-pr-7',
		root: 'github:acme/app/pr-7/output',
		permitted: true
	},
	{
		ref: 'refs/pull/7/merge',
		cache: 'gh-1234-pr-7',
		root: 'github:acme/app/pr-8/output',
		permitted: false
	},
	{
		ref: 'refs/pull/7/merge',
		cache: 'gh-1234-pr-8',
		root: 'github:acme/app/pr-8/output',
		permitted: false
	},
	{
		ref: 'refs/heads/main',
		cache: 'gh-1234-pr-7',
		root: 'github:acme/app/pr-7/output',
		permitted: false
	}
])(
	'preserves root authority for $ref and $cache at $root',
	({ ref, cache, root, permitted }) => {
		const request = authorizationDetailSchema.parse({
			type: 'cupboard_cache',
			actions: ['root:set'],
			cache: { kind: 'named', name: cache },
			root
		});
		expect(
			selectModelledOidcTrust(rules, { ...claims, ref }, [request]).outcome ===
				'selected'
		).toBe(permitted);
	}
);

it('requires a workflow pin for an explicit merged-close rule', () => {
	expect(() =>
		githubPrCloseAddBody(url, identity, {
			...options,
			jobWorkflowRef:
				'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml'
		})
	).toThrow(CliUsageError);
});

it('refuses family metadata reads for merged-close runs', () => {
	const requested = authorizationDetailSchema.parse({
		type: 'cupboard_cache',
		cache: { kind: 'named', name: 'gh-1234-pr-8' },
		actions: ['cache:read']
	});
	expect(selectModelledOidcTrust(rules, claims, [requested]).outcome).toBe(
		'authority-unmatched'
	);
});
