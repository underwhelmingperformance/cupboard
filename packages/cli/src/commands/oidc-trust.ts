import { readFile } from 'node:fs/promises';

import type { CliUi } from '@cupboard/cli-ui';
import {
	type ClaimMatch,
	type OidcTrustAddBody,
	oidcTrustAddBodySchema,
	type OidcTrustSummary,
	type ParsedOidcTrustListResponse,
	type ParsedOidcTrustRemoveResponse,
	type ParsedOidcTrustSummary,
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
	// Commander's `--no-attest` leaves this `true` unless the flag is passed.
	readonly attest?: boolean;
}

interface GithubTagOptions {
	readonly repo: string;
	readonly audience?: Audience;
	readonly cacheTemplate?: string;
	readonly rootTemplate?: string;
	readonly jobWorkflowRef?: string;
	// Commander's `--no-attest` leaves this `true` unless the flag is passed.
	readonly attest?: boolean;
}

interface GithubBranchOptions {
	readonly repo: string;
	readonly branch: string;
	readonly jobWorkflowRef?: string;
	readonly audience?: Audience;
	readonly attest?: boolean;
}

// Attestation is a dedicated toggle on the GitHub presets, not a grant value,
// and it is granted by default; `--no-attest` is authoritative,
// so it wins even if `attest` was named some other way.
function withAttest(
	allow: readonly string[],
	attest: boolean | undefined
): string[] {
	const base = allow.filter((action) => action !== 'attest');

	return attest === false ? base : [...base, 'attest'];
}

// Assemble the rule body from flags, or read it whole from a JSON file. The file
// form is the escape hatch for grants the flags do not spell, such as admin,
// domain, or control grants.
async function addBodyFor(
	options: OidcTrustAddOptions
): Promise<OidcTrustAddBody> {
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

async function loadAddBody(path: string): Promise<OidcTrustAddBody> {
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
 * The slice of the derived client the trust commands consume, in the
 * contract's input and output shapes; the real `tenantRpc(...).oidcTrust`
 * satisfies it by construction.
 */
export interface OidcTrustClient {
	list(): Promise<ParsedOidcTrustListResponse>;
	get(input: { id: TrustRuleId }): Promise<ParsedOidcTrustSummary>;
	add(input: OidcTrustAddBody): Promise<ParsedOidcTrustSummary>;
	remove(input: { id: TrustRuleId }): Promise<ParsedOidcTrustRemoveResponse>;
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

function describeGrant(
	grant: OidcTrustSummary['permittedGrants'][number]
): string {
	if (grant.type === 'cupboard_wildcard') {
		return 'wildcard (every operation)';
	}

	if (grant.type === 'cupboard_cache') {
		const cache =
			grant.resources.cache.exact ?? grant.resources.cache.equalsTemplate;

		return `cache ${cache ?? '?'}: ${grant.actions.join(', ')}`;
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

// Merge the `--claim` pairs with the `--job-workflow-ref` shorthand, refusing to
// set `job_workflow_ref` twice so a rule never depends on which flag was read
// last.
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

// The tenant and control trust commands differ only in which client they bind
// and which URL they take; the rule body, output shapes, and run-helpers are
// shared, so both planes are registered from one builder.
interface OidcTrustPlane {
	readonly name: string;
	readonly description: string;
	readonly urlArgument: string;
	// The GitHub PR preset reads provider-specific claims, so it is offered only
	// on the tenant plane.
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

// Assemble the per-PR rule for a GitHub repository, pinning its immutable
// numeric ids so a rename never silently changes who is trusted. A build of pull
// request <n> pushes to its own `pr-<n>` cache and writes the matching retention
// root `github:<owner>/<repo>/pr-<n>/`, both keyed on the pull-request number
// captured from the `ref` claim, so one PR cannot reach another's paths.
export function githubPrAddBody(
	url: URL,
	identity: RepositoryIdentity,
	options: GithubPrOptions
): OidcTrustAddBody {
	const cacheTemplate = options.cacheTemplate ?? 'pr-{pr}';

	// Pin the pull-request event so this rule matches only PR tokens. A tenant
	// often trusts the same repository for several events, a tagged release or a
	// branch push, with a rule for each. Selection routes a token to a single
	// rule by its claims, so a PR rule that pinned only the repository ids would
	// also match a release or push token and could be chosen ahead of the rule
	// meant for that event.
	const claims: Record<string, ClaimMatch> = {
		repository_id: String(identity.repositoryId),
		repository_owner_id: String(identity.repositoryOwnerId),
		event_name: 'pull_request'
	};

	// Pinning the workflow is an optional extra restriction on top of the event
	// and the `{pr}` capture on the bindings below.
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
				// The PR's root nests its cache name under the repository, so the
				// captured `{pr}` resolves in both bindings.
				rootTemplate:
					options.rootTemplate ??
					`github:${identity.fullName}/${cacheTemplate}/`,
				allow: withAttest(['push', 'root', 'attach'], options.attest),
				substitutions: collectSubstitutions({
					templateSource: 'github-pr',
					captures: []
				})
			})
		],
		display: { provider: 'github', repository: identity.fullName }
	});
}

// Assemble the per-tag rule for a GitHub repository, pinning its immutable
// numeric ids and the `tag` ref type so only a tag build matches, whether the
// tag was pushed or a release published it. A build of tag <name> pushes to its
// own `<name>` cache and writes the matching retention root
// `github:<owner>/<repo>/<name>/`, both keyed on the tag captured from the
// `ref` claim.
export function githubTagAddBody(
	url: URL,
	identity: RepositoryIdentity,
	options: GithubTagOptions
): OidcTrustAddBody {
	const cacheTemplate = options.cacheTemplate ?? '{tag}';

	// Pin the tag ref type so this rule matches only tag tokens and never a
	// branch or pull-request token, which would otherwise let it be selected
	// ahead of the rule meant for those events.
	const claims: Record<string, ClaimMatch> = {
		repository_id: String(identity.repositoryId),
		repository_owner_id: String(identity.repositoryOwnerId),
		ref_type: 'tag'
	};

	// Pinning the workflow is an optional extra restriction on top of the ref
	// type and the `{tag}` capture on the bindings below.
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
				// The tag's root nests its cache name under the repository, so the
				// captured `{tag}` resolves in both bindings.
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

// Assemble the branch rule for a GitHub repository: pushes to `branch` publish
// to the tenant's default cache, scoped to the retention root the push action
// writes by default, `github:<owner>/<repo>/<branch>/`. The trigger branch is
// pinned through the `ref` claim, so a sibling branch sharing a reusable
// workflow cannot match. Pinning the workflow file with `--workflow` is an
// optional extra restriction on top of that.
export function githubBranchAddBody(
	url: URL,
	identity: RepositoryIdentity,
	options: GithubBranchOptions
): OidcTrustAddBody {
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
		.option(
			'--root <name>',
			'a root the grant may set, or "same-as-cache" to tie it to the cache'
		)
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
				'    --cache-template pr-{pr} --root same-as-cache'
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
	body: OidcTrustAddBody,
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
