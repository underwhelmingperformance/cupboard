import {
	type AuthorizationDetail,
	type AuthorizationDetails
} from '@cupboard/protocol/grants';
import {
	type ClaimMismatch,
	isRuleInteractive,
	type OidcTrustRule
} from '@cupboard/protocol/oidc-trust-match';
import { type OidcTrustSelection } from '@cupboard/protocol/oidc-trust-selection';

import { type CheckFinding, FailedCheckFinding } from './finding.ts';

function describeAuthorizationDetail(detail: AuthorizationDetail): string {
	if (detail.type !== 'cupboard_cache') {
		return detail.type;
	}

	const root = detail.root === undefined ? '' : ` with root ${detail.root}`;

	return `${detail.actions.join(', ')} on cache ${detail.cache}${root}`;
}

export class RepositoryTrustRuleMissingFinding extends FailedCheckFinding {
	detail(): string {
		return 'no rule pins this repository';
	}
}

export class TrustRuleIssuerMismatchFinding extends FailedCheckFinding {
	constructor(
		check: string,
		public readonly rule: OidcTrustRule,
		public readonly presentedIssuer: unknown
	) {
		super(check);
	}

	detail(): string {
		return `rule ${this.rule.id} expects issuer ${this.rule.issuer}; the modelled run uses ${String(this.presentedIssuer)}`;
	}
}

export class TrustRuleAudienceMismatchFinding extends FailedCheckFinding {
	constructor(
		check: string,
		public readonly rule: OidcTrustRule,
		public readonly presentedAudience: unknown
	) {
		super(check);
	}

	detail(): string {
		return `rule ${this.rule.id} expects audience ${this.rule.audience}; the modelled run uses ${String(this.presentedAudience)}`;
	}
}

export class TrustRuleClaimMismatchFinding extends FailedCheckFinding {
	constructor(
		check: string,
		public readonly rule: OidcTrustRule,
		public readonly mismatch: ClaimMismatch
	) {
		super(check);
	}

	detail(): string {
		const presented =
			this.mismatch.presented === undefined
				? 'the modelled run has no value for this claim'
				: `the modelled run uses ${this.mismatch.presented}`;

		return `rule ${this.rule.id} expects ${this.mismatch.claim} to match ${this.mismatch.expected}; ${presented}`;
	}
}

export class AmbiguousTrustRulesFinding extends FailedCheckFinding {
	constructor(
		check: string,
		public readonly rules: readonly OidcTrustRule[],
		public readonly request: AuthorizationDetails
	) {
		super(check);
	}

	detail(): string {
		const ids = this.rules.map(({ id }) => id).join(', ');
		const authority = this.request
			.map((detail) => describeAuthorizationDetail(detail))
			.join('; ');

		return `rules ${ids} match the modelled claims and permit ${authority}; make their grants disjoint or disable one rule`;
	}
}

export class SplitTrustAuthorityFinding extends FailedCheckFinding {
	constructor(
		check: string,
		public readonly rules: readonly OidcTrustRule[]
	) {
		super(check);
	}

	detail(): string {
		const ids = this.rules.map(({ id }) => id).join(', ');

		return `rules ${ids} match the modelled claims, but no single rule permits the complete request; grant the request to one rule instead of splitting it across rules`;
	}
}

export class TrustRuleGrantMissingFinding extends FailedCheckFinding {
	constructor(
		check: string,
		public readonly rules: readonly [OidcTrustRule, ...OidcTrustRule[]],
		public readonly refused: AuthorizationDetail
	) {
		super(check);
	}

	detail(): string {
		const [rule, ...rest] = this.rules;
		const grant = describeAuthorizationDetail(this.refused);

		if (rest.length === 0) {
			return `rule ${rule.id} matches the modelled claims but does not permit ${grant}; remove it and re-run setup`;
		}

		const ids = this.rules.map(({ id }) => id).join(', ');

		return `rules ${ids} match the modelled claims but none permits ${grant}; add the grant to one rule`;
	}
}

export class InteractiveTrustRuleFinding extends FailedCheckFinding {
	constructor(
		check: string,
		public readonly rule: OidcTrustRule
	) {
		super(check);
	}

	detail(): string {
		return `interactive rule ${this.rule.id} matches the modelled claims; workflows must use a scoped CI rule`;
	}
}

export function trustSelectionFinding(
	check: string,
	request: AuthorizationDetails,
	selection: Exclude<
		OidcTrustSelection,
		{ readonly outcome: 'identity-unmatched' }
	>
): CheckFinding | undefined {
	if (selection.outcome === 'ambiguous') {
		return new AmbiguousTrustRulesFinding(check, selection.rules, request);
	}

	if (selection.outcome === 'authority-unmatched') {
		const [refused] = selection.uncovered;

		if (refused === undefined) {
			return new SplitTrustAuthorityFinding(check, selection.rules);
		}

		return new TrustRuleGrantMissingFinding(check, selection.rules, refused);
	}

	if (isRuleInteractive(selection.rule)) {
		return new InteractiveTrustRuleFinding(check, selection.rule);
	}

	return undefined;
}
