import type {
	AcceptsOffer,
	Nix,
	NixDaemonOverrides,
	NixSubstitutionSettings,
	SubstitutableClosureOptions,
	SubstituterSettingsOutcome
} from '@cupboard/nix';
import { derivationPathOf } from '@cupboard/nix-store/derivation';

import type {
	UpstreamAvailabilityCandidate,
	UpstreamAvailabilityVerdict
} from './availability-partition.ts';
import {
	isReachableElsewhere,
	type SubstituterReach
} from './substituter-reach.ts';

/**
 * A confirmation store configured with only the substituters available to an
 * external consumer. It excludes Cupboard's destination cache and the tenant's
 * reuse views because they contain tenant-owned content that the workflow
 * should publish or retain. It also excludes runner-local and private-network
 * substituters.
 *
 * The store also reports whether the daemon trusts the connection, because a
 * daemon applies a client's settings only for a client it trusts.
 */
export type PermittedSubstituterStore = Pick<
	Nix,
	| 'resolveSubstitutableClosure'
	| 'canSubstituteDerivation'
	| 'honoursSubstituterSettings'
>;

export interface UpstreamConfirmationOptions {
	readonly substitution: NixSubstitutionSettings;
	readonly store: PermittedSubstituterStore;
	/**
	 * Whether the consumer's signature policy accepts a substituter's offer. A
	 * rejected offer does not establish availability.
	 */
	readonly accepts: AcceptsOffer;
	readonly closure?: SubstitutableClosureOptions;
}

/**
 * Creates the confirmation required before excluding a target from publication
 * because an upstream substituter serves it. Confirmation requires a trusted
 * connection, substitution eligibility, and a complete matching closure from
 * permitted substituters. It reads each narinfo, verifies that its NAR hash
 * matches the local store, and checks that the signature policy accepts it.
 */
export function confirmUpstreamAvailabilityWith(
	options: UpstreamConfirmationOptions
): (
	candidate: UpstreamAvailabilityCandidate
) => Promise<UpstreamAvailabilityVerdict> {
	// The daemon grants trust to the connection, not to individual paths. Query
	// it once and apply the result to every candidate checked through this store.
	let honoured: Promise<SubstituterSettingsOutcome> | undefined;

	return async (candidate) => {
		if (!options.substitution.substitute) {
			return { kind: 'substitution-disabled' };
		}

		honoured ??= options.store.honoursSubstituterSettings();

		const settings = await honoured;

		if (!settings.isHonoured) {
			return { kind: 'connection-not-trusted', trust: settings.trust };
		}

		const ineligible = await derivationRefusal(candidate, options);

		if (ineligible !== undefined) {
			return ineligible;
		}

		const closure = await options.store.resolveSubstitutableClosure(
			candidate.storePath,
			{ ...options.closure, accepts: options.accepts }
		);

		if (closure.kind === 'not-served') {
			return { kind: 'closure-not-served', missing: closure.storePath };
		}

		if (closure.kind === 'not-held-locally') {
			return { kind: 'closure-not-held-locally', missing: closure.storePath };
		}

		if (closure.kind === 'divergent') {
			return {
				kind: 'closure-divergent',
				storePath: closure.storePath,
				held: closure.held,
				offered: closure.offered
			};
		}

		if (closure.kind === 'refused') {
			return { kind: 'closure-unsigned', storePath: closure.storePath };
		}

		if (closure.kind === 'over-cap') {
			return { kind: 'closure-over-cap', maxPaths: closure.maxPaths };
		}

		return { kind: 'confirmed' };
	};
}

export interface UpstreamConfirmationOverrideOptions {
	readonly isReachable?: SubstituterReach;
}

/**
 * The override replaces the substituter list with externally usable configured
 * caches, excluding this tenant's endpoints. A zero positive narinfo TTL makes
 * each confirmation request current metadata from those caches.
 *
 * A daemon honours these for a trusted client only, so
 * {@link confirmUpstreamAvailabilityWith} checks the connection's trust before
 * using any result to decide a verdict.
 */
export function upstreamConfirmationOverrides(
	substitution: NixSubstitutionSettings,
	tenantUrl: URL,
	options: UpstreamConfirmationOverrideOptions = {}
): NixDaemonOverrides {
	const isReachable = options.isReachable ?? isReachableElsewhere;
	const permitted = substitution.substituters.filter(
		(substituter) =>
			isReachable(substituter) && !isTenantEndpoint(substituter, tenantUrl)
	);

	return {
		substituters: permitted.join(' '),
		'narinfo-cache-positive-ttl': '0'
	};
}

// The destination cache and every reuse view use paths beneath the tenant
// Worker URL. Exclude the tenant URL itself and every descendant path.
function isTenantEndpoint(substituter: string, tenantUrl: URL): boolean {
	const parsed = URL.parse(substituter);

	if (parsed?.origin !== tenantUrl.origin) {
		return false;
	}

	const base = tenantUrl.pathname.endsWith('/')
		? tenantUrl.pathname
		: `${tenantUrl.pathname}/`;

	return (
		parsed.pathname === tenantUrl.pathname || parsed.pathname.startsWith(base)
	);
}

// `always-allow-substitutes` overrides the derivation policy, so no derivation
// read is required. A plain store-path installable has no derivation policy.
async function derivationRefusal(
	candidate: UpstreamAvailabilityCandidate,
	options: UpstreamConfirmationOptions
): Promise<UpstreamAvailabilityVerdict | undefined> {
	if (options.substitution.alwaysAllowSubstitutes) {
		return undefined;
	}

	const drvPath = derivationPathOf(candidate.installable);

	if (drvPath === undefined) {
		return undefined;
	}

	try {
		if (await options.store.canSubstituteDerivation(drvPath)) {
			return undefined;
		}
	} catch (error) {
		return {
			kind: 'derivation-unreadable',
			errorName: error instanceof Error ? error.name : 'unknown'
		};
	}

	return { kind: 'substitutes-not-allowed' };
}
