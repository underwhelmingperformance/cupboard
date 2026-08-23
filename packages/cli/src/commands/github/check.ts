import { type CacheInfo } from '@cupboard/nix-store/cache-info';
import { reuseViewUrl } from '@cupboard/nix-store/cache-url';
import { DEFAULT_CACHE, selectorForCache } from '@cupboard/nix-store/scalars';
import { isGrantPermittedByRule } from '@cupboard/protocol/grant-match';
import {
	type AuthorizationDetail,
	type AuthorizationDetails
} from '@cupboard/protocol/grants';
import { type ParsedOidcTrustSummary } from '@cupboard/protocol/oidc';
import {
	claimMismatches,
	firstClaimMismatch,
	isClaimSatisfied,
	isRuleInteractive,
	matchOidcTrust,
	type OidcClaims,
	type OidcTrustRule
} from '@cupboard/protocol/oidc-trust-match';
import { type ReuseViewSelector } from '@cupboard/protocol/reuse-views';
import { type Reporter, type ResultRow } from '@cupboard/reporter';
import { type ReadUser } from '@cupboard/shared/http';

import { isAbortError } from '../../abort.ts';
import {
	confirmAuthorizationDetails,
	pushAuthorizationDetails,
	rootEnsureAuthorizationDetails,
	rootListAuthorizationDetails
} from '../../auth/attenuate.ts';
import {
	GithubCheckFailedError,
	GithubCheckIncompleteError
} from '../../errors.ts';
import { parseRootName } from '../../root-name.ts';
import {
	lookupRepository,
	type RepositoryIdentity
} from '../oidc-trust/github.ts';
import { type PolicyClient } from '../policy.ts';
import { type ReuseViewClient } from '../reuse-view.ts';

import { githubBranchClaims, githubPullRequestClaims } from './claims.ts';
import {
	minimumGraceSeconds,
	parseExactWorkflowReference,
	pullRequestPrefix,
	pullRequestViewName
} from './convention.ts';
import { verifyWorkflowReference } from './workflow-reference.ts';

export interface GithubCheckOptions {
	readonly repo: string;
	readonly branch: string;
	readonly workflowRef: string;
	readonly rootPrefix?: string;
	readonly readUser?: ReadUser;
	readonly readPassword?: string;
}

export interface GithubCheckClient {
	readonly policies: Pick<PolicyClient, 'graceList'>;
	readonly reuseViews: Pick<ReuseViewClient, 'list'>;
	readonly oidcTrust: {
		list(): Promise<{ rules: ParsedOidcTrustSummary[] }>;
	};
}

export interface GithubCheckDependencies {
	readonly lookupRepository?: typeof lookupRepository;
	readonly fetchCacheInfo: (url: URL) => Promise<CacheInfo>;
	readonly verifyWorkflowReference?: typeof verifyWorkflowReference;
	readonly signal?: AbortSignal;
}

export interface CheckFinding {
	readonly check: string;
	readonly status: 'ok' | 'failed' | 'unverified';
	readonly detail?: string;
}

function toMatcherRule(summary: ParsedOidcTrustSummary): OidcTrustRule {
	return {
		id: summary.id,
		issuer: summary.issuer,
		audience: summary.audience,
		claims: summary.claims,
		permittedGrants: summary.permittedGrants
	};
}

// Prefer a rule for the modelled trigger over a sibling rule for another
// event. Otherwise an event mismatch can hide the configuration mismatch that
// the operator needs to fix.
const triggerClaims = new Set(['event_name', 'ref', 'ref_type']);

// Diagnose only rules that already match the repository id. Among those rules,
// prefer the modelled trigger and then the fewest total mismatches. This follows
// the server's disclosure boundary while avoiding a sibling rule's event
// mismatch when a more relevant rule has configuration drift.
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
		return `rule ${candidate.id} expects audience ${candidate.audience}; the modelled run uses ${String(claims.aud)}`;
	}

	const presented =
		mismatch.presented === undefined
			? 'the modelled run has no value for this claim'
			: `the modelled run uses ${mismatch.presented}`;

	return `rule ${candidate.id} expects ${mismatch.claim} to match ${mismatch.expected}; ${presented}`;
}

function describeAuthorizationDetail(detail: AuthorizationDetail): string {
	if (detail.type !== 'cupboard_cache') {
		return detail.type;
	}

	const root = detail.root === undefined ? '' : ` with root ${detail.root}`;

	return `${detail.actions.join(', ')} on cache ${detail.cache}${root}`;
}

// Matching claims do not grant authority by themselves. Model the quickstart's
// requests with the same authorization helpers as the commands, then check each
// request against the stored grants. This does not inspect a caller's flags.
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

	if (isRuleInteractive(matched)) {
		return {
			check,
			status: 'failed',
			detail: `interactive rule ${matched.id} matches the modelled claims; workflows must use a scoped CI rule`
		};
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
				detail: `rule ${matched.id} matches the modelled claims but does not permit ${describeAuthorizationDetail(refused)}; remove it and re-run setup`
			};
		}
	}

	return { check, status: 'ok' };
}

// Mirror the server's policy selection. The longest cache-name prefix wins,
// and the empty prefix supplies the tenant default.
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
	const firstDigits = '123456789';
	const laterDigits = '0123456789';

	for (const { cachePrefix } of policies) {
		const pullRequestNumber = cachePrefix.slice(pullRequestPrefix.length);

		if (
			cachePrefix.startsWith(pullRequestPrefix) &&
			pullRequestNumberPattern.test(pullRequestNumber)
		) {
			caches.add(cachePrefix);
			caches.add(`${cachePrefix}0`);

			let index = 0;
			for (const digit of pullRequestNumber) {
				const alternatives = index === 0 ? firstDigits : laterDigits;
				const prefix = pullRequestNumber.slice(0, index);

				for (const alternative of alternatives) {
					if (alternative !== digit) {
						caches.add(`${pullRequestPrefix}${prefix}${alternative}`);
					}
				}

				index += 1;
			}
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
				detail: `no grace policy covers the ${cacheLabel} cache; a push with require-grace would fail because no policy would retain its paths`
			};
		}

		if (graceSeconds < minimumGraceSeconds) {
			return {
				check,
				status: 'failed',
				detail: `the ${cacheLabel} cache has ${String(graceSeconds)}s of grace; GitHub publication requires at least ${String(minimumGraceSeconds)}s`
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
	url: URL,
	client: GithubCheckClient,
	fetchCacheInfo: (url: URL) => Promise<CacheInfo>
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
		view = await fetchCacheInfo(reuseViewUrl(url, pullRequestViewName));
	} catch (error) {
		if (isAbortError(error)) {
			throw error;
		}

		return {
			check,
			status: 'failed',
			detail: `could not read nix-cache-info from the ${pullRequestViewName} view`
		};
	}

	// Nix only uses a substituter for paths in its advertised store directory. A
	// view for another store therefore cannot provide paths for this destination.
	if (view.storeDirectory !== destination.storeDirectory) {
		return {
			check,
			status: 'failed',
			detail: `view advertises store directory ${view.storeDirectory}; the destination advertises ${destination.storeDirectory}`
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

// The branch rule grants a root prefix. Every root that the caller writes must
// remain below that prefix.
function checkRootPrefix(
	options: GithubCheckOptions,
	identity: RepositoryIdentity
): CheckFinding {
	const check = 'root prefix';

	if (options.rootPrefix === undefined) {
		return {
			check,
			status: 'unverified',
			detail:
				"no --root-prefix given; pass the value from the caller's workflow"
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

export async function runGithubCheck(
	url: URL,
	options: GithubCheckOptions,
	reporter: Reporter,
	client: GithubCheckClient,
	dependencies: GithubCheckDependencies
): Promise<void> {
	const resolveRepository = dependencies.lookupRepository ?? lookupRepository;
	const verifyReference =
		dependencies.verifyWorkflowReference ?? verifyWorkflowReference;
	const lookupOptions =
		dependencies.signal === undefined ? {} : { signal: dependencies.signal };
	const workflowReference = parseExactWorkflowReference(options.workflowRef);

	await reporter.phase('Checking workflow reference on GitHub', () =>
		verifyReference(workflowReference, lookupOptions)
	);

	const identity = await reporter.phase(
		'Reading repository identity from GitHub',
		() => resolveRepository(options.repo, lookupOptions)
	);
	const rules = await reporter.phase('Reading trust rules', async () => {
		const listed = await client.oidcTrust.list();

		return listed.rules
			.filter((rule) => !rule.disabled)
			.map((rule) => toMatcherRule(rule));
	});

	// These representative requests use the quickstart defaults. They cover a PR
	// publication to `pr-1` and a branch publication to the default cache, but
	// they are not evidence of the arguments that a real workflow will use.
	const pullRequestRootPrefix = `github:${identity.fullName}/pr-1`;
	const branchRootPrefix =
		options.rootPrefix ?? `github:${identity.fullName}/${options.branch}`;
	const pullRequestRoot = parseRootName(`${pullRequestRootPrefix}/target`);
	const pullRequestRunRoot = parseRootName(
		`${pullRequestRootPrefix}/_cupboard-run/1`
	);
	const branchRoot = parseRootName(`${branchRootPrefix}/target`);
	const branchRunRoot = parseRootName(`${branchRootPrefix}/_cupboard-run/1`);
	const defaultSelector = selectorForCache(DEFAULT_CACHE);
	const pullRequestRequests = [
		pushAuthorizationDetails({
			cacheSelector: 'pr-1',
			attest: true,
			root: pullRequestRoot,
			runRoot: pullRequestRunRoot
		}),
		rootListAuthorizationDetails({
			cacheSelector: 'pr-1',
			root: pullRequestRoot
		}),
		rootEnsureAuthorizationDetails({
			cacheSelector: 'pr-1',
			root: pullRequestRoot
		}),
		confirmAuthorizationDetails({ cacheSelector: 'pr-1' })
	];
	const branchRequests = [
		pushAuthorizationDetails({
			cacheSelector: defaultSelector,
			attest: true,
			root: branchRoot,
			runRoot: branchRunRoot
		}),
		rootListAuthorizationDetails({
			cacheSelector: defaultSelector,
			root: branchRoot
		}),
		rootEnsureAuthorizationDetails({
			cacheSelector: defaultSelector,
			root: branchRoot
		}),
		confirmAuthorizationDetails({ cacheSelector: defaultSelector })
	];

	const findings = await reporter.phase(
		'Checking tenant configuration',
		async () => [
			checkTrustRule(
				'pull-request trust rule',
				rules,
				githubPullRequestClaims(url, identity, {
					pullRequestNumber: 1,
					workflowReference: workflowReference.reference
				}),
				pullRequestRequests
			),
			checkTrustRule(
				`${options.branch} trust rule`,
				rules,
				githubBranchClaims(url, identity, {
					branch: options.branch,
					eventName: 'push',
					workflowReference: workflowReference.reference
				}),
				branchRequests
			),
			await checkGracePolicy(client),
			await checkReuseView(url, client, dependencies.fetchCacheInfo),
			checkRootPrefix(options, identity)
		]
	);

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
