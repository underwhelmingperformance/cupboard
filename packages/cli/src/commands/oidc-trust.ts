import { readFile } from 'node:fs/promises';

import type { CliUi } from '@cupboard/cli-ui';
import type { ManagedPolicyId } from '@cupboard/protocol/managed-caches';
import {
	type ClaimMatch,
	type OidcTrustAddBodyInput,
	oidcTrustAddBodySchema,
	type OidcTrustListResponse,
	type OidcTrustRemoveResponse,
	type OidcTrustSummary,
	type TrustRuleId,
	trustRuleIdSchema
} from '@cupboard/protocol/oidc';
import { type Reporter, type ResultRow } from '@cupboard/reporter';
import type { Command } from 'commander';

import { type Audience, audienceSchema, parseAudience } from '../audience.ts';
import { cachedOwnerProvider } from '../auth/auth.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { controlRpc, tenantRpc } from '../client/orpc.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { InvalidClaimError } from '../errors.ts';
import { deploymentUrlArgument, tenantUrlArgument } from '../url-argument.ts';

import { githubActionsIssuer } from './github/claims.ts';
import {
	lookupRepository,
	type RepositoryIdentity
} from './oidc-trust/github.ts';
import {
	buildAddBody,
	buildCacheGrant,
	collectSubstitutions,
	jobWorkflowReferenceClaim as jobWorkflowReferenceClaim
} from './oidc-trust/rule-builder.ts';

interface GithubPrOptions {
	readonly repo: string;
	readonly audience?: Audience;
	readonly cacheTemplate?: string;
	readonly rootTemplate?: string;
	readonly jobWorkflowRef?: string;
	readonly attest?: boolean;
	readonly managedPolicy?: ManagedPolicyId;
}

interface GithubTagOptions {
	readonly repo: string;
	readonly audience?: Audience;
	readonly cacheTemplate?: string;
	readonly rootTemplate?: string;
	readonly jobWorkflowRef?: string;
	readonly attest?: boolean;
}

interface GithubBranchOptions {
	readonly repo: string;
	readonly branch: string;
	readonly jobWorkflowRef?: string;
	readonly audience?: Audience;
	readonly attest?: boolean;
}

// GitHub presets grant attestation by default. The dedicated `--no-attest`
// option overrides any `attest` entry in the general action list.
function withAttest(
	allow: readonly string[],
	attest: boolean | undefined
): string[] {
	const base = allow.filter((action) => action !== 'attest');

	return attest === false ? base : [...base, 'attest'];
}

// JSON input accepts the complete rule schema, including admin, domain, and
// control grants that have no dedicated flags.
async function addBodyFor(
	options: OidcTrustAddOptions
): Promise<OidcTrustAddBodyInput> {
	if (options.fromFile !== undefined) {
		return loadAddBody(options.fromFile);
	}

	const substitutions = collectSubstitutions({
		templateSource: options.templateSource,
		captures: options.capture
	});

	return buildAddBody({
		issuer: options.issuer,
		audience: options.audience,
		claims: claimsForAdd(options.claim, options.jobWorkflowRef),
		permittedGrants: [
			buildCacheGrant({
				cache: options.cache,
				cacheTemplate: options.cacheTemplate,
				allow: options.allow,
				root: options.root,
				rootTemplate: options.rootTemplate,
				substitutions
			})
		]
	});
}

async function loadAddBody(path: string): Promise<OidcTrustAddBodyInput> {
	let parsed: unknown;

	try {
		parsed = JSON.parse(await readFile(path, 'utf8'));
	} catch {
		throw new InvalidClaimError(`--from-file ${path} is not valid JSON`);
	}

	const result = oidcTrustAddBodySchema.safeParse(parsed);

	if (!result.success) {
		throw new InvalidClaimError(result.error.message);
	}

	return result.data;
}

interface ConfirmableOptions {
	readonly yes?: boolean;
}

interface OidcTrustAddOptions {
	readonly issuer: string;
	readonly audience: Audience;
	readonly claim: readonly string[];
	readonly allow: readonly string[];
	readonly cache?: string;
	readonly cacheTemplate?: string;
	readonly root?: string;
	readonly rootTemplate?: string;
	readonly capture: readonly string[];
	readonly templateSource?: string;
	readonly fromFile?: string;
	readonly jobWorkflowRef?: string;
}

/**
 * The OIDC trust operations required by the command implementations.
 */
export interface OidcTrustClient {
	list(): Promise<OidcTrustListResponse>;
	get(input: { id: TrustRuleId }): Promise<OidcTrustSummary>;
	add(input: OidcTrustAddBodyInput): Promise<OidcTrustSummary>;
	remove(input: { id: TrustRuleId }): Promise<OidcTrustRemoveResponse>;
}

function collect(value: string, previous: readonly string[]): string[] {
	return [...previous, value];
}

function claimRows(claims: Record<string, ClaimMatch>): ResultRow[] {
	const entries = Object.entries(claims);

	if (entries.length === 0) {
		return [{ label: 'Claims', value: '(none)' }];
	}

	return entries.map(([key, match], index) => ({
		label: index === 0 ? 'Claims' : '',
		value:
			typeof match === 'string' ? `${key}=${match}` : `${key}=~${match.pattern}`
	}));
}

function grantRows(grants: OidcTrustSummary['permittedGrants']): ResultRow[] {
	if (grants.length === 0) {
		return [{ label: 'Grants', value: '(none)' }];
	}

	return grants.map((grant, index) => ({
		label: index === 0 ? 'Grants' : '',
		value: describeGrant(grant)
	}));
}

function describeCacheBinding(
	binding: Extract<
		OidcTrustSummary['permittedGrants'][number],
		{ type: 'cupboard_cache' }
	>['resources']['cache']
): string {
	if (binding.kind === 'default') {
		return '(default)';
	}

	return binding.exact ?? binding.equalsTemplate ?? '?';
}

function describeGrant(
	grant: OidcTrustSummary['permittedGrants'][number]
): string {
	if (grant.type === 'cupboard_wildcard') {
		return 'wildcard (every operation)';
	}

	if (grant.type === 'cupboard_cache') {
		return `cache ${describeCacheBinding(grant.resources.cache)}: ${grant.actions.join(', ')}`;
	}

	if (grant.type === 'cupboard_tenant') {
		const tenant =
			grant.resources.tenant.exact ?? grant.resources.tenant.equalsTemplate;

		return `tenant ${tenant ?? '?'}: ${grant.actions.join(', ')}`;
	}

	return `${grant.type}: ${grant.actions.join(', ')}`;
}

function summaryRows(summary: OidcTrustSummary): ResultRow[] {
	return [
		{ label: 'Rule', value: summary.id },
		{ label: 'Issuer', value: summary.issuer },
		{ label: 'Audience', value: summary.audience },
		...claimRows(summary.claims),
		...grantRows(summary.permittedGrants),
		...(summary.display?.repository === undefined
			? []
			: [{ label: 'Repository', value: summary.display.repository }])
	];
}

// Reject duplicate sources for `job_workflow_ref` instead of making command-line
// option order determine the rule.
export function claimsForAdd(
	claimPairs: readonly string[],
	jobWorkflowReference: string | undefined
): Record<string, ClaimMatch> {
	const claims: Record<string, ClaimMatch> = parseClaims(claimPairs);

	if (jobWorkflowReference === undefined) {
		return claims;
	}

	if (Object.hasOwn(claims, 'job_workflow_ref')) {
		throw new InvalidClaimError(
			'job_workflow_ref is set by both --job-workflow-ref and --claim'
		);
	}

	return {
		...claims,
		job_workflow_ref: jobWorkflowReferenceClaim(jobWorkflowReference)
	};
}

function parseClaims(pairs: readonly string[]): Record<string, string> {
	const claims: Record<string, string> = {};

	for (const pair of pairs) {
		const separator = pair.indexOf('=');

		if (separator <= 0) {
			throw new InvalidClaimError(pair);
		}

		claims[pair.slice(0, separator)] = pair.slice(separator + 1);
	}

	return claims;
}

interface OidcTrustPlane {
	readonly name: string;
	readonly description: string;
	readonly urlArgument: string;
	// The GitHub PR preset grants tenant cache authority and is not available on
	// the control plane.
	readonly githubPr: boolean;
	readonly clientFor: (
		url: URL,
		programOptions: ProgramOptions
	) => OidcTrustClient;
}

const tenantPlane: OidcTrustPlane = {
	name: 'oidc-trust',
	description:
		'Manage the rules that let CI authenticate to this tenant with a short-lived OIDC token instead of a stored secret.',
	urlArgument: tenantUrlArgument,
	githubPr: true,
	clientFor: (url, programOptions) =>
		tenantRpc(url, {
			credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
			signal: programOptions.signal
		}).oidcTrust
};

const controlPlane: OidcTrustPlane = {
	name: 'control-oidc-trust',
	description:
		'Manage the rules that let CI authenticate to the control plane with a short-lived OIDC token instead of a stored secret (operator only).',
	urlArgument: deploymentUrlArgument,
	githubPr: false,
	clientFor: (url, programOptions) =>
		controlRpc(url, {
			credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
			signal: programOptions.signal
		}).oidcTrust
};

// Pin immutable repository IDs and the pull-request event. The captured PR
// number selects both `pr-<n>` and its retention root, so one PR cannot write
// another PR's cache.
export function githubPrAddBody(
	url: URL,
	identity: RepositoryIdentity,
	options: GithubPrOptions
): OidcTrustAddBodyInput {
	const cacheTemplate = options.cacheTemplate ?? 'pr-{pr}';

	// Pin the event so a verified token from the same repository cannot select
	// this rule for a branch or tag build.
	const claims: Record<string, ClaimMatch> = {
		repository_id: String(identity.repositoryId),
		repository_owner_id: String(identity.repositoryOwnerId),
		event_name: 'pull_request'
	};

	if (options.jobWorkflowRef !== undefined) {
		claims.job_workflow_ref = jobWorkflowReferenceClaim(options.jobWorkflowRef);
	}

	return buildAddBody({
		issuer: githubActionsIssuer,
		audience: options.audience ?? audienceSchema.parse(url),
		claims,
		permittedGrants: [
			buildCacheGrant({
				cacheTemplate,
				rootTemplate:
					options.rootTemplate ??
					`github:${identity.fullName}/${cacheTemplate}/`,
				allow: withAttest(['push', 'root', 'attach'], options.attest),
				managedPolicy: options.managedPolicy,
				substitutions: collectSubstitutions({
					templateSource: 'github-pr',
					captures: []
				})
			})
		],
		display: { provider: 'github', repository: identity.fullName }
	});
}

// Pin immutable repository IDs and the tag ref type. The captured tag selects
// both the cache and its retention root.
export function githubTagAddBody(
	url: URL,
	identity: RepositoryIdentity,
	options: GithubTagOptions
): OidcTrustAddBodyInput {
	const cacheTemplate = options.cacheTemplate ?? '{tag}';

	// Pin the ref type so a branch or pull-request token from the same repository
	// cannot select this rule.
	const claims: Record<string, ClaimMatch> = {
		repository_id: String(identity.repositoryId),
		repository_owner_id: String(identity.repositoryOwnerId),
		ref_type: 'tag'
	};

	if (options.jobWorkflowRef !== undefined) {
		claims.job_workflow_ref = jobWorkflowReferenceClaim(options.jobWorkflowRef);
	}

	return buildAddBody({
		issuer: githubActionsIssuer,
		audience: options.audience ?? audienceSchema.parse(url),
		claims,
		permittedGrants: [
			buildCacheGrant({
				cacheTemplate,
				rootTemplate:
					options.rootTemplate ??
					`github:${identity.fullName}/${cacheTemplate}/`,
				allow: withAttest(['push', 'root', 'attach'], options.attest),
				substitutions: collectSubstitutions({
					templateSource: 'github-tag',
					captures: []
				})
			})
		],
		display: { provider: 'github', repository: identity.fullName }
	});
}

// Pin immutable repository IDs and the branch ref. The rule grants the default
// cache and the retention root used by the push action for that branch.
export function githubBranchAddBody(
	url: URL,
	identity: RepositoryIdentity,
	options: GithubBranchOptions
): OidcTrustAddBodyInput {
	const claims: Record<string, ClaimMatch> = {
		repository_id: String(identity.repositoryId),
		repository_owner_id: String(identity.repositoryOwnerId),
		ref: `refs/heads/${options.branch}`
	};

	if (options.jobWorkflowRef !== undefined) {
		claims.job_workflow_ref = jobWorkflowReferenceClaim(options.jobWorkflowRef);
	}

	return buildAddBody({
		issuer: githubActionsIssuer,
		audience: options.audience ?? audienceSchema.parse(url),
		claims,
		permittedGrants: [
			buildCacheGrant({
				allow: withAttest(['push', 'root', 'attach'], options.attest),
				root: `github:${identity.fullName}/${options.branch}/`
			})
		],
		display: { provider: 'github', repository: identity.fullName }
	});
}

export function registerOidcTrustCommands(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	buildOidcTrustCommands(program, programOptions, tenantPlane);
}

export function registerControlOidcTrustCommands(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	buildOidcTrustCommands(program, programOptions, controlPlane);
}

function buildOidcTrustCommands(
	program: Command,
	programOptions: ProgramOptions,
	plane: OidcTrustPlane
): void {
	const oidcTrust = program.command(plane.name).description(plane.description);

	oidcTrust
		.command('list')
		.description('List the configured trust rules and what each one trusts.')
		.argument('<url>', plane.urlArgument, parseWorkerUrl)
		.action(async (url: URL) => {
			const reporter = commandUi(program, programOptions).reporter();

			await runOidcTrustList(reporter, plane.clientFor(url, programOptions));
		});

	oidcTrust
		.command('show')
		.description(
			'Show one trust rule in full: the token it accepts and the access it grants.'
		)
		.argument('<url>', plane.urlArgument, parseWorkerUrl)
		.argument('<id>', 'trust rule id')
		.action(async (url: URL, id: string) => {
			const reporter = commandUi(program, programOptions).reporter();

			await runOidcTrustShow(
				trustRuleIdSchema.parse(id),
				reporter,
				plane.clientFor(url, programOptions)
			);
		});

	oidcTrust
		.command('add')
		.description(
			'Add a trust rule by hand: the issuer and claims a token must carry, and the access to grant.'
		)
		.argument('<url>', plane.urlArgument, parseWorkerUrl)
		.requiredOption('--issuer <issuer>', 'OIDC issuer URL')
		.requiredOption(
			'--audience <audience>',
			'expected token audience',
			parseAudience
		)
		.option(
			'--claim <key=value>',
			'a claim the token must match exactly (repeatable)',
			collect,
			[]
		)
		.option(
			'--job-workflow-ref <ref>',
			'pin the job_workflow_ref claim: the workflow file and ref allowed to push'
		)
		.option(
			'--allow <action>',
			'an action set the rule may exchange for: push, attest, root, or attach (repeatable)',
			collect,
			[]
		)
		.option(
			'--cache <name>',
			'an exact cache the grant is scoped to (default: the tenant default cache)'
		)
		.option(
			'--cache-template <template>',
			'a cache template such as "pr-{pr}", rendered from captures'
		)
		.option('--root <name>', 'an exact root the grant may set')
		.option(
			'--root-template <template>',
			'a root template rendered from captures'
		)
		.option(
			'--capture <claim=pattern>',
			'a named-group capture binding template variables to a claim (repeatable)',
			collect,
			[]
		)
		.option(
			'--template-source <name>',
			'a built-in capture source: github-pr (binds {pr}) or github-tag (binds {tag}) from the ref claim'
		)
		.option(
			'--from-file <path>',
			'read the rule body (permitted grants and claims) from a JSON file'
		)
		.addHelpText(
			'after',
			[
				'',
				'Example:',
				'  # Trust a reusable workflow to push to a per-PR cache it cannot',
				'  # escape, keyed on the job_workflow_ref claim',
				'  cupboard oidc-trust add https://cupboard.example.workers.dev/t/acme \\',
				'    --issuer https://token.actions.githubusercontent.com \\',
				'    --audience https://cupboard.example.workers.dev/t/acme \\',
				'    --job-workflow-ref acme/ci/.github/workflows/push.yml@refs/heads/main \\',
				'    --allow push --allow root --template-source github-pr \\',
				'    --cache-template pr-{pr} --root-template pr-{pr}'
			].join('\n')
		)
		.action(async (url: URL, options: OidcTrustAddOptions) => {
			const reporter = commandUi(program, programOptions).reporter();

			await runOidcTrustAdd(
				await addBodyFor(options),
				reporter,
				plane.clientFor(url, programOptions)
			);
		});

	if (plane.githubPr) {
		oidcTrust
			.command('add-github-pr')
			.description(
				"Trust a GitHub repository's pull-request builds to push to a short-lived cache of their own, one per pull request."
			)
			.argument('<url>', plane.urlArgument, parseWorkerUrl)
			.requiredOption('--repo <owner/name>', 'the GitHub repository')
			.option(
				'--audience <audience>',
				'expected token audience (default: the tenant URL)',
				parseAudience
			)
			.option(
				'--cache-template <template>',
				'the per-PR cache template (default: pr-{pr})'
			)
			.option(
				'--root-template <template>',
				'the per-PR retention root (default: github:<owner>/<repo>/pr-{pr}/)'
			)
			.option(
				'--job-workflow-ref <value>',
				'also require the job_workflow_ref claim (owner/repo/path@ref); without @ref it matches the file at any ref'
			)
			.option(
				'--no-attest',
				'do not let the workflow attach build attestations'
			)
			.addHelpText(
				'after',
				[
					'',
					'Example:',
					"  # Trust this repository's pull-request builds to push to their own",
					'  # pr-<number> cache, which they cannot escape',
					'  cupboard oidc-trust add-github-pr https://cupboard.example.workers.dev/t/acme \\',
					'    --repo acme/infra'
				].join('\n')
			)
			.action(async (url: URL, options: GithubPrOptions) => {
				const reporter = commandUi(program, programOptions).reporter();
				const identity = await reporter.phase('Resolving repository', () =>
					lookupRepository(options.repo)
				);

				await runOidcTrustAdd(
					githubPrAddBody(url, identity, options),
					reporter,
					plane.clientFor(url, programOptions)
				);
			});

		oidcTrust
			.command('add-github-tag')
			.description(
				"Trust a GitHub repository's tag builds to push to a cache named for the tag, one per release."
			)
			.argument('<url>', plane.urlArgument, parseWorkerUrl)
			.requiredOption('--repo <owner/name>', 'the GitHub repository')
			.option(
				'--audience <audience>',
				'expected token audience (default: the tenant URL)',
				parseAudience
			)
			.option(
				'--cache-template <template>',
				'the per-tag cache template (default: {tag})'
			)
			.option(
				'--root-template <template>',
				'the per-tag retention root (default: github:<owner>/<repo>/{tag}/)'
			)
			.option(
				'--job-workflow-ref <value>',
				'also require the job_workflow_ref claim (owner/repo/path@ref); without @ref it matches the file at any ref'
			)
			.option(
				'--no-attest',
				'do not let the workflow attach build attestations'
			)
			.addHelpText(
				'after',
				[
					'',
					'Example:',
					"  # Trust this repository's tag builds to push to a cache named",
					'  # for the tag, e.g. v1.2.3',
					'  cupboard oidc-trust add-github-tag https://cupboard.example.workers.dev/t/acme \\',
					'    --repo acme/infra'
				].join('\n')
			)
			.action(async (url: URL, options: GithubTagOptions) => {
				const reporter = commandUi(program, programOptions).reporter();
				const identity = await reporter.phase('Resolving repository', () =>
					lookupRepository(options.repo)
				);

				await runOidcTrustAdd(
					githubTagAddBody(url, identity, options),
					reporter,
					plane.clientFor(url, programOptions)
				);
			});

		oidcTrust
			.command('add-github-branch')
			.description(
				"Trust pushes to one branch of a GitHub repository to publish to this tenant's default cache."
			)
			.argument('<url>', plane.urlArgument, parseWorkerUrl)
			.requiredOption('--repo <owner/name>', 'the GitHub repository')
			.requiredOption(
				'--branch <name>',
				'the branch whose pushes may publish, e.g. main'
			)
			.option(
				'--job-workflow-ref <value>',
				'also require the job_workflow_ref claim (owner/repo/path@ref); without @ref it matches the file at any ref'
			)
			.option(
				'--audience <audience>',
				'expected token audience (default: the tenant URL)',
				parseAudience
			)
			.option(
				'--no-attest',
				'do not let the workflow attach build attestations'
			)
			.addHelpText(
				'after',
				[
					'',
					'Example:',
					'  # Trust pushes to main, requiring the reusable publish workflow',
					'  # that issues the token, and publish to the default cache',
					'  cupboard oidc-trust add-github-branch https://cupboard.example.workers.dev/t/acme \\',
					'    --repo acme/infra --branch main \\',
					'    --job-workflow-ref acme/infra/.github/workflows/cupboard-publish.yml@refs/heads/main'
				].join('\n')
			)
			.action(async (url: URL, options: GithubBranchOptions) => {
				const reporter = commandUi(program, programOptions).reporter();
				const identity = await reporter.phase('Resolving repository', () =>
					lookupRepository(options.repo)
				);

				await runOidcTrustAdd(
					githubBranchAddBody(url, identity, options),
					reporter,
					plane.clientFor(url, programOptions)
				);
			});
	}

	oidcTrust
		.command('remove')
		.description(
			'Disable a trust rule by id, so the CI it trusts can no longer authenticate.'
		)
		.argument('<url>', plane.urlArgument, parseWorkerUrl)
		.argument('<id>', 'trust rule id')
		.option('-y, --yes', 'remove without the confirmation prompt')
		.action(async (url: URL, id: string, options: ConfirmableOptions) => {
			const ui = commandUi(program, programOptions, { assumeYes: options.yes });

			await runOidcTrustRemove(
				trustRuleIdSchema.parse(id),
				ui,
				plane.clientFor(url, programOptions)
			);
		});
}

export async function runOidcTrustList(
	reporter: Reporter,
	client: Pick<OidcTrustClient, 'list'>
): Promise<void> {
	const { rules } = await reporter.phase('Listing OIDC trust rules', () =>
		client.list()
	);

	reporter.result({
		kind: 'oidc-trust-rules',
		data: rules,
		rows: rules.map((rule) => trustRow(rule)),
		empty: 'No OIDC trust rules.'
	});
}

export async function runOidcTrustAdd(
	body: OidcTrustAddBodyInput,
	reporter: Reporter,
	client: Pick<OidcTrustClient, 'add'>
): Promise<void> {
	const summary = await reporter.phase('Adding OIDC trust rule', () =>
		client.add(body)
	);

	reporter.result({
		kind: 'oidc-trust-rule',
		data: summary,
		rows: summaryRows(summary)
	});
}

export async function runOidcTrustShow(
	id: TrustRuleId,
	reporter: Reporter,
	client: Pick<OidcTrustClient, 'get'>
): Promise<void> {
	const summary = await reporter.phase('Fetching OIDC trust rule', () =>
		client.get({ id })
	);

	reporter.result({
		kind: 'oidc-trust-rule',
		data: summary,
		rows: summaryRows(summary)
	});
}

export async function runOidcTrustRemove(
	id: TrustRuleId,
	ui: CliUi,
	client: OidcTrustClient
): Promise<void> {
	const outcome = await ui.confirm({
		message: `Remove OIDC trust rule ${id}?`,
		detail: 'CI workflows relying on this rule can no longer exchange tokens.'
	});

	if (outcome !== 'yes') {
		ui.cancelled('The trust rule was left in place.');
		return;
	}

	const reporter = ui.reporter();
	const result = await reporter.phase('Removing OIDC trust rule', () =>
		client.remove({ id })
	);

	reporter.result({
		kind: 'oidc-trust-rule',
		data: result,
		rows: [
			{ label: 'Rule', value: result.id },
			{ label: 'Removed', value: result.removed ? 'yes' : 'not present' }
		]
	});
}

function trustRow(rule: OidcTrustSummary): ResultRow {
	const state = rule.disabled ? ' (disabled)' : '';
	const grants = rule.permittedGrants.some(
		(grant) => grant.type === 'cupboard_wildcard'
	)
		? 'wildcard'
		: `${String(rule.permittedGrants.length)} grant(s)`;

	return {
		label: rule.id,
		value: `${grants} ${rule.issuer} aud=${rule.audience}${state}`
	};
}
