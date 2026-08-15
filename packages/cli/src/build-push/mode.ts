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

const reconciledLocalPublication =
	'so the build runs without the post-build hook and one push publishes ' +
	'what it leaves in the store.';

/** The line the reporter shows for the mode a run took, and why. */
export function buildPushModeDescription(mode: BuildPushMode): string {
	if (mode.kind === 'streamed') {
		return (
			'Publication mode: streamed. Each completed output publishes while ' +
			'the build runs.'
		);
	}

	if (mode.reason instanceof DaemonRequiredError) {
		return (
			`Publication mode: reconciled local. No Nix daemon socket exists at ` +
			`${mode.reason.socketPath}, ${reconciledLocalPublication}`
		);
	}

	return (
		'Publication mode: reconciled local. The Nix daemon does not trust this ' +
		`client, ${reconciledLocalPublication}`
	);
}
