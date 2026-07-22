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

import { isAbortError } from '../../abort.ts';
import {
	confirmAuthorizationDetails,
	pushAuthorizationDetails,
	rootEnsureAuthorizationDetails
} from '../../auth/attenuate.ts';
import {
	GithubCheckFailedError,
	GithubCheckIncompleteError
} from '../../errors.ts';
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
	readonly readUser?: string;
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

	if (isRuleInteractive(matched)) {
		return {
			check,
			status: 'failed',
			detail: `interactive rule ${matched.id} matches this workflow; workflows must use a scoped CI rule`
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
		view = await fetchCacheInfo(
			new URL(reuseViewUrl(url.href, pullRequestViewName))
		);
	} catch (error) {
		if (isAbortError(error)) {
			throw error;
		}

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

	await reporter.phase('Verifying workflow reference', () =>
		verifyReference(workflowReference, lookupOptions)
	);

	const identity = await reporter.phase('Resolving repository', () =>
		resolveRepository(options.repo, lookupOptions)
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
