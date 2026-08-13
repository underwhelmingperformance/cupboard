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
 * The store a confirmation asks, opened over settings whose substituter list
 * holds only the ones a consumer elsewhere could also reach. Cupboard's own
 * destination cache and the tenant's reuse views are not among them: they are
 * configured on the runner, and content only they hold is the tenant's, not
 * something a target can be left upstream on. Neither are the substituters
 * that serve the runner alone, such as a directory on its disk or a cache on
 * its own network.
 *
 * The store reports its own trust, because the settings a daemon connection
 * was opened with hold only for a client the daemon trusts.
 */
export type PermittedSubstituterStore = Pick<
	Nix,
	| 'resolveSubstitutableClosure'
	| 'canSubstituteDerivation'
	| 'honoursSubstituterSettings'
>;

export interface UpstreamConfirmationOptions {
	/** The effective settings deciding whether Nix would substitute at all. */
	readonly substitution: NixSubstitutionSettings;
	readonly store: PermittedSubstituterStore;
	/**
	 * Whether a consumer would take what a substituter offers, which decides
	 * whether the offer proves anything.
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
 * The walk reads each path's narinfo from the substituter serving it, so every
 * path of that closure is offered under the NAR hash this store holds and
 * signed by a key the configuration trusts.
 */
export function confirmLeftUpstreamWith(
	options: UpstreamConfirmationOptions
): (candidate: LeftUpstreamCandidate) => Promise<LeftUpstreamVerdict> {
	// Whichever store answers, it answers the same way for every candidate
	// this confirmation settles, so it is asked once.
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
 * confirmation asks are exactly the permitted ones: the configured caches a
 * consumer elsewhere could also reach, less this tenant's own. Positive
 * narinfo cache entries expire at once, so an answer a daemon gives about one
 * of them is the answer that substituter gives now.
 *
 * A daemon honours these for a trusted client only, so
 * {@link confirmLeftUpstreamWith} settles the connection's trust before any
 * answer over it decides a verdict.
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

// `always-allow-substitutes` overrules whatever a derivation asks for, so with
// it on there is nothing to read. An installable naming a plain store path
// carries no derivation option either: Nix substitutes such a path without
// consulting one.
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
