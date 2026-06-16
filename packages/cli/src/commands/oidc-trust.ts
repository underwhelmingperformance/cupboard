import { readFile } from 'node:fs/promises';

import type { CliUi } from '@cupboard/cli-ui';
import {
	type OidcTrustAddBody,
	oidcTrustAddBodySchema,
	type OidcTrustListResponse,
	type OidcTrustRemoveResponse,
	type OidcTrustSummary
} from '@cupboard/protocol/oidc';
import { type Reporter, type ResultRow } from '@cupboard/reporter';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { controlRpc, tenantRpc } from '../client/orpc.ts';
import { InvalidClaimError } from '../errors.ts';
import { deploymentUrlArgument, tenantUrlArgument } from '../url-argument.ts';

import { lookupRepository } from './oidc-trust/github.ts';
import {
	buildAddBody,
	buildCacheGrant,
	collectSubstitutions
} from './oidc-trust/rule-builder.ts';

const githubActionsIssuer = 'https://token.actions.githubusercontent.com';

interface GithubPrOptions {
	readonly repo: string;
	readonly audience?: string;
	readonly allow: readonly string[];
	readonly cacheTemplate?: string;
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
		claims: parseClaims(options.claim),
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
	readonly audience: string;
	readonly claim: readonly string[];
	readonly allow: readonly string[];
	readonly cache?: string;
	readonly cacheTemplate?: string;
	readonly root?: string;
	readonly rootTemplate?: string;
	readonly capture: readonly string[];
	readonly templateSource?: string;
	readonly fromFile?: string;
}

/**
 * The slice of the derived client the trust commands consume, in the
 * contract's input and output shapes; the real `tenantRpc(...).oidcTrust`
 * satisfies it by construction.
 */
export interface OidcTrustClient {
	list(): Promise<OidcTrustListResponse>;
	get(input: { id: string }): Promise<OidcTrustSummary>;
	add(input: OidcTrustAddBody): Promise<OidcTrustSummary>;
	remove(input: { id: string }): Promise<OidcTrustRemoveResponse>;
}

function collect(value: string, previous: readonly string[]): string[] {
	return [...previous, value];
}

function claimRows(claims: Record<string, string>): ResultRow[] {
	const entries = Object.entries(claims);

	if (entries.length === 0) {
		return [{ label: 'Claims', value: '(none)' }];
	}

	return entries.map(([key, value], index) => ({
		label: index === 0 ? 'Claims' : '',
		value: `${key}=${value}`
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
		url: string,
		programOptions: ProgramOptions
	) => OidcTrustClient;
}

const tenantPlane: OidcTrustPlane = {
	name: 'oidc-trust',
	description: 'Manage the OIDC trust rules used by token exchange.',
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
	description: 'Manage the control-plane OIDC trust rules (operator only).',
	urlArgument: deploymentUrlArgument,
	githubPr: false,
	clientFor: (url, programOptions) =>
		controlRpc(url, {
			credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
			signal: programOptions.signal
		}).oidcTrust
};

// Assemble the per-PR rule for a GitHub repository, pinning its immutable
// numeric ids so a rename never silently changes who is trusted.
function githubPrAddBody(
	url: string,
	identity: {
		readonly repositoryId: number;
		readonly repositoryOwnerId: number;
		readonly fullName: string;
	},
	options: GithubPrOptions
): OidcTrustAddBody {
	return buildAddBody({
		issuer: githubActionsIssuer,
		audience: options.audience ?? url,
		claims: {
			repository_id: String(identity.repositoryId),
			repository_owner_id: String(identity.repositoryOwnerId)
		},
		permittedGrants: [
			buildCacheGrant({
				cacheTemplate: options.cacheTemplate ?? 'pr-{pr}',
				allow: options.allow,
				root: 'same-as-cache',
				substitutions: collectSubstitutions({
					templateSource: 'github-pr',
					captures: []
				})
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
		.description('List OIDC trust rules.')
		.argument('<url>', plane.urlArgument)
		.action(async (url: string) => {
			const reporter = commandUi(program, programOptions).reporter();

			await runOidcTrustList(reporter, plane.clientFor(url, programOptions));
		});

	oidcTrust
		.command('show')
		.description('Show a single OIDC trust rule by id.')
		.argument('<url>', plane.urlArgument)
		.argument('<id>', 'trust rule id')
		.action(async (url: string, id: string) => {
			const reporter = commandUi(program, programOptions).reporter();

			await runOidcTrustShow(
				id,
				reporter,
				plane.clientFor(url, programOptions)
			);
		});

	oidcTrust
		.command('add')
		.description('Add a trust rule for a CI OIDC issuer.')
		.argument('<url>', plane.urlArgument)
		.requiredOption('--issuer <issuer>', 'OIDC issuer URL')
		.requiredOption('--audience <audience>', 'expected token audience')
		.option(
			'--claim <key=value>',
			'a claim the token must match exactly (repeatable)',
			collect,
			[]
		)
		.option(
			'--allow <action>',
			'an action set the rule may exchange for: push, attest, or root (repeatable)',
			collect,
			[]
		)
		.option('--cache <name>', 'an exact cache the grant is scoped to')
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
			'a built-in capture source, e.g. github-pr (binds {pr} from the ref claim)'
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
				'    --claim job_workflow_ref=acme/ci/.github/workflows/push.yml@refs/heads/main \\',
				'    --allow push --allow root --template-source github-pr \\',
				'    --cache-template pr-{pr} --root same-as-cache'
			].join('\n')
		)
		.action(async (url: string, options: OidcTrustAddOptions) => {
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
				'Add a per-PR trust rule for a GitHub repository, pinning its ids.'
			)
			.argument('<url>', plane.urlArgument)
			.requiredOption('--repo <owner/name>', 'the GitHub repository')
			.option(
				'--audience <audience>',
				'expected token audience (default: the tenant URL)'
			)
			.option(
				'--allow <action>',
				'an action set the rule may exchange for (repeatable, default: push)',
				collect,
				['push']
			)
			.option(
				'--cache-template <template>',
				'the per-PR cache template (default: pr-{pr})'
			)
			.action(async (url: string, options: GithubPrOptions) => {
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
	}

	oidcTrust
		.command('remove')
		.description('Disable an OIDC trust rule by id.')
		.argument('<url>', plane.urlArgument)
		.argument('<id>', 'trust rule id')
		.option('-y, --yes', 'remove without the confirmation prompt')
		.action(async (url: string, id: string, options: ConfirmableOptions) => {
			const ui = commandUi(program, programOptions, { assumeYes: options.yes });

			await runOidcTrustRemove(id, ui, plane.clientFor(url, programOptions));
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
	id: string,
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
	id: string,
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
