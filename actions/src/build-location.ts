/**
 * Where a cohort job realises its targets. A job with a remote store builds
 * there. Otherwise, a cohort that sets `remote` builds on the remote builders
 * from the `builders` setting, and any other cohort builds on its runner.
 */
export type BuildLocation =
	| { readonly kind: 'runner'; readonly runner: string }
	| { readonly kind: 'builders'; readonly hosts: readonly string[] }
	| { readonly kind: 'store'; readonly host: string };

export interface BuildLocationCohort {
	readonly system: string;
	readonly os: string;
	readonly remote: boolean;
}

export interface BuildLocationSettings {
	/**
	The `ssh-ng://` URI of the remote store, or empty for none.
	*/
	readonly store: string;
	/**
	The Nix `builders` specification, or empty for none.
	*/
	readonly builders: string;
}

export function cohortBuildLocation(
	cohort: BuildLocationCohort,
	settings: BuildLocationSettings
): BuildLocation {
	if (settings.store !== '') {
		return { kind: 'store', host: uriHost(settings.store) ?? 'remote store' };
	}

	if (!cohort.remote) {
		return { kind: 'runner', runner: cohort.os };
	}

	return {
		kind: 'builders',
		hosts: builderHosts(settings.builders, cohort.system)
	};
}

/**
 * The text for a plan's builder column: `local` for a build on the runner, and
 * otherwise the remote host.
 */
export function builderDescription(location: BuildLocation): string {
	return location.kind === 'runner' ? 'local' : remoteDescription(location);
}

export interface JobNameCohort {
	readonly system: string;
	readonly targets: readonly { readonly rootSuffix: string }[];
}

/**
 * A short display name for a cohort job. A cohort with one target uses the
 * target's root suffix, which is unique in the manifest, such as
 * `aarch64-linux/hello on eu.nixbuild.net`. A larger cohort uses its system
 * and target count, such as `x86_64-linux on eu.nixbuild.net (8 targets)`. The
 * place is the runner label for a build on the runner, and the remote host
 * otherwise.
 */
export function cohortJobName(
	cohort: JobNameCohort,
	location: BuildLocation
): string {
	const place =
		location.kind === 'runner' ? location.runner : remoteDescription(location);
	const [only, ...others] = cohort.targets;

	if (only !== undefined && others.length === 0) {
		return `${only.rootSuffix} on ${place}`;
	}

	return `${cohort.system} on ${place} (${String(cohort.targets.length)} targets)`;
}

function remoteDescription(
	location: Exclude<BuildLocation, { readonly kind: 'runner' }>
): string {
	if (location.kind === 'store') {
		return location.host;
	}

	const [first, ...others] = location.hosts;

	if (first === undefined) {
		return 'remote builders';
	}

	return others.length === 0
		? first
		: `${first} and ${String(others.length)} more`;
}

interface BuilderEntry {
	readonly host: string;
	readonly systems: readonly string[] | 'any';
}

// Nix separates builders with semicolons or line breaks. In each entry, the
// first field is the store URI and the second lists the systems, where `-`
// keeps the default.
function builderHosts(builders: string, system: string): readonly string[] {
	const entries = builders
		.split(/[;\n]/u)
		.map((entry) => entry.trim().split(/\s+/u))
		.flatMap(([uri = '', systems = '-']): BuilderEntry[] => {
			const host = uriHost(uri.includes('://') ? uri : `ssh://${uri}`);

			return host === undefined
				? []
				: [{ host, systems: systems === '-' ? 'any' : systems.split(',') }];
		});
	const matching = entries.filter(
		(entry) => entry.systems === 'any' || entry.systems.includes(system)
	);

	return [
		...new Set(
			(matching.length === 0 ? entries : matching).map((entry) => entry.host)
		)
	];
}

function uriHost(uri: string): string | undefined {
	if (!URL.canParse(uri)) {
		return undefined;
	}

	const { hostname } = new URL(uri);

	return hostname === '' ? undefined : hostname;
}
