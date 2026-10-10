import { readFile } from 'node:fs/promises';

import type { CliUi } from '@cupboard/cli-ui';
import { cacheNameSchema } from '@cupboard/nix-store/scalars';
import { quotePatternLiteral } from '@cupboard/protocol/capture';
import { templateSchema, templateVariables } from '@cupboard/protocol/grants';
import {
	type ClaimMatch,
	controlOidcTrustAddBodySchema,
	type OidcTrustAddBodyInput,
	oidcTrustAddBodySchema,
	type OidcTrustListResponse,
	type OidcTrustRemoveResponse,
	type OidcTrustSummary,
	type TrustRuleId,
	trustRuleIdSchema,
	type UnreadableOidcTrustRule
} from '@cupboard/protocol/oidc';
import { type Reporter } from '@cupboard/reporter';
import type { Command } from 'commander';

import { type Audience, audienceSchema, parseAudience } from '../audience.ts';
import { cachedOwnerProvider } from '../auth/auth.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { controlRpc, tenantRpc } from '../client/orpc.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import {
	cloudflareDashIssuer,
	cloudflareOauthClientId
} from '../deploy/cloudflare-oauth.ts';
import {
	CliUsageError,
	InvalidClaimError,
	TrustRuleFileConflictError,
	TrustRuleOptionsRequiredError,
	WorkflowReferenceMutableError
} from '../errors.ts';
import { deploymentUrlArgument, tenantUrlArgument } from '../url-argument.ts';

import { githubActionsIssuer } from './github/claims.ts';
import {
	parseExactWorkflowReference,
	parseWorkflowReference,
	workflowReferenceClaim
} from './github/convention.ts';
import {
	pullRequestCacheTemplate,
	pullRequestRootTemplate
} from './github/convention.ts';
import {
	githubWorkflowSource,
	WorkflowDiscoveryError
} from './github/discovery.ts';
import { verifyWorkflowReference } from './github/workflow-reference.ts';
import { trustRuleSummaryRows } from './oidc-trust/format.ts';
import {
	lookupRepository,
	parseRepository,
	type RepositoryIdentity
} from './oidc-trust/github.ts';
import {
	buildAddBody,
	buildCacheContentReadGrant,
	buildCacheGrant,
	buildCacheGrants,
	buildPullRequestContentReadGrant,
	buildViewContentReadGrant,
	collectSubstitutions,
	jobWorkflowReferenceClaim as jobWorkflowReferenceClaim
} from './oidc-trust/rule-builder.ts';

type OidcTrustListResult = readonly (
	OidcTrustSummary | (UnreadableOidcTrustRule & { readonly unreadable: true })
)[];

interface GithubWorkflowOptions {
	readonly jobWorkflowRef?: string;
	readonly allowBranchWorkflow?: boolean;
}

interface GithubPrOptions extends GithubWorkflowOptions {
	readonly repo: string;
	readonly audience?: Audience;
	readonly cacheTemplate?: string;
	readonly rootTemplate?: string;
	readonly attest?: boolean;
	readonly readCache?: boolean;
	readonly readDefaultCache?: boolean;
}

interface GithubPrCloseOptions extends GithubWorkflowOptions {
	readonly repo: string;
	readonly audience?: Audience;
	readonly cacheTemplate?: string;
	readonly jobWorkflowRef: string;
}

interface GithubTagOptions extends GithubWorkflowOptions {
	readonly repo: string;
	readonly audience?: Audience;
	readonly cacheTemplate?: string;
	readonly rootTemplate?: string;
	readonly attest?: boolean;
	readonly readCache?: boolean;
}

interface GithubBranchOptions extends GithubWorkflowOptions {
	readonly repo: string;
	readonly branch: string;
	readonly audience?: Audience;
	readonly attest?: boolean;
	readonly readCache?: boolean;
	readonly readView?: string;
	readonly readPullRequestCaches?: boolean;
}

async function prepareGithubWorkflowReference(
	options: GithubWorkflowOptions,
	ui: CliUi,
	signal?: AbortSignal
): Promise<string | undefined> {
	const reference = options.jobWorkflowRef;
	if (
		reference === undefined ||
		!reference.includes('@') ||
		reference.includes('*')
	) {
		return reference;
	}
	const separator = reference.lastIndexOf('@');
	const prefix = reference.slice(0, separator);
	const pin = reference.slice(separator + 1);
	const lookupOptions = signal === undefined ? {} : { signal };
	let canonical = reference;
	if (!pin.startsWith('refs/') && !/^[0-9a-f]{40}$/u.test(pin)) {
		const parsed = parseExactWorkflowReference(`${prefix}@refs/tags/${pin}`);
		const resolved = await githubWorkflowSource(
			lookupOptions
		).resolveWorkflowReference?.(`${parsed.owner}/${parsed.repo}`, pin);
		if (resolved === undefined) {
			throw new WorkflowDiscoveryError(
				`Cannot resolve workflow reference ${reference}`
			);
		}
		canonical = `${prefix}@${resolved}`;
	}
	const workflow = parseExactWorkflowReference(canonical);
	if (workflow.pin.kind !== 'branch') {
		return canonical;
	}
	if (options.allowBranchWorkflow !== true) {
		throw new WorkflowReferenceMutableError(
			workflow.reference,
			workflow.pin.value
		);
	}
	ui.note('Branch workflow trust', [
		{
			label: workflow.reference,
			value: 'Trust rules accept future edits to this branch workflow.'
		}
	]);
	await ui.reporter().phase('Checking workflow reference on GitHub', () =>
		verifyWorkflowReference(workflow, {
			...lookupOptions,
			allowBranchWorkflow: true
		})
	);
	return canonical;
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

/**
 * The rule options given on the command line, as they are spelt there. A rule
 * file replaces all of them, so none may be combined with `--from-file`.
 */
export function ruleOptionsGiven(options: OidcTrustAddOptions): string[] {
	const given: [string, boolean][] = [
		['--issuer', options.issuer !== undefined],
		['--audience', options.audience !== undefined],
		['--claim', options.claim.length > 0],
		['--job-workflow-ref', options.jobWorkflowRef !== undefined],
		['--allow', options.allow.length > 0],
		['--cache', options.cache !== undefined],
		['--cache-template', options.cacheTemplate !== undefined],
		['--root', options.root !== undefined],
		['--root-template', options.rootTemplate !== undefined],
		['--capture', options.capture.length > 0],
		['--template-source', options.templateSource !== undefined]
	];

	return given.filter(([, isGiven]) => isGiven).map(([option]) => option);
}

// JSON input accepts the complete rule schema, including admin, domain, and
// control grants that have no dedicated flags.
async function addBodyFor(
	options: OidcTrustAddOptions
): Promise<OidcTrustAddBodyInput> {
	if (options.fromFile !== undefined) {
		const conflicts = ruleOptionsGiven(options);

		if (conflicts.length > 0) {
			throw new TrustRuleFileConflictError(conflicts);
		}

		return loadAddBody(options.fromFile, oidcTrustAddBodySchema);
	}

	const { issuer, audience } = options;

	if (issuer === undefined || audience === undefined) {
		throw new TrustRuleOptionsRequiredError([
			...(issuer === undefined ? ['--issuer'] : []),
			...(audience === undefined ? ['--audience'] : [])
		]);
	}

	const substitutions = collectSubstitutions({
		templateSource: options.templateSource,
		captures: options.capture
	});

	return buildAddBody({
		issuer,
		audience,
		claims: claimsForAdd(options.claim, options.jobWorkflowRef),
		permittedGrants: buildCacheGrants({
			cache: options.cache,
			cacheTemplate: options.cacheTemplate,
			allow: options.allow,
			root: options.root,
			rootTemplate: options.rootTemplate,
			substitutions
		})
	});
}

async function loadAddBody(
	path: string,
	schema: typeof oidcTrustAddBodySchema
): Promise<OidcTrustAddBodyInput> {
	let parsed: unknown;

	try {
		parsed = JSON.parse(await readFile(path, 'utf8'));
	} catch {
		throw new InvalidClaimError(`--from-file ${path} is not valid JSON`);
	}

	const result = schema.safeParse(parsed);

	if (!result.success) {
		throw new InvalidClaimError(result.error.message);
	}

	return result.data;
}

interface ConfirmableOptions {
	readonly yes?: boolean;
}

interface ControlOidcTrustAddOptions {
	readonly fromFile: string;
}

export interface OidcTrustAddOptions {
	readonly issuer?: string;
	readonly audience?: Audience;
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
	// A tenant rule grants cache authority, which `add` builds from options and
	// the GitHub presets fill in. A control-plane rule grants control, tenant or
	// wildcard authority, which no option builds, so its `add` reads the whole
	// rule from a file and the plane has no presets.
	readonly kind: 'tenant' | 'control';
	readonly clientFor: (
		url: URL,
		programOptions: ProgramOptions
	) => OidcTrustClient;
}

const tenantPlane: OidcTrustPlane = {
	name: 'oidc-trust',
	description:
		'Manage the trust rules that let administrators and CI jobs sign in to the tenant with OIDC identity tokens.',
	urlArgument: tenantUrlArgument,
	kind: 'tenant',
	clientFor: (url, programOptions) =>
		tenantRpc(url, {
			credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
			signal: programOptions.signal
		}).oidcTrust
};

const controlPlane: OidcTrustPlane = {
	name: 'control-oidc-trust',
	description:
		'Manage the trust rules that let other operators and CI jobs manage the deployment (operator only).',
	urlArgument: deploymentUrlArgument,
	kind: 'control',
	clientFor: (url, programOptions) =>
		controlRpc(url, {
			credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
			signal: programOptions.signal
		}).oidcTrust
};

// Pin repository and owner IDs as well as the event. Template substitutions
// choose a cache name; they do not restrict which repository can authenticate.
export function githubPrAddBody(
	url: URL,
	identity: RepositoryIdentity,
	options: GithubPrOptions
): OidcTrustAddBodyInput {
	const cacheTemplate = options.cacheTemplate ?? pullRequestCacheTemplate();

	// Pin the event so a verified token from the same repository cannot select
	// this rule for a branch or tag build.
	const claims: Record<string, ClaimMatch> = {
		repository_id: String(identity.repositoryId),
		repository_owner_id: String(identity.repositoryOwnerId),
		event_name: 'pull_request',
		...(options.jobWorkflowRef !== undefined && {
			job_workflow_ref: jobWorkflowReferenceClaim(options.jobWorkflowRef)
		})
	};

	return buildAddBody({
		issuer: githubActionsIssuer,
		audience: options.audience ?? audienceSchema.parse(url),
		claims,
		permittedGrants: [
			buildCacheGrant({
				cacheTemplate,
				rootTemplate:
					options.rootTemplate ?? pullRequestRootTemplate(identity.fullName),
				allow: withAttest(
					['push', 'root', 'attach', 'create', 'close', 'reopen'],
					options.attest
				),
				substitutions: collectSubstitutions({
					templateSource: 'github-pr',
					captures: []
				})
			}),
			...(options.readDefaultCache === true
				? [buildCacheContentReadGrant({})]
				: []),
			...(options.readCache === true
				? [
						buildCacheContentReadGrant({
							cacheTemplate,
							substitutions: collectSubstitutions({
								templateSource: 'github-pr',
								captures: []
							})
						})
					]
				: [])
		],
		display: { provider: 'github', repository: identity.fullName }
	});
}

class MergedCloseTemplateError extends CliUsageError {
	constructor(message: string) {
		super(message);
		this.name = 'MergedCloseTemplateError';
	}
}

/**
Permits merged pull-request runs to close the repository's selected PR caches.
*/
export function githubPrCloseAddBody(
	url: URL,
	identity: RepositoryIdentity,
	options: GithubPrCloseOptions
): OidcTrustAddBodyInput {
	const template = templateSchema.parse(
		options.cacheTemplate ?? pullRequestCacheTemplate()
	);
	const workflow = parseWorkflowReference(options.jobWorkflowRef);
	if (workflow.pin.kind === 'branch' && options.allowBranchWorkflow !== true) {
		throw new WorkflowReferenceMutableError(
			workflow.reference,
			workflow.pin.value
		);
	}

	if (
		templateVariables(template).some(
			(variable) => variable !== 'pr' && variable !== 'repository_id'
		)
	) {
		throw new MergedCloseTemplateError(
			'The merged-close cache template supports only {pr} and {repository_id}. Use an exact cache grant in a manual trust rule for other templates.'
		);
	}

	const rendered = template.replaceAll('{repository_id}', () =>
		String(identity.repositoryId)
	);
	const parts = rendered.split('{pr}');

	if (parts.length > 2) {
		throw new MergedCloseTemplateError(
			'The merged-close cache template supports at most one {pr}. Keep the publication rule, and configure exact cache:close grants in a manual lifecycle rule for repeated {pr} templates.'
		);
	}

	const binding =
		parts.length === 1
			? { exact: cacheNameSchema.parse(rendered) }
			: {
					pattern: `^${parts.map((part) => quotePatternLiteral(part)).join('[0-9]+')}$`
				};

	return buildAddBody({
		issuer: githubActionsIssuer,
		audience: options.audience ?? audienceSchema.parse(url),
		claims: {
			repository_id: String(identity.repositoryId),
			repository_owner_id: String(identity.repositoryOwnerId),
			event_name: 'pull_request',
			ref: { pattern: '^refs/heads/.+$' },
			job_workflow_ref: workflowReferenceClaim(workflow)
		},
		permittedGrants: [
			{
				type: 'cupboard_cache',
				actions: ['cache:close'],
				resources: {
					cache: { kind: 'named', ...binding, validate: 'cacheName' }
				}
			}
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
		ref_type: 'tag',
		...(options.jobWorkflowRef !== undefined && {
			job_workflow_ref: jobWorkflowReferenceClaim(options.jobWorkflowRef)
		})
	};

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
			}),
			...(options.readCache === true
				? [
						buildCacheContentReadGrant({
							cacheTemplate,
							substitutions: collectSubstitutions({
								templateSource: 'github-tag',
								captures: []
							})
						})
					]
				: [])
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
		ref: `refs/heads/${options.branch}`,
		...(options.jobWorkflowRef !== undefined && {
			job_workflow_ref: jobWorkflowReferenceClaim(options.jobWorkflowRef)
		})
	};

	return buildAddBody({
		issuer: githubActionsIssuer,
		audience: options.audience ?? audienceSchema.parse(url),
		claims,
		permittedGrants: [
			buildCacheGrant({
				allow: withAttest(['push', 'root', 'attach'], options.attest),
				root: `github:${identity.fullName}/${options.branch}/`
			}),
			...(options.readCache === true ? [buildCacheContentReadGrant({})] : []),
			...(options.readPullRequestCaches === true
				? [buildPullRequestContentReadGrant(identity.repositoryId)]
				: []),
			...(options.readView === undefined
				? []
				: [buildViewContentReadGrant(options.readView)])
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
		.description(
			"List the trust rules, including disabled ones, with each rule's issuer, audience and grants."
		)
		.argument('<url>', plane.urlArgument, parseWorkerUrl)
		.action(async (url: URL) => {
			const reporter = commandUi(program, programOptions).reporter();

			await runOidcTrustList(
				reporter,
				plane.clientFor(url, programOptions),
				plane.kind,
				url
			);
		});

	oidcTrust
		.command('show')
		.description(
			'Show one trust rule in full: the tokens that it accepts and the grants that it gives.'
		)
		.argument('<url>', plane.urlArgument, parseWorkerUrl)
		.argument('<id>', 'trust rule ID')
		.action(async (url: URL, id: string) => {
			const reporter = commandUi(program, programOptions).reporter();

			await runOidcTrustShow(
				trustRuleIdSchema.parse(id),
				reporter,
				plane.clientFor(url, programOptions)
			);
		});

	if (plane.kind === 'control') {
		registerControlRuleAdd(oidcTrust, program, programOptions, plane);
	} else {
		registerTenantRuleAdd(oidcTrust, program, programOptions, plane);
	}

	if (plane.kind === 'tenant') {
		oidcTrust
			.command('add-github-pr')
			.description(
				'Add a trust rule that lets each pull request in a GitHub repository publish to a cache of its own.'
			)
			.argument('<url>', plane.urlArgument, parseWorkerUrl)
			.requiredOption(
				'--repo <owner/name>',
				'the GitHub repository',
				parseRepository
			)
			.option(
				'--audience <audience>',
				'audience that the token must have (default: the tenant URL)',
				parseAudience
			)
			.option(
				'--cache-template <template>',
				'cache name for each pull request (default: gh-{repository_id}-pr-{pr})'
			)
			.option(
				'--root-template <template>',
				'root prefix for each pull request (default: github:<owner>/<repo>/pr-{pr}/)'
			)
			.option(
				'--workflow-ref, --job-workflow-ref <value>',
				'also require the job_workflow_ref claim, given as owner/repo/path@ref. Branch refs require --allow-branch-workflow and accept future workflow edits. Without @ref, it matches the workflow file at any ref.'
			)
			.option(
				'--allow-branch-workflow',
				'permit an exact branch workflow reference and its future edits'
			)
			.option(
				'--read-cache',
				'also permit content reads from the selected cache'
			)
			.option(
				'--no-attest',
				'leave out the attest grant, so that runs cannot attach attestations'
			)
			.addHelpText(
				'after',
				[
					'',
					'Example:',
					'  # Let each pull request in acme/app publish to its own',
					'  # gh-<repository-id>-pr-<number> cache',
					'  cupboard oidc-trust add-github-pr https://cupboard.example.workers.dev/t/acme \\',
					'    --repo acme/app'
				].join('\n')
			)
			.action(async (url: URL, options: GithubPrOptions) => {
				const ui = commandUi(program, programOptions);
				const reporter = ui.reporter();
				const jobWorkflowReference = await prepareGithubWorkflowReference(
					options,
					ui,
					programOptions.signal
				);
				const identity = await reporter.phase('Resolving repository', () =>
					lookupRepository(options.repo)
				);

				await runOidcTrustAdd(
					githubPrAddBody(url, identity, {
						...options,
						...(jobWorkflowReference !== undefined && {
							jobWorkflowRef: jobWorkflowReference
						})
					}),
					reporter,
					plane.clientFor(url, programOptions)
				);
			});

		oidcTrust
			.command('add-github-pr-close')
			.description(
				'Permit merged pull-request runs to close the selected PR cache family, without publication or read authority.'
			)
			.argument('<url>', plane.urlArgument, parseWorkerUrl)
			.requiredOption(
				'--repo <owner/name>',
				'the GitHub repository',
				parseRepository
			)
			.requiredOption(
				'--workflow-ref, --job-workflow-ref <value>',
				'require this workflow pinned to a commit, release tag or tag pattern, as owner/repo/path@ref; an exact refs/heads/<branch> reference requires --allow-branch-workflow'
			)
			.option(
				'--allow-branch-workflow',
				'also accept an exact refs/heads/<branch> workflow reference; the closure rule will accept future edits to that branch workflow'
			)
			.option(
				'--audience <audience>',
				'audience that the token must have (default: the tenant URL)',
				parseAudience
			)
			.option(
				'--cache-template <template>',
				'PR cache family, with at most one {pr} (default: gh-{repository_id}-pr-{pr})'
			)
			.action(async (url: URL, options: GithubPrCloseOptions) => {
				const ui = commandUi(program, programOptions);
				const reporter = ui.reporter();
				const jobWorkflowReference = await prepareGithubWorkflowReference(
					options,
					ui,
					programOptions.signal
				);
				const identity = await reporter.phase('Resolving repository', () =>
					lookupRepository(options.repo)
				);
				await runOidcTrustAdd(
					githubPrCloseAddBody(url, identity, {
						...options,
						jobWorkflowRef: jobWorkflowReference ?? options.jobWorkflowRef
					}),
					reporter,
					plane.clientFor(url, programOptions)
				);
			});

		oidcTrust
			.command('add-github-tag')
			.description(
				"Add a trust rule that lets a GitHub repository's tag runs publish to a cache named after the tag."
			)
			.argument('<url>', plane.urlArgument, parseWorkerUrl)
			.requiredOption(
				'--repo <owner/name>',
				'the GitHub repository',
				parseRepository
			)
			.option(
				'--audience <audience>',
				'audience that the token must have (default: the tenant URL)',
				parseAudience
			)
			.option(
				'--cache-template <template>',
				'cache name for each tag (default: {tag})'
			)
			.option(
				'--root-template <template>',
				'root prefix for each tag (default: github:<owner>/<repo>/<cache name>/)'
			)
			.option(
				'--workflow-ref, --job-workflow-ref <value>',
				'also require the job_workflow_ref claim, given as owner/repo/path@ref. Branch refs require --allow-branch-workflow and accept future workflow edits. Without @ref, it matches the workflow file at any ref.'
			)
			.option(
				'--allow-branch-workflow',
				'permit an exact branch workflow reference and its future edits'
			)
			.option(
				'--read-cache',
				'also permit content reads from the selected cache'
			)
			.option(
				'--no-attest',
				'leave out the attest grant, so that runs cannot attach attestations'
			)
			.addHelpText(
				'after',
				[
					'',
					'Example:',
					'  # Let tag runs in acme/app publish to a cache named after',
					'  # the tag, such as v1.2.3',
					'  cupboard oidc-trust add-github-tag https://cupboard.example.workers.dev/t/acme \\',
					'    --repo acme/app'
				].join('\n')
			)
			.action(async (url: URL, options: GithubTagOptions) => {
				const ui = commandUi(program, programOptions);
				const reporter = ui.reporter();
				const jobWorkflowReference = await prepareGithubWorkflowReference(
					options,
					ui,
					programOptions.signal
				);
				const identity = await reporter.phase('Resolving repository', () =>
					lookupRepository(options.repo)
				);

				await runOidcTrustAdd(
					githubTagAddBody(url, identity, {
						...options,
						...(jobWorkflowReference !== undefined && {
							jobWorkflowRef: jobWorkflowReference
						})
					}),
					reporter,
					plane.clientFor(url, programOptions)
				);
			});

		oidcTrust
			.command('add-github-branch')
			.description(
				"Add a trust rule that lets runs on one branch of a GitHub repository publish to the tenant's default cache."
			)
			.argument('<url>', plane.urlArgument, parseWorkerUrl)
			.requiredOption(
				'--repo <owner/name>',
				'the GitHub repository',
				parseRepository
			)
			.requiredOption(
				'--branch <name>',
				'the branch whose runs may publish (e.g. main)'
			)
			.option(
				'--workflow-ref, --job-workflow-ref <value>',
				'also require the job_workflow_ref claim, given as owner/repo/path@ref. Branch refs require --allow-branch-workflow and accept future workflow edits. Without @ref, it matches the workflow file at any ref.'
			)
			.option(
				'--allow-branch-workflow',
				'permit an exact branch workflow reference and its future edits'
			)
			.option(
				'--audience <audience>',
				'audience that the token must have (default: the tenant URL)',
				parseAudience
			)
			.option(
				'--read-cache',
				'also permit content reads from the selected cache'
			)
			.option(
				'--no-attest',
				'leave out the attest grant, so that runs cannot attach attestations'
			)
			.addHelpText(
				'after',
				[
					'',
					'Example:',
					'  # Let runs on main publish to the default cache, but only through',
					"  # cupboard's reusable flake publish workflow at a release tag",
					'  cupboard oidc-trust add-github-branch https://cupboard.example.workers.dev/t/acme \\',
					'    --repo acme/app --branch main \\',
					"    --job-workflow-ref 'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v*'"
				].join('\n')
			)
			.action(async (url: URL, options: GithubBranchOptions) => {
				const ui = commandUi(program, programOptions);
				const reporter = ui.reporter();
				const jobWorkflowReference = await prepareGithubWorkflowReference(
					options,
					ui,
					programOptions.signal
				);
				const identity = await reporter.phase('Resolving repository', () =>
					lookupRepository(options.repo)
				);

				await runOidcTrustAdd(
					githubBranchAddBody(url, identity, {
						...options,
						...(jobWorkflowReference !== undefined && {
							jobWorkflowRef: jobWorkflowReference
						})
					}),
					reporter,
					plane.clientFor(url, programOptions)
				);
			});
	}

	oidcTrust
		.command('remove')
		.description(
			'Disable a trust rule, so that it no longer accepts tokens. The rule stays in the list, marked as disabled.'
		)
		.argument('<url>', plane.urlArgument, parseWorkerUrl)
		.argument('<id>', 'trust rule ID')
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

/**
 * `oidc-trust add`: a tenant rule built from options or read whole from
 * `--from-file`.
 */
function registerTenantRuleAdd(
	oidcTrust: Command,
	program: Command,
	programOptions: ProgramOptions,
	plane: OidcTrustPlane
): void {
	oidcTrust
		.command('add')
		.description(
			'Add a trust rule by hand: the issuer, audience and claims that a token must have, and the grants that the rule gives.'
		)
		.argument('<url>', plane.urlArgument, parseWorkerUrl)
		.option(
			'--issuer <issuer>',
			'OIDC issuer that must have signed the token (required unless you use --from-file)'
		)
		.option(
			'--audience <audience>',
			'audience that the token must have (required unless you use --from-file)',
			parseAudience
		)
		.option(
			'--claim <key=value>',
			'a claim that the token must have, with exactly this value (repeatable)',
			collect,
			[]
		)
		.option(
			'--workflow-ref, --job-workflow-ref <ref>',
			'require the job_workflow_ref claim, which identifies the workflow file and ref that the job runs; the same reference is --workflow-ref on github setup/check'
		)
		.option(
			'--allow <action>',
			'a grant to give (repeatable): read, push, attest, root, attach, create, close, reopen or remove',
			collect,
			[]
		)
		.option(
			'--cache <name>',
			"the cache that the grants apply to (default: the tenant's default cache)"
		)
		.option(
			'--cache-template <template>',
			'make the cache name from values in the token, such as "pr-{pr}" (see --template-source and --capture)'
		)
		.option(
			'--root <name>',
			'the root that publication grants cover, or a root prefix ending in /'
		)
		.option(
			'--root-template <template>',
			'make the publication root name from values in the token (see --template-source and --capture)'
		)
		.option(
			'--capture <claim=pattern>',
			'claim=regex, where each named group in the regular expression becomes a template variable (repeatable)',
			collect,
			[]
		)
		.option(
			'--template-source <name>',
			'take template variables from GitHub token claims: github-pr gives {repository_id} and {pr}, and github-tag gives {tag}'
		)
		.option(
			'--from-file <path>',
			"read the whole rule, including its issuer and audience, from a JSON file. Can't be combined with the other rule options."
		)
		.addHelpText(
			'after',
			[
				'',
				'Example:',
				"  # Let a reusable workflow push to its pull request's own cache and",
				'  # no other. The rule matches on the job_workflow_ref claim.',
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
}

/**
 * `control-oidc-trust add`: a control-plane rule read whole from a file. Its
 * grants (control, tenant or wildcard authority) have no options, and the
 * cache and root options of a tenant rule do not apply.
 */
function registerControlRuleAdd(
	oidcTrust: Command,
	program: Command,
	programOptions: ProgramOptions,
	plane: OidcTrustPlane
): void {
	oidcTrust
		.command('add')
		.description(
			'Add a control-plane trust rule from a JSON file: the issuer, audience and claims that a token must have, including an exact sub claim, and the grants that it may exchange for.'
		)
		.argument('<url>', plane.urlArgument, parseWorkerUrl)
		.requiredOption(
			'--from-file <path>',
			'read the whole rule, including its issuer, audience, claims and grants, from a JSON file'
		)
		.addHelpText(
			'after',
			[
				'',
				'Example:',
				'  # Let another operator sign in with their Cloudflare account. A',
				'  # control-plane rule must pin the sub claim.',
				"  cat > operator.json <<'EOF'",
				'  {',
				`    "issuer": "${cloudflareDashIssuer}",`,
				`    "audience": "${cloudflareOauthClientId}",`,
				'    "claims": { "sub": "<their subject>" },',
				'    "permittedGrants": [{ "type": "cupboard_wildcard" }]',
				'  }',
				'EOF',
				'  cupboard control-oidc-trust add https://cupboard.example.workers.dev \\',
				'    --from-file operator.json'
			].join('\n')
		)
		.action(async (url: URL, options: ControlOidcTrustAddOptions) => {
			const reporter = commandUi(program, programOptions).reporter();

			await runOidcTrustAdd(
				await loadAddBody(options.fromFile, controlOidcTrustAddBodySchema),
				reporter,
				plane.clientFor(url, programOptions)
			);
		});
}

export async function runOidcTrustList(
	reporter: Reporter,
	client: Pick<OidcTrustClient, 'list'>,
	plane: 'tenant' | 'control' = 'tenant',
	url?: URL
): Promise<void> {
	const { rules, unreadable = [] } = await reporter.phase(
		'Listing OIDC trust rules',
		() => client.list()
	);
	const data: OidcTrustListResult = [
		...rules,
		...unreadable.map((rule) => ({ ...rule, unreadable: true as const }))
	];

	reporter.result({
		kind: 'oidc-trust-rules',
		title: 'Trust rules',
		data,
		rows: rules.flatMap((rule) => trustRuleSummaryRows(rule)),
		empty: unreadable.length === 0 ? 'No OIDC trust rules.' : undefined
	});

	for (const { id, disabled: isDisabled } of unreadable) {
		if (isDisabled) {
			reporter.info(
				`The server cannot read trust rule ${id}. The rule is disabled and remains only as a record.`
			);
			continue;
		}

		reporter.warn(
			`The server cannot read trust rule ${id}, which is enabled`,
			'ID token exchanges fail until you remove the rule',
			{
				humanMessage:
					plane === 'control'
						? `Operator sign-ins are blocked by unreadable trust rule ${id}. Repair or remove it with \`cupboard control-oidc-trust remove ${url?.href.replace(/\/$/u, '') ?? '<url>'} ${id}\`.`
						: `Trust rule ${id} cannot authorise new sign-ins. Repair or remove the rule. Other readable rules can still authorise access.`
			}
		);
	}
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
		title: 'Trust rule',
		data: summary,
		rows: trustRuleSummaryRows(summary)
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
		title: 'Trust rule',
		data: summary,
		rows: trustRuleSummaryRows(summary)
	});
}

export async function runOidcTrustRemove(
	id: TrustRuleId,
	ui: CliUi,
	client: OidcTrustClient
): Promise<void> {
	const outcome = await ui.confirm({
		message: `Remove OIDC trust rule ${id}?`,
		detail:
			'People and CI jobs that rely on this rule will no longer be able to start or renew sign-ins. Existing credentials may continue to work until they expire.'
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
		title: 'Trust rule',
		data: result,
		rows: [
			{ label: 'Rule', value: result.id },
			{ label: 'Removed', value: result.removed ? 'yes' : 'not present' }
		]
	});
}
