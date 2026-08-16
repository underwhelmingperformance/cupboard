import { DaemonRequiredError, UntrustedDaemonError } from '../errors.ts';

import type { BuildPushPreflight } from './preflight.ts';

/**
 * How a run publishes what it builds. The streamed mode includes the endpoints
 * preflight proved: each completed output arrives through the daemon's
 * post-build hook and is published while the build continues. The reconciled
 * local mode includes the daemon condition that ruled streaming out: the build
 * runs without the hook and one push publishes from the store the build
 * populated.
 */
export type BuildPushMode =
	| { readonly kind: 'streamed'; readonly preflight: BuildPushPreflight }
	| {
			readonly kind: 'reconciled-local';
			readonly reason: DaemonRequiredError | UntrustedDaemonError;
	  };

/**
 * The mode a run takes, from what preflight proved. A machine with no daemon
 * socket, or a daemon that would ignore this client's `post-build-hook`, can
 * still build and publish, so both select the reconciled local mode rather
 * than ending the run. Every other refusal is a condition publication cannot
 * work around, so the run fails.
 */
export async function selectBuildPushMode(
	preflight: () => Promise<BuildPushPreflight>
): Promise<BuildPushMode> {
	try {
		return { kind: 'streamed', preflight: await preflight() };
	} catch (error) {
		if (
			error instanceof DaemonRequiredError ||
			error instanceof UntrustedDaemonError
		) {
			return { kind: 'reconciled-local', reason: error };
		}

		throw error;
	}
}

/**
The line the reporter shows for the mode a run took, and why.
*/
export function buildPushModeDescription(mode: BuildPushMode): string {
	if (mode.kind === 'streamed') {
		return (
			'Publication mode: streamed. Each completed output publishes while ' +
			'the build runs.'
		);
	}

	if (mode.reason instanceof DaemonRequiredError) {
		return (
			'Publication mode: after the build. Nix is running without a daemon, ' +
			'so Cupboard cannot protect completed outputs from garbage ' +
			'collection while the build continues. Cupboard will publish the ' +
			'successful outputs after the build finishes.'
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
