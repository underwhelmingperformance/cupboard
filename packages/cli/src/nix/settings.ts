import type { Reporter } from '@cupboard/reporter';

/**
 * Reports the setting names in the running configuration that are not defined
 * by any Nix version this client knows about. The report is emitted once for
 * the run that read the configuration.
 *
 * Nix warns about such a name and continues, so the setting has no effect on
 * the run. A name reported here is usually a misspelling in a `nix.conf`, which
 * is worth telling the user about.
 */
export function reportUnknownSettings(
	reporter: Pick<Reporter, 'warn'>,
	unknownSettings: readonly string[]
): void {
	if (unknownSettings.length === 0) {
		return;
	}

	reporter.warn(
		'the configuration names settings no known Nix version defines',
		unknownSettings.join(' ')
	);
}
