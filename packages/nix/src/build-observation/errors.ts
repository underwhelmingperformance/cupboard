import { CodedError } from '@cupboard/shared/errors';

/**
 * No candidate runtime directory yields a hook socket path that fits within
 * `sun_path`, so the invocation endpoint cannot be created anywhere.
 */
export class SocketPathTooLongError extends CodedError {
	constructor(
		public readonly socketPath: string,
		public readonly limitBytes: number
	) {
		super(
			`No runtime directory yields a hook socket path within ` +
				`${String(limitBytes)} bytes; the shortest candidate was ${socketPath}`
		);
		this.name = 'SocketPathTooLongError';
	}
}

/**
The invocation listener refused to accept a build event.
*/
export abstract class BuildEventRejectedError extends CodedError {}

export type BuildEventMalformedKind =
	'missing-line' | 'invalid-json' | 'invalid-event';

export class BuildEventMalformedError extends BuildEventRejectedError {
	constructor(public readonly kind: BuildEventMalformedKind) {
		super(`Rejected a malformed build event: ${kind}`);
		this.name = 'BuildEventMalformedError';
	}
}

/**
The invocation listener received a build event that exceeded the fixed byte
limit.
*/
export class BuildEventTooLargeError extends BuildEventRejectedError {
	constructor(
		public readonly maximumBytes: number,
		public readonly observedBytes: number
	) {
		super(
			`Rejected a build event after ${String(observedBytes)} bytes; the limit is ${String(maximumBytes)} bytes`
		);
		this.name = 'BuildEventTooLargeError';
	}
}

/**
The listener accepted a valid event but could not protect its output paths from
garbage collection.
*/
export class BuildEventHandlingError extends BuildEventRejectedError {
	constructor(public override readonly cause: unknown) {
		super('Cupboard could not protect the completed outputs for streaming.');
		this.name = 'BuildEventHandlingError';
	}
}

/**
The hook stopped waiting before the listener could acknowledge the event.
*/
export class BuildEventConnectionClosedError extends Error {
	constructor() {
		super(
			'The build hook stopped waiting before Cupboard protected the completed outputs from garbage collection.'
		);
		this.name = 'BuildEventConnectionClosedError';
	}
}

/**
 * The daemon does not trust this client, so it would silently ignore the
 * invocation's `post-build-hook` override. The listener would therefore receive
 * no completed-output events. Refuse the build before it starts;
 * `requiredSetting` is the daemon setting that must list the user.
 */
export class UntrustedDaemonError extends CodedError {
	public readonly requiredSetting = 'trusted-users';

	constructor(public readonly trust: 'not-trusted' | 'unknown') {
		super(
			`The Nix daemon does not trust this user, so it would ignore the ` +
				`post-build-hook configured for this run. Add the user to the daemon's ` +
				`trusted-users setting.`
		);
		this.name = 'UntrustedDaemonError';
	}

	override get exitCode(): number {
		return 77;
	}
}

/**
The selected store runs on another machine, so its build hook cannot connect to
the listener on this machine.
*/
export class RemoteBuildPushStoreError extends CodedError {
	constructor(public readonly storeKind: 'ssh-ng') {
		super(
			'Cupboard cannot stream build outputs from an ssh-ng store because ' +
				'the build hook and Cupboard run on different machines. Use a local ' +
				'store or a local Nix daemon.'
		);
		this.name = 'RemoteBuildPushStoreError';
	}

	override get exitCode(): number {
		return 69;
	}
}

/**
 * The effective configuration already sets `post-build-hook`. Nix supports
 * exactly one, so streaming mode refuses; it never silently overrides an
 * operator's hook.
 */
export class PostBuildHookConflictError extends CodedError {
	constructor(public readonly existingHook: string) {
		super(
			`The Nix configuration already sets post-build-hook (${existingHook}), ` +
				`and Nix supports exactly one. Remove it, or run without streaming.`
		);
		this.name = 'PostBuildHookConflictError';
	}
}

/**
 * This installation has no compiled hook helper at any expected location, so
 * streaming publication cannot start. `candidates` lists every location that
 * was checked.
 */
export class HookHelperMissingError extends CodedError {
	constructor(public readonly candidates: readonly string[]) {
		super(
			`This installation is missing its cupboard-hook-relay hook helper; ` +
				`checked: ${candidates.join(', ')}.`
		);
		this.name = 'HookHelperMissingError';
	}
}

/**
 * A well-formed build event naming an output path outside the selected store
 * directory. Only paths beneath that directory are publication candidates, so
 * the event is refused before anything enters the accepted set.
 */
export class BuildEventOutsideStoreError extends BuildEventRejectedError {
	constructor(
		public readonly storePath: string,
		public readonly storeDirectory: string
	) {
		super(
			`Rejected a build event: ${storePath} is not beneath ${storeDirectory}`
		);
		this.name = 'BuildEventOutsideStoreError';
	}
}
