import type { Reporter } from '@cupboard/reporter';

/**
 * Reports the setting names the running configuration states that no Nix this
 * client knows has, once for the run that read them.
 *
 * Nix warns about such a name and carries on, so nothing about the run
 * changes; a name reported here is a line of a `nix.conf` that settled
 * nothing, which is usually a misspelling and is worth saying so.
 */
export function reportUnknownSettings(
	reporter: Pick<Reporter, 'warn'>,
	unknownSettings: readonly string[]
): void {
	if (unknownSettings.length === 0) {
		return;
	}

	reporter.warn(
		'the configuration names settings no nix knows',
		unknownSettings.join(' ')
	);
}
