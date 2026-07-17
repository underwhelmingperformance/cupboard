import { readFile } from 'node:fs/promises';

import { type CacheInfo } from '@cupboard/nix-store/cache-info';
import { DEFAULT_CACHE, selectorForCache } from '@cupboard/nix-store/scalars';
import { isGrantPermittedByRule } from '@cupboard/protocol/grant-match';
import {
	type AuthorizationDetail,
	type AuthorizationDetails
} from '@cupboard/protocol/grants';
import { type OidcTrustSummary } from '@cupboard/protocol/oidc';
import {
	claimMismatches,
	firstClaimMismatch,
	isClaimSatisfied,
	matchOidcTrust,
	type OidcClaims,
	type OidcTrustRule
} from '@cupboard/protocol/oidc-trust-match';
import { type ReuseViewSelector } from '@cupboard/protocol/reuse-views';
import { type Reporter, type ResultRow } from '@cupboard/reporter';
import { z } from 'zod';

import {
	confirmAuthorizationDetails,
	pushAuthorizationDetails,
	rootEnsureAuthorizationDetails
} from '../../auth/attenuate.ts';
import {
	GithubCheckFailedError,
	GithubCheckIncompleteError,
	InvalidManifestError
} from '../../errors.ts';
import { githubActionsIssuer } from '../oidc-trust.ts';
import {
	lookupRepository,
	type RepositoryIdentity
} from '../oidc-trust/github.ts';
import { type PolicyClient } from '../policy.ts';
import { type ReuseViewClient } from '../reuse-view.ts';

import {
	minimumGraceSeconds,
	pullRequestPrefix,
	pullRequestViewName
} from './convention.ts';
import {
	requireGithubToken,
	type VariablesClient,
	variablesClient
} from './variables.ts';

export interface GithubCheckOptions {
	readonly repo: string;
	readonly branch: string;
	readonly workflowRef: string;
	readonly manifest?: string;
	readonly rootPrefix?: string;
	readonly readUser?: string;
	readonly readPassword?: string;
}

export interface GithubCheckClient {
	readonly policies: Pick<PolicyClient, 'graceList'>;
	readonly reuseViews: Pick<ReuseViewClient, 'list'>;
	readonly oidcTrust: {
		list(): Promise<{ rules: OidcTrustSummary[] }>;
	};
}

export interface GithubCheckDependencies {
	readonly lookupRepository?: typeof lookupRepository;
	readonly fetchCacheInfo: (url: string) => Promise<CacheInfo>;
	/**
	 * Reads a repository variable; `undefined` when the variable is not set.
	 * Anything it throws (a missing token, an unauthorised or failed API call)
	 * degrades the dependent checks to unverified, naming the cause, instead
	 * of failing them.
	 */
	readonly readVariable?: (name: string) => Promise<string | undefined>;
	readonly readManifestFile?: (path: string) => Promise<string>;
}

export interface CheckFinding {
	readonly check: string;
	readonly status: 'ok' | 'failed' | 'unverified';
	readonly detail?: string;
}

// The claim set a genuine pull-request run of the pinned repository presents.
// The pull-request number is a placeholder: rules capture it from `ref` in
// their grant bindings, so the grant checks request the matching pr-1 cache
// and root.
function pullRequestClaims(
	url: string,
	identity: RepositoryIdentity,
	workflowReference: string
): OidcClaims {
	return {
		iss: githubActionsIssuer,
		aud: url,
		repository_id: String(identity.repositoryId),
		repository_owner_id: String(identity.repositoryOwnerId),
		event_name: 'pull_request',
		ref: 'refs/pull/1/merge',
		job_workflow_ref: workflowReference
	};
}

function branchClaims(
	url: string,
	identity: RepositoryIdentity,
	branch: string,
	workflowReference: string
): OidcClaims {
	return {
		iss: githubActionsIssuer,
		aud: url,
		repository_id: String(identity.repositoryId),
		repository_owner_id: String(identity.repositoryOwnerId),
		event_name: 'push',
		ref: `refs/heads/${branch}`,
		job_workflow_ref: workflowReference
	};
}

function toMatcherRule(summary: OidcTrustSummary): OidcTrustRule {
	return {
		id: summary.id,
		issuer: summary.issuer,
		audience: summary.audience,
		claims: summary.claims,
		permittedGrants: summary.permittedGrants
	};
}

// The claims that identify which trigger a rule is for. A candidate that
// mismatches on one of these is a rule for a different event, not the rule
// this shape was meant to match, so it ranks behind a candidate whose
// mismatches are all configuration.
const triggerClaims = new Set(['event_name', 'ref', 'ref_type']);

// Explains why no rule matched `claims`: the repository-pinned candidates are
// diagnosed claim by claim, mirroring the server's refusal diagnostics, and a
// candidate whose configured claims all match must differ on its audience.
// With several candidates (a PR rule and a branch rule, say), the rule this
// shape was meant to match is the one whose trigger claims agree; its first
// failing claim is the useful diagnosis, not the sibling's event mismatch.
function unmatchedDetail(
	rules: readonly OidcTrustRule[],
	claims: OidcClaims
): string {
	const candidates = rules.filter((rule) => {
		const pinned = rule.claims.repository_id;

		return (
			pinned !== undefined && isClaimSatisfied(pinned, claims.repository_id)
		);
	});
	const candidate = candidates
		.map((rule) => {
			const mismatches = claimMismatches(rule, claims);

			return {
				rule,
				triggerMismatches: mismatches.filter((mismatch) =>
					triggerClaims.has(mismatch.claim)
				).length,
				mismatches: mismatches.length
			};
		})
		.toSorted(
			(left, right) =>
				left.triggerMismatches - right.triggerMismatches ||
				left.mismatches - right.mismatches ||
				left.rule.id.localeCompare(right.rule.id)
		)
		.at(0)?.rule;

	if (candidate === undefined) {
		return 'no rule pins this repository';
	}

	const mismatch = firstClaimMismatch(candidate, claims);

	if (mismatch === undefined) {
		return `rule ${candidate.id} expects audience ${candidate.audience}, a run presents ${String(claims.aud)}`;
	}

	const presented =
		mismatch.presented === undefined
			? 'the run presents no such claim'
			: `a run presents ${mismatch.presented}`;

	return `rule ${candidate.id} expects ${mismatch.claim} to match ${mismatch.expected}; ${presented}`;
}

function describeAuthorizationDetail(detail: AuthorizationDetail): string {
	if (detail.type !== 'cupboard_cache') {
		return detail.type;
	}

	const root = detail.root === undefined ? '' : ` with root ${detail.root}`;

	return `${detail.actions.join(', ')} on cache ${detail.cache}${root}`;
}

// A rule whose claims match can still refuse a run: the exchange enforces the
// rule's stored grants, so the grants must cover everything the run requests.
// Each request below is built by the same helpers the CLI's commands use, so
// this check and a real run ask for the same authority.
function checkTrustRule(
	check: string,
	rules: readonly OidcTrustRule[],
	claims: OidcClaims,
	requests: readonly AuthorizationDetails[]
): CheckFinding {
	const matched = matchOidcTrust(rules, claims);

	if (matched === undefined) {
		return { check, status: 'failed', detail: unmatchedDetail(rules, claims) };
	}

	for (const request of requests) {
		const refused = request.find(
			(detail) =>
				!isGrantPermittedByRule(matched.permittedGrants, detail, claims)
		);

		if (refused !== undefined) {
			return {
				check,
				status: 'failed',
				detail: `rule ${matched.id} matches but its grants do not permit ${describeAuthorizationDetail(refused)}; remove it and re-run setup`
			};
		}
	}

	return { check, status: 'ok' };
}

// The grace in force for one cache, mirroring the server's resolution: the
// longest matching cache-name prefix wins, and the empty prefix matches every
// cache as the tenant default.
function effectiveGraceSeconds(
	policies: readonly { cachePrefix: string; graceSeconds: number }[],
	cache: string
): number | undefined {
	return policies
		.filter((policy) => cache.startsWith(policy.cachePrefix))
		.toSorted(
			(left, right) => right.cachePrefix.length - left.cachePrefix.length
		)
		.at(0)?.graceSeconds;
}

function gracePolicyCaches(
	policies: readonly { cachePrefix: string }[]
): readonly string[] {
	const caches = new Set<string>([DEFAULT_CACHE, `${pullRequestPrefix}1`]);
	const pullRequestNumberPattern = /^[1-9][0-9]*$/u;

	for (const { cachePrefix } of policies) {
		const pullRequestNumber = cachePrefix.slice(pullRequestPrefix.length);

		if (
			cachePrefix.startsWith(pullRequestPrefix) &&
			pullRequestNumberPattern.test(pullRequestNumber)
		) {
			caches.add(cachePrefix);
		}
	}

	return [...caches];
}

// A covering policy can be shadowed by any longer prefix that names a real PR
// cache. Each such prefix is itself a representative destination for the
// policy it introduces.
async function checkGracePolicy(
	client: GithubCheckClient
): Promise<CheckFinding> {
	const check = 'grace policy';
	const { policies } = await client.policies.graceList();

	for (const cache of gracePolicyCaches(policies)) {
		const graceSeconds = effectiveGraceSeconds(policies, cache);
		const cacheLabel = cache === DEFAULT_CACHE ? 'default' : cache;

		if (graceSeconds === undefined) {
			return {
				check,
				status: 'failed',
				detail: `no grace policy covers the ${cacheLabel} cache: intermediate-retention grace publishes intermediates nothing retains`
			};
		}

		if (graceSeconds < minimumGraceSeconds) {
			return {
				check,
				status: 'failed',
				detail: `the ${String(graceSeconds)}s grace in force for the ${cacheLabel} cache is under ${String(minimumGraceSeconds)}s and risks expiring mid-run`
			};
		}
	}

	return { check, status: 'ok' };
}

function hasPullRequestViewSelectors(
	selectors: readonly ReuseViewSelector[]
): boolean {
	return (
		selectors.length === 1 &&
		selectors[0]?.kind === 'prefix' &&
		selectors[0].pattern === pullRequestPrefix
	);
}

async function checkReuseView(
	url: string,
	client: GithubCheckClient,
	fetchCacheInfo: (url: string) => Promise<CacheInfo>
): Promise<CheckFinding> {
	const check = 'reuse view';
	const { views } = await client.reuseViews.list();
	const definition = views.find((view) => view.name === pullRequestViewName);

	if (definition === undefined) {
		return {
			check,
			status: 'failed',
			detail: `the ${pullRequestViewName} view is not defined`
		};
	}

	if (!hasPullRequestViewSelectors(definition.selectors)) {
		return {
			check,
			status: 'failed',
			detail: `stored selectors differ from the single ${pullRequestPrefix} prefix setup would write`
		};
	}

	const destination = await fetchCacheInfo(url);
	let view: CacheInfo;

	try {
		view = await fetchCacheInfo(
			`${url.replace(/\/$/, '')}/reuse/${pullRequestViewName}`
		);
	} catch {
		return {
			check,
			status: 'failed',
			detail: `the ${pullRequestViewName} view does not answer nix-cache-info`
		};
	}

	if (view.priority <= destination.priority) {
		return {
			check,
			status: 'failed',
			detail: `view priority ${String(view.priority)} does not exceed the destination's ${String(destination.priority)}`
		};
	}

	return { check, status: 'ok' };
}

const runnerGroupSchema = z.strictObject({
	group: z.string().min(1),
	labels: z.array(z.string())
});
const planRunnerSchema = z.union([z.string().min(1), runnerGroupSchema]);

const manifestSchema = z.array(z.looseObject({ os: z.string().min(1) }));

// Splits CUPBOARD_RUNNERS into its permitted labels; a `label@group` entry
// permits the label part. GitHub compares labels case-insensitively within
// ASCII, so the comparison is lowercased.
function permittedLabels(runners: string): Set<string> {
	return new Set(
		runners
			.split(/[\s,]+/)
			.filter((entry) => entry !== '')
			.map((entry) => {
				const at = entry.indexOf('@');

				return (at === -1 ? entry : entry.slice(0, at)).toLowerCase();
			})
	);
}

// A variable that cannot be read is a fact about this environment, not about
// the repository: the check degrades to unverified with the cause named.
function unreadableDetail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function checkPlanRunner(
	readVariable: (name: string) => Promise<string | undefined>
): Promise<CheckFinding> {
	const check = 'plan runner variable';
	let value: string | undefined;

	try {
		value = await readVariable('CUPBOARD_PLAN_RUNNER');
	} catch (error) {
		return { check, status: 'unverified', detail: unreadableDetail(error) };
	}

	if (value === undefined) {
		return {
			check,
			status: 'failed',
			detail: 'CUPBOARD_PLAN_RUNNER is not set; the plan job has no runner'
		};
	}

	let parsed: unknown;

	try {
		parsed = JSON.parse(value);
	} catch {
		return {
			check,
			status: 'failed',
			detail: 'CUPBOARD_PLAN_RUNNER is not JSON; a plain label needs its quotes'
		};
	}

	if (!planRunnerSchema.safeParse(parsed).success) {
		return {
			check,
			status: 'failed',
			detail:
				'CUPBOARD_PLAN_RUNNER must be a JSON string or {"group": ..., "labels": [...]}'
		};
	}

	return { check, status: 'ok' };
}

async function checkRunnerLabels(
	options: GithubCheckOptions,
	readVariable: (name: string) => Promise<string | undefined>,
	readManifestFile: (path: string) => Promise<string>
): Promise<CheckFinding> {
	const check = 'runner labels';

	if (options.manifest === undefined) {
		return {
			check,
			status: 'unverified',
			detail:
				'no --manifest given; evaluate the target manifest with `nix eval --json` and pass the file'
		};
	}

	let runners: string | undefined;

	try {
		runners = await readVariable('CUPBOARD_RUNNERS');
	} catch (error) {
		return { check, status: 'unverified', detail: unreadableDetail(error) };
	}

	if (runners === undefined) {
		return {
			check,
			status: 'failed',
			detail: 'CUPBOARD_RUNNERS is not set; no manifest label is permitted'
		};
	}

	let manifestText: string;

	try {
		manifestText = await readManifestFile(options.manifest);
	} catch (error) {
		throw new InvalidManifestError(options.manifest, { cause: error });
	}

	let manifestValue: unknown;

	try {
		manifestValue = JSON.parse(manifestText);
	} catch (error) {
		throw new InvalidManifestError(options.manifest, { cause: error });
	}

	const parsed = manifestSchema.safeParse(manifestValue);

	if (!parsed.success) {
		throw new InvalidManifestError(options.manifest, { cause: parsed.error });
	}

	const permitted = permittedLabels(runners);
	const missing = [
		...new Set(
			parsed.data
				.map((target) => target.os)
				.filter((os) => !permitted.has(os.toLowerCase()))
		)
	];

	if (missing.length > 0) {
		return {
			check,
			status: 'failed',
			detail: `CUPBOARD_RUNNERS does not name ${missing.join(', ')}`
		};
	}

	return { check, status: 'ok' };
}

// The branch rule's root grant is a prefix; the caller's root-prefix must sit
// beneath it or every root write of a run is refused.
function checkRootPrefix(
	options: GithubCheckOptions,
	identity: RepositoryIdentity
): CheckFinding {
	const check = 'root prefix';

	if (options.rootPrefix === undefined) {
		return {
			check,
			status: 'unverified',
			detail: 'no --root-prefix given; pass the caller workflow’s value'
		};
	}

	const grant = `github:${identity.fullName}/${options.branch}/`;

	if (!`${options.rootPrefix}/`.startsWith(grant)) {
		return {
			check,
			status: 'failed',
			detail: `${options.rootPrefix} does not nest under the granted ${grant}`
		};
	}

	return { check, status: 'ok' };
}

// One authenticated client covers every variable read of a check run; the
// token is only required once a read actually happens.
function defaultReadVariable(
	repository: string
): (name: string) => Promise<string | undefined> {
	let client: VariablesClient | undefined;

	return (name) => {
		client ??= variablesClient(requireGithubToken());

		return client.read(repository, name);
	};
}

export async function runGithubCheck(
	url: string,
	options: GithubCheckOptions,
	reporter: Reporter,
	client: GithubCheckClient,
	dependencies: GithubCheckDependencies
): Promise<void> {
	const resolveRepository = dependencies.lookupRepository ?? lookupRepository;
	const readVariable =
		dependencies.readVariable ?? defaultReadVariable(options.repo);
	const readManifestFile =
		dependencies.readManifestFile ?? ((path: string) => readFile(path, 'utf8'));

	const identity = await reporter.phase('Resolving repository', () =>
		resolveRepository(options.repo)
	);
	const rules = await reporter.phase('Reading trust rules', async () => {
		const listed = await client.oidcTrust.list();

		return listed.rules
			.filter((rule) => !rule.disabled)
			.map((rule) => toMatcherRule(rule));
	});

	// The authority each run genuinely requests, against the placeholder
	// claims above: the PR run publishes to its pr-1 cache and roots under it,
	// the branch run to the default cache under the caller's root prefix.
	const pullRequestRoot = `github:${identity.fullName}/pr-1`;
	const branchRoot = `${options.rootPrefix ?? `github:${identity.fullName}/${options.branch}`}/target`;
	const defaultSelector = selectorForCache(DEFAULT_CACHE);
	const pullRequestRequests = [
		pushAuthorizationDetails({
			cacheSelector: 'pr-1',
			attest: true,
			root: `${pullRequestRoot}/target`
		}),
		rootEnsureAuthorizationDetails({
			cacheSelector: 'pr-1',
			root: `${pullRequestRoot}/target`
		}),
		confirmAuthorizationDetails({ cacheSelector: 'pr-1' })
	];
	const branchRequests = [
		pushAuthorizationDetails({
			cacheSelector: defaultSelector,
			attest: true,
			root: branchRoot
		}),
		rootEnsureAuthorizationDetails({
			cacheSelector: defaultSelector,
			root: branchRoot
		}),
		confirmAuthorizationDetails({ cacheSelector: defaultSelector })
	];

	const findings = await reporter.phase('Checking invariants', async () => [
		checkTrustRule(
			'pull-request trust rule',
			rules,
			pullRequestClaims(url, identity, options.workflowRef),
			pullRequestRequests
		),
		checkTrustRule(
			`${options.branch} trust rule`,
			rules,
			branchClaims(url, identity, options.branch, options.workflowRef),
			branchRequests
		),
		await checkGracePolicy(client),
		await checkReuseView(url, client, dependencies.fetchCacheInfo),
		await checkPlanRunner(readVariable),
		await checkRunnerLabels(options, readVariable, readManifestFile),
		checkRootPrefix(options, identity)
	]);

	const rows: ResultRow[] = findings.map((finding) => ({
		label: finding.check,
		value:
			finding.detail === undefined
				? finding.status
				: `${finding.status}: ${finding.detail}`
	}));

	reporter.result({ kind: 'github-check', data: { findings }, rows });

	const failed = findings.filter((finding) => finding.status === 'failed');
	const unverified = findings.filter(
		(finding) => finding.status === 'unverified'
	);

	if (failed.length > 0) {
		throw new GithubCheckFailedError(failed.map((finding) => finding.check));
	}

	if (unverified.length > 0) {
		throw new GithubCheckIncompleteError(
			unverified.map((finding) => finding.check)
		);
	}
}
