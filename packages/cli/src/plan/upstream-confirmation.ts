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
	LeftUpstreamCandidate,
	LeftUpstreamVerdict
} from './availability-partition.ts';
import {
	isReachableElsewhere,
	type SubstituterReach
} from './substituter-reach.ts';

/**
 * The store a confirmation asks, opened with settings that list only the
 * substituters a consumer elsewhere could also reach. Cupboard's own
 * destination cache and the tenant's reuse views are left out: they are
 * configured on the runner, but a path only they serve is the tenant's own
 * content, which is no reason to leave a target upstream. So are the
 * substituters that serve this runner alone, such as a directory on its disk or
 * a cache on its own network.
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
	/**
	The effective settings deciding whether Nix would substitute at all.
	*/
	readonly substitution: NixSubstitutionSettings;
	readonly store: PermittedSubstituterStore;
	/**
	 * Whether a consumer would accept a substituter's offer of a path, under the
	 * consumer's own signature policy. An offer a consumer would refuse proves
	 * nothing about availability.
	 */
	readonly accepts: AcceptsOffer;
	readonly closure?: SubstitutableClosureOptions;
}

/**
 * Builds the check a target must pass before it is finally classed as left
 * upstream: the daemon has to trust the connection carrying the confirmation's
 * settings, Nix has to be willing to substitute the target, and the permitted
 * substituters have to hold the whole closure this store recorded for it.
 *
 * The walk reads each path's narinfo from the substituter serving it and checks
 * that every path of that closure is offered under the NAR hash this store
 * holds and signed by a key the configuration trusts.
 */
export function confirmLeftUpstreamWith(
	options: UpstreamConfirmationOptions
): (candidate: LeftUpstreamCandidate) => Promise<LeftUpstreamVerdict> {
	// The trust answer is the same for every candidate this confirmation
	// checks, so the store is asked once and the answer reused.
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
	/**
	 * Which of the configured substituters a consumer elsewhere could also
	 * reach. {@link isReachableElsewhere} decides for a plan; a test injects
	 * its own so a fixture it controls can stand in for a public cache.
	 */
	readonly isReachable?: SubstituterReach;
}

/**
 * The overrides a confirmation's store is opened with.
 *
 * The substituter list is assigned outright, so the substituters the
 * confirmation queries are exactly the permitted ones: configured caches that
 * another consumer could reach, excluding this tenant's own cache. Positive
 * narinfo cache entries expire at once, so the daemon returns current results
 * from those substituters.
 *
 * A daemon honours these for a trusted client only, so
 * {@link confirmLeftUpstreamWith} checks the connection's trust before using
 * any result to decide a verdict.
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

// Every cupboard endpoint a runner is configured with hangs off the tenant
// Worker URL: the destination cache nests under it by name, and so does each
// reuse view. A substituter at or under that URL is one of cupboard's own.
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

// `always-allow-substitutes` overrides a derivation's own setting, so no
// derivation read is required. Plain store-path installables also have no
// derivation option to inspect.
async function derivationRefusal(
	candidate: LeftUpstreamCandidate,
	options: UpstreamConfirmationOptions
): Promise<LeftUpstreamVerdict | undefined> {
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
