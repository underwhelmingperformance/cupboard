import path from 'node:path';

import type {
	NixDaemonTrust,
	NixStoreConfig,
	NixStoreKind
} from '@cupboard/nix';
import type { CacheSelector, RootName } from '@cupboard/nix-store/scalars';
import type { InvocationId } from '@cupboard/protocol/build';
import {
	type AuthorizationDetail,
	isCoveredByToken,
	type Operation
} from '@cupboard/protocol/grants';

import {
	MissingGrantError,
	PostBuildHookConflictError,
	RemoteBuildPushStoreError,
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
	readonly storeKind: NixStoreKind;
	readonly stateDirectory: string;
	readonly daemonTrust: () => Promise<NixDaemonTrust>;
	readonly invocationId: InvocationId;
	readonly grants: readonly AuthorizationDetail[];
	readonly cache: CacheSelector;
	readonly runRoot?: RootName;
	readonly targetRoots?: readonly RootName[];
	readonly helper?: HelperResolutionOptions;
	readonly runtime?: Omit<InvocationRuntimeOptions, 'invocationId'>;
}

export interface BuildPushPreflight {
	readonly outputProtection:
		| { readonly kind: 'daemon-temporary-roots' }
		| {
				readonly kind: 'daemonless-gc-roots';
				readonly rootLinkDirectory: string;
		  };
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
 * Checks whether a build can stream before it starts. With a daemon, the
 * current user must be allowed to configure the build hook. Without a daemon,
 * the hook registers GC roots through the local store. Preflight also rejects a
 * store on another machine, a conflicting operator hook, a missing helper, an
 * oversized socket path, or insufficient retention grants.
 */
export async function preflightBuildPush(
	options: BuildPushPreflightOptions
): Promise<BuildPushPreflight> {
	const { config } = options;

	if (options.storeKind === 'ssh-ng') {
		throw new RemoteBuildPushStoreError(options.storeKind);
	}

	const outputProtection: BuildPushPreflight['outputProtection'] =
		options.storeKind === 'daemon'
			? { kind: 'daemon-temporary-roots' }
			: {
					kind: 'daemonless-gc-roots',
					rootLinkDirectory: path.join(
						options.stateDirectory,
						'gcroots',
						'cupboard',
						options.invocationId
					)
				};

	if (options.storeKind === 'daemon') {
		const trust = await options.daemonTrust();

		if (trust !== 'trusted') {
			throw new UntrustedDaemonError(trust);
		}
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

	return { outputProtection, helperPath, runtimePlan };
}
