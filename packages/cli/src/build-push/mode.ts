import { UntrustedDaemonError } from '../errors.ts';

import type { BuildPushPreflight } from './preflight.ts';

/**
 * How a run publishes what it builds. In streamed mode, the build hook reports
 * each completed output, and Cupboard publishes the output while the build
 * continues. In reconciled local mode, Cupboard waits for the build and then
 * publishes its successful outputs.
 */
export type BuildPushMode =
	| { readonly kind: 'streamed'; readonly preflight: BuildPushPreflight }
	| {
			readonly kind: 'reconciled-local';
			readonly reason: UntrustedDaemonError;
	  };

/**
 * Selects a publication mode from the preflight result. When the daemon does
 * not trust the current user, Nix ignores a build hook configured for one
 * command. Cupboard therefore publishes after the build. Every other preflight
 * failure ends the run.
 */
export async function selectBuildPushMode(
	preflight: () => Promise<BuildPushPreflight>
): Promise<BuildPushMode> {
	try {
		return { kind: 'streamed', preflight: await preflight() };
	} catch (error) {
		if (error instanceof UntrustedDaemonError) {
			return { kind: 'reconciled-local', reason: error };
		}

		throw error;
	}
}

/**
Describes the selected publication mode and why Cupboard selected it.
*/
export function buildPushModeDescription(mode: BuildPushMode): string {
	if (mode.kind === 'streamed') {
		return (
			'Publication mode: streamed. Cupboard publishes each completed output ' +
			'while the build runs.'
		);
	}

	if (mode.reason.trust === 'not-trusted') {
		return (
			'Publication mode: after the build. The current user is not included ' +
			"in the Nix daemon's trusted-users setting, so Cupboard cannot " +
			'publish outputs as they finish. Cupboard will publish the successful ' +
			'outputs after the build finishes.'
		);
	}

	return (
		'Publication mode: after the build. Cupboard could not confirm whether ' +
		"the current user is included in the Nix daemon's trusted-users " +
		'setting, so Cupboard cannot publish outputs as they finish. Cupboard ' +
		'will publish the successful outputs after the build finishes.'
	);
}
