import { type CacheInfo } from '@cupboard/nix-store/cache-info';
import { reuseViewUrl } from '@cupboard/nix-store/cache-url';
import {
	type CacheName,
	cacheNameSchema,
	type CacheScope
} from '@cupboard/nix-store/scalars';
import { type AuthorizationDetails } from '@cupboard/protocol/grants';
import { type ManagedPolicySummary } from '@cupboard/protocol/managed-caches';
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
	managedCacheProvisionAuthorizationDetails,
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
import { type ReuseViewClient } from '../reuse-view.ts';

import { githubBranchClaims, githubPullRequestClaims } from './claims.ts';
import {
	parseExactWorkflowReference,
	pullRequestViewName
} from './convention.ts';
import {
	CheckFinding,
	ManagedPolicyMissingFinding,
	ManagedPolicyStatusFinding,
	PassedCheckFinding,
	ReuseViewAccessMismatchFinding,
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
	readonly destinationReadUser?: ReadUser;
	readonly destinationReadPassword?: string;
	readonly fallbackReadUser?: ReadUser;
	readonly fallbackReadPassword?: string;
}

export interface GithubCheckClient {
	readonly reuseViews: Pick<ReuseViewClient, 'list'>;
	readonly oidcTrust: {
		list(): Promise<{ rules: OidcTrustSummary[] }>;
	};
	readonly managedCaches: {
		readonly policies: {
			list(): Promise<{ policies: ManagedPolicySummary[] }>;
		};
	};
}

export interface GithubCheckDependencies {
	readonly lookupRepository?: typeof lookupRepository;
	readonly fetchDestinationCacheInfo: (url: URL) => Promise<CacheInfo>;
	readonly fetchReuseViewCacheInfo: (url: URL) => Promise<CacheInfo>;
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

function hasPullRequestViewSelectors(
	selectors: readonly ReuseViewSelectorInput[],
	policy: ManagedPolicySummary
): boolean {
	return (
		selectors.length === 1 &&
		selectors[0]?.kind === 'managed-group' &&
		selectors[0].groupId === policy.configuration.groupId
	);
}

async function checkReuseView(
	url: URL,
	policy: ManagedPolicySummary,
	client: GithubCheckClient,
	fetchDestinationCacheInfo: (url: URL) => Promise<CacheInfo>,
	fetchReuseViewCacheInfo: (url: URL) => Promise<CacheInfo>
): Promise<CheckFinding> {
	const check = 'reuse view';
	const { views } = await client.reuseViews.list();
	const definition = views.find((view) => view.name === pullRequestViewName);

	if (definition === undefined) {
		return new ReuseViewMissingFinding(check, pullRequestViewName);
	}

	if (definition.access !== policy.configuration.access) {
		return new ReuseViewAccessMismatchFinding(
			check,
			definition.access,
			policy.configuration.access
		);
	}

	if (!hasPullRequestViewSelectors(definition.selectors, policy)) {
		return new ReuseViewSelectorsMismatchFinding(
			check,
			`managed-group:${policy.configuration.groupId}`
		);
	}

	const destination = await fetchDestinationCacheInfo(url);
	let view: CacheInfo;

	try {
		view = await fetchReuseViewCacheInfo(
			reuseViewUrl(url, pullRequestViewName)
		);
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
	const policies = await reporter.phase('Reading managed-cache policies', () =>
		client.managedCaches.policies.list()
	);
	const repositoryId = String(identity.repositoryId);
	const managedPolicy = policies.policies.find(
		(policy) => policy.repositoryId === repositoryId
	);
	const rules = await reporter.phase('Reading trust rules', async () => {
		const listed = await client.oidcTrust.list();

		return listed.rules
			.filter((rule) => !rule.disabled)
			.map((rule) => toMatcherRule(rule));
	});

	// These representative requests use the quickstart defaults. They cover a PR
	// publication to the first policy-derived cache and a branch publication to
	// the default cache, but
	// they are not evidence of the arguments that a real workflow will use.
	const pullRequestCacheName =
		managedPolicy === undefined
			? `gh-${repositoryId}-pr-1`
			: `${managedPolicy.cacheNamespace}1`;
	const pullRequestRootPrefix = `github:${identity.fullName}/${pullRequestCacheName}`;
	const branchRootPrefix =
		options.rootPrefix ?? `github:${identity.fullName}/${options.branch}`;
	const pullRequestRoot = parseRootName(`${pullRequestRootPrefix}/target`);
	const pullRequestRunRoot = parseRootName(
		`${pullRequestRootPrefix}/_cupboard-run/1`
	);
	const branchRoot = parseRootName(`${branchRootPrefix}/target`);
	const branchRunRoot = parseRootName(`${branchRootPrefix}/_cupboard-run/1`);
	const pullRequestCache: CacheName =
		cacheNameSchema.parse(pullRequestCacheName);
	const pullRequestCacheScope: CacheScope = {
		kind: 'named',
		name: pullRequestCache
	};
	const branchCacheScope: CacheScope = { kind: 'default' };
	const pullRequestRequests = [
		managedCacheProvisionAuthorizationDetails({
			cache: pullRequestCacheScope
		}),
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
			managedPolicy === undefined
				? new ManagedPolicyMissingFinding('managed-cache policy', repositoryId)
				: managedPolicy.status === 'active'
					? new PassedCheckFinding('managed-cache policy')
					: new ManagedPolicyStatusFinding(
							'managed-cache policy',
							managedPolicy.status
						),
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
			...(managedPolicy === undefined
				? []
				: [
						await checkReuseView(
							url,
							managedPolicy,
							client,
							dependencies.fetchDestinationCacheInfo,
							dependencies.fetchReuseViewCacheInfo
						)
					]),
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
