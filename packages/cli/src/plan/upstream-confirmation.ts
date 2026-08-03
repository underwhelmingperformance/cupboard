import type {
	Nix,
	NixDaemonOverrides,
	NixDerivedPathString,
	NixSubstitutionSettings,
	SubstitutableClosureOptions
} from '@cupboard/nix';
import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';

import type {
	LeftUpstreamCandidate,
	LeftUpstreamVerdict
} from './availability-partition.ts';

/**
 * The store a confirmation asks, opened over a connection whose substituter
 * list holds only the ones a consumer elsewhere could also reach. Cupboard's
 * own destination cache and the tenant's reuse views are not among them: they
 * are configured on the runner, and content only they hold is the tenant's,
 * not something a target can be left upstream on.
 */
export type PermittedSubstituterStore = Pick<
	Nix,
	'resolveSubstitutableClosure' | 'canSubstituteDerivation'
>;

export interface UpstreamConfirmationOptions {
	/** The effective settings deciding whether Nix would substitute at all. */
	readonly substitution: NixSubstitutionSettings;
	readonly store: PermittedSubstituterStore;
	readonly closure?: SubstitutableClosureOptions;
}

/**
 * Builds the check a target must pass before it is finally classed as left
 * upstream: Nix has to be willing to substitute it, and the permitted
 * substituters have to hold its whole closure, proven by walking it.
 *
 * What a `confirmed` verdict does not cover is signature acceptance. Whether
 * the daemon's `trusted-public-keys` policy would accept the paths a
 * substituter offers is decided by the daemon at substitution time, and
 * nothing here validates it.
 */
export function confirmLeftUpstreamWith(
	options: UpstreamConfirmationOptions
): (candidate: LeftUpstreamCandidate) => Promise<LeftUpstreamVerdict> {
	return async (candidate) => {
		if (!options.substitution.substitute) {
			return { kind: 'substitution-disabled' };
		}

		const ineligible = await derivationRefusal(candidate, options);

		if (ineligible !== undefined) {
			return ineligible;
		}

		const closure = await options.store.resolveSubstitutableClosure(
			candidate.storePath,
			options.closure ?? {}
		);

		if (closure.kind === 'not-served') {
			return { kind: 'closure-not-served', missing: closure.storePath };
		}

		if (closure.kind === 'over-cap') {
			return { kind: 'closure-over-cap', maxPaths: closure.maxPaths };
		}

		return { kind: 'confirmed' };
	};
}

/**
 * The daemon overrides that leave a connection with only the permitted
 * substituters. The list is assigned outright, and the append that produced
 * the runner's own entries is cleared, so what the connection ends up with is
 * exactly this list.
 *
 * An untrusted client's assignment is narrowed by the daemon to the
 * substituters it already trusts, which can only shrink the list further. A
 * confirmation over such a connection may therefore refuse a target the
 * permitted substituters do hold, and never accepts one they do not.
 */
export function permittedSubstituterOverrides(
	substitution: NixSubstitutionSettings,
	tenantUrl: URL
): NixDaemonOverrides {
	const permitted = substitution.substituters.filter(
		(substituter) => !isTenantEndpoint(substituter, tenantUrl)
	);

	return { substituters: permitted.join(' '), 'extra-substituters': '' };
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

const derivationSuffix = '.drv';

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

	const drvPath = derivationOf(candidate.installable);

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

function derivationOf(
	installable: NixDerivedPathString
): StorePathString | undefined {
	const separator = installable.indexOf('^');
	const base = separator === -1 ? installable : installable.slice(0, separator);
	const parsed = storePathSchema.safeParse(base);

	if (!parsed.success || !parsed.data.endsWith(derivationSuffix)) {
		return undefined;
	}

	return parsed.data;
}
