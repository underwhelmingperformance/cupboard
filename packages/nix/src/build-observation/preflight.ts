import path from 'node:path';

import type { InvocationId } from '@cupboard/protocol/build';

import type { NixDaemonTrust } from '../nix-store.ts';
import type { NixStoreKind } from '../store-client.ts';
import type { NixStoreConfig } from '../store-config.ts';

import {
	PostBuildHookConflictError,
	RemoteBuildPushStoreError,
	UntrustedDaemonError
} from './errors.ts';
import {
	type HelperResolutionOptions,
	resolveHookHelper
} from './helper-resolution.ts';
import {
	type InvocationRuntimeOptions,
	type InvocationRuntimePlan,
	planInvocationRuntime
} from './runtime-directory.ts';

export interface BuildObservationPreflightOptions {
	readonly config: NixStoreConfig;
	readonly storeKind: NixStoreKind;
	readonly stateDirectory: string;
	readonly daemonTrust: () => Promise<NixDaemonTrust>;
	readonly invocationId: InvocationId;
	readonly helper?: HelperResolutionOptions;
	readonly runtime?: Omit<InvocationRuntimeOptions, 'invocationId'>;
}

export interface BuildObservationPreflight {
	readonly outputProtection:
		| { readonly kind: 'daemon-temporary-roots' }
		| {
				readonly kind: 'daemonless-gc-roots';
				readonly rootLinkDirectory: string;
		  };
	readonly helperPath: string;
	readonly runtimePlan: InvocationRuntimePlan;
}

/**
 * Checks the store, hook helper and socket layout before observing a build.
 * The daemon must trust the current user to apply the hook override.
 */
export async function preflightBuildObservation(
	options: BuildObservationPreflightOptions
): Promise<BuildObservationPreflight> {
	const { config } = options;

	if (options.storeKind === 'ssh-ng') {
		throw new RemoteBuildPushStoreError(options.storeKind);
	}

	const outputProtection: BuildObservationPreflight['outputProtection'] =
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

	return { outputProtection, helperPath, runtimePlan };
}
