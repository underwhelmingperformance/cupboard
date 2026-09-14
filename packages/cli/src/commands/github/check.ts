import { type CacheInfo } from '@cupboard/nix-store/cache-info';
import { reuseViewUrl } from '@cupboard/nix-store/cache-url';
import {
	type CacheName,
	cacheNameSchema,
	type CacheScope
} from '@cupboard/nix-store/scalars';
import { type AuthorizationDetails } from '@cupboard/protocol/grants';
import { type OidcTrustSummary } from '@cupboard/protocol/oidc';
import { IssuerUrl } from '@cupboard/protocol/oidc-issuer';
import { selectModelledOidcTrust } from '@cupboard/protocol/oidc-trust-diagnostics';
import {
	claimMismatches,
	firstClaimMismatch,
	isClaimSatisfied,
	type OidcClaims,
	type OidcTrustRule
} from '@cupboard/protocol/oidc-trust-match';
import { type ReuseViewSelectorInput } from '@cupboard/protocol/reuse-views';
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
import {
	CheckFinding,
	GracePolicyMissingFinding,
	GracePolicyTooShortFinding,
	PassedCheckFinding,
	ReuseViewMissingFinding,
	ReuseViewPriorityInsufficientFinding,
	ReuseViewSelectorsMismatchFinding,
	ReuseViewStoreDirectoryMismatchFinding,
	ReuseViewUnreadableFinding,
	RootPrefixOutsideGrantFinding,
	RootPrefixUnspecifiedFinding
} from './finding.ts';
import {
	RepositoryTrustRuleMissingFinding,
	TrustRuleAudienceMismatchFinding,
	TrustRuleClaimMismatchFinding,
	TrustRuleIssuerMismatchFinding,
	trustSelectionFinding
} from './trust-selection.ts';
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
		list(): Promise<{ rules: OidcTrustSummary[] }>;
	};
}

export interface GithubCheckDependencies {
	readonly lookupRepository?: typeof lookupRepository;
	readonly fetchCacheInfo: (url: URL) => Promise<CacheInfo>;
	readonly verifyWorkflowReference?: typeof verifyWorkflowReference;
	readonly signal?: AbortSignal;
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

// Prefer a rule for the modelled trigger over a sibling rule for another
// event. Otherwise an event mismatch can hide the configuration mismatch that
// the operator needs to fix.
const triggerClaims = new Set(['event_name', 'ref', 'ref_type']);

// Diagnose only rules that already match the repository id. Among those rules,
// prefer the modelled trigger and then the fewest total mismatches. This follows
// the server's disclosure boundary while avoiding a sibling rule's event
// mismatch when a more relevant rule has configuration drift.
function unmatchedFinding(
	check: string,
	rules: readonly OidcTrustRule[],
	claims: OidcClaims
): CheckFinding {
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
		return new RepositoryTrustRuleMissingFinding(check);
	}

	const mismatch = firstClaimMismatch(candidate, claims);

	if (mismatch !== undefined) {
		return new TrustRuleClaimMismatchFinding(check, candidate, mismatch);
	}

	// All configured claims match, so matching failed because the issuer or
	// audience differs. claimMismatches compares neither value.
	const hasMatchingIssuer =
		typeof claims.iss === 'string' &&
		IssuerUrl.parse(claims.iss)?.value === candidate.issuer;

	if (!hasMatchingIssuer) {
		return new TrustRuleIssuerMismatchFinding(check, candidate, claims.iss);
	}

	return new TrustRuleAudienceMismatchFinding(check, candidate, claims.aud);
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
	for (const request of requests) {
		const selection = selectModelledOidcTrust(rules, claims, request);

		if (selection.outcome === 'identity-unmatched') {
			return unmatchedFinding(check, rules, claims);
		}

		const finding = trustSelectionFinding(check, request, selection);

		if (finding !== undefined) {
			return finding;
		}
	}

	return new PassedCheckFinding(check);
}

// Mirror the server's policy selection. The longest cache-name prefix wins,
// and the empty prefix supplies the tenant default.
function effectiveGraceSeconds(
	policies: readonly { cachePrefix: string; graceSeconds: number }[],
	cache: CacheScope
): number | undefined {
	if (cache.kind === 'default') {
		return policies.find((policy) => policy.cachePrefix.length === 0)
			?.graceSeconds;
	}

	return policies
		.filter((policy) => cache.name.startsWith(policy.cachePrefix))
		.toSorted(
			(left, right) => right.cachePrefix.length - left.cachePrefix.length
		)
		.at(0)?.graceSeconds;
}

function gracePolicyCaches(
	policies: readonly { cachePrefix: string }[]
): readonly CacheScope[] {
	const cacheNames = new Set<string>([`${pullRequestPrefix}1`]);
	const pullRequestNumberPattern = /^[1-9][0-9]*$/u;
	const firstDigits = '123456789';
	const laterDigits = '0123456789';

	for (const { cachePrefix } of policies) {
		const pullRequestNumber = cachePrefix.slice(pullRequestPrefix.length);

		if (
			cachePrefix.startsWith(pullRequestPrefix) &&
			pullRequestNumberPattern.test(pullRequestNumber)
		) {
			cacheNames.add(cachePrefix);
			cacheNames.add(`${cachePrefix}0`);

			let index = 0;
			for (const digit of pullRequestNumber) {
				const alternatives = index === 0 ? firstDigits : laterDigits;
				const prefix = pullRequestNumber.slice(0, index);

				for (const alternative of alternatives) {
					if (alternative !== digit) {
						cacheNames.add(`${pullRequestPrefix}${prefix}${alternative}`);
					}
				}

				index += 1;
			}
		}
	}

	return [
		{ kind: 'default' },
		...[...cacheNames].map((name) => ({
			kind: 'named' as const,
			name: cacheNameSchema.parse(name)
		}))
	];
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
		const label = cache.kind === 'default' ? 'default' : cache.name;

		if (graceSeconds === undefined) {
			return new GracePolicyMissingFinding(check, label);
		}

		if (graceSeconds < minimumGraceSeconds) {
			return new GracePolicyTooShortFinding(
				check,
				label,
				graceSeconds,
				minimumGraceSeconds
			);
		}
	}

	return new PassedCheckFinding(check);
}

function hasPullRequestViewSelectors(
	selectors: readonly ReuseViewSelectorInput[]
): boolean {
	return (
		selectors.length === 1 &&
		selectors[0]?.kind === 'prefix' &&
		selectors[0].prefix === pullRequestPrefix
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
		return new ReuseViewMissingFinding(check, pullRequestViewName);
	}

	if (!hasPullRequestViewSelectors(definition.selectors)) {
		return new ReuseViewSelectorsMismatchFinding(check, pullRequestPrefix);
	}

	const destination = await fetchCacheInfo(url);
	let view: CacheInfo;

	try {
		view = await fetchCacheInfo(reuseViewUrl(url, pullRequestViewName));
	} catch (error) {
		if (isAbortError(error)) {
			throw error;
		}

		return new ReuseViewUnreadableFinding(check, pullRequestViewName);
	}

	// Nix only uses a substituter for paths in its advertised store directory. A
	// view for another store therefore cannot provide paths for this destination.
	if (view.storeDirectory !== destination.storeDirectory) {
		return new ReuseViewStoreDirectoryMismatchFinding(
			check,
			view.storeDirectory,
			destination.storeDirectory
		);
	}

	if (view.priority <= destination.priority) {
		return new ReuseViewPriorityInsufficientFinding(
			check,
			view.priority,
			destination.priority
		);
	}

	return new PassedCheckFinding(check);
}

// The branch rule grants a root prefix. Every root that the caller writes must
// remain below that prefix.
function checkRootPrefix(
	options: GithubCheckOptions,
	identity: RepositoryIdentity
): CheckFinding {
	const check = 'root prefix';

	if (options.rootPrefix === undefined) {
		return new RootPrefixUnspecifiedFinding(check);
	}

	const grant = `github:${identity.fullName}/${options.branch}/`;

	if (!`${options.rootPrefix}/`.startsWith(grant)) {
		return new RootPrefixOutsideGrantFinding(check, options.rootPrefix, grant);
	}

	return new PassedCheckFinding(check);
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
	const pullRequestCache: CacheName = cacheNameSchema.parse('pr-1');
	const pullRequestCacheScope: CacheScope = {
		kind: 'named',
		name: pullRequestCache
	};
	const branchCacheScope: CacheScope = { kind: 'default' };
	const pullRequestRequests = [
		pushAuthorizationDetails({
			cache: pullRequestCacheScope,
			attest: true,
			root: pullRequestRoot,
			runRoot: pullRequestRunRoot
		}),
		rootListAuthorizationDetails({
			cache: pullRequestCacheScope,
			root: pullRequestRoot
		}),
		rootEnsureAuthorizationDetails({
			cache: pullRequestCacheScope,
			root: pullRequestRoot
		}),
		confirmAuthorizationDetails({ cache: pullRequestCacheScope })
	];
	const branchRequests = [
		pushAuthorizationDetails({
			cache: branchCacheScope,
			attest: true,
			root: branchRoot,
			runRoot: branchRunRoot
		}),
		rootListAuthorizationDetails({
			cache: branchCacheScope,
			root: branchRoot
		}),
		rootEnsureAuthorizationDetails({
			cache: branchCacheScope,
			root: branchRoot
		}),
		confirmAuthorizationDetails({ cache: branchCacheScope })
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
		value: finding.render()
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
