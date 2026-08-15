import type { NixDaemonTrust, NixStoreConfig } from '@cupboard/nix';
import type { CacheSelector, RootName } from '@cupboard/nix-store/scalars';
import type { InvocationId } from '@cupboard/protocol/build';
import {
	type AuthorizationDetail,
	isCoveredByToken,
	type Operation
} from '@cupboard/protocol/grants';

import {
	DaemonRequiredError,
	MissingGrantError,
	PostBuildHookConflictError,
	UntrustedDaemonError
} from '../errors.ts';

import {
	type HelperResolutionOptions,
	resolveHookHelper
} from './helper-resolution.ts';
import {
	type InvocationRuntimeOptions,
	type InvocationRuntimePlan,
	planInvocationRuntime
} from './runtime-directory.ts';

export interface BuildPushPreflightOptions {
	readonly config: NixStoreConfig;
	readonly socketExists: (socketPath: string) => boolean;
	readonly daemonTrust: () => Promise<NixDaemonTrust>;
	readonly invocationId: InvocationId;
	/**
	The authorization_details the token exchange actually granted.
	*/
	readonly grants: readonly AuthorizationDetail[];
	/**
	The cache the run publishes to, as its wire selector.
	*/
	readonly cache: CacheSelector;
	/**
	The run root every streamed commit attaches to, when the run binds one.
	*/
	readonly runRoot?: RootName;
	/**
	The target roots reconciliation will set, when the run declares any.
	*/
	readonly targetRoots?: readonly RootName[];
	readonly helper?: HelperResolutionOptions;
	readonly runtime?: Omit<InvocationRuntimeOptions, 'invocationId'>;
}

/**
What preflight proved: the endpoints a streaming run builds on.
*/
export interface BuildPushPreflight {
	readonly daemonSocketPath: string;
	readonly helperPath: string;
	readonly runtimePlan: InvocationRuntimePlan;
}

function requireGrant(
	grants: readonly AuthorizationDetail[],
	operation: Operation,
	cache: CacheSelector,
	root: RootName
): void {
	if (isCoveredByToken(grants, operation, { cache, root })) {
		return;
	}

	throw new MissingGrantError(operation, root);
}

/**
 * Proves a streaming run can work before the expensive build starts: a daemon
 * to hold temporary roots, a daemon that trusts this client (an untrusted
 * client's `post-build-hook` override is silently ignored), no operator hook
 * to collide with, a compiled helper in this installation, a socket path that
 * fits `sun_path`, and the root grants the run's later steps need. Each refusal
 * is a typed error; success returns the proven endpoints.
 */
export async function preflightBuildPush(
	options: BuildPushPreflightOptions
): Promise<BuildPushPreflight> {
	const { config } = options;

	if (!options.socketExists(config.daemonSocketPath)) {
		throw new DaemonRequiredError(config.daemonSocketPath);
	}

	const trust = await options.daemonTrust();

	if (trust !== 'trusted') {
		throw new UntrustedDaemonError(trust);
	}

	if (config.postBuildHook !== undefined) {
		throw new PostBuildHookConflictError(config.postBuildHook);
	}

	const helperPath = await resolveHookHelper(options.helper);
	const runtimePlan = planInvocationRuntime({
		...options.runtime,
		invocationId: options.invocationId
	});

	if (options.runRoot !== undefined) {
		requireGrant(options.grants, 'root:attach', options.cache, options.runRoot);
	}

	const targetRoots = options.targetRoots ?? [];

	for (const targetRoot of targetRoots) {
		requireGrant(options.grants, 'root:set', options.cache, targetRoot);
	}

	return { daemonSocketPath: config.daemonSocketPath, helperPath, runtimePlan };
}
