import type Cloudflare from 'cloudflare';

import { isAbortError } from '../abort.ts';

import { type CloudflareApi, createCloudflareApi } from './cloudflare-api.ts';
import type { CloudflareAccountId, ScriptName } from './identifiers.ts';
import { claimSecretName } from './secrets.ts';
import type { DeployUi } from './ui.ts';

/**
 * Deletes the claim secret from the control Worker. A failure other than an
 * abort produces a warning that the secret stays set. Its value was never
 * printed or written to disk, and the next `cupboard init` removes it.
 */
export async function removeClaimSecret(
	ui: Pick<DeployUi, 'reporter' | 'warn'>,
	api: Pick<CloudflareApi, 'deleteSecret'>,
	controlScriptName: ScriptName,
	label = 'Removing the claim secret'
): Promise<void> {
	try {
		await ui
			.reporter()
			.phase(label, () => api.deleteSecret(controlScriptName, claimSecretName));
	} catch (error) {
		if (isAbortError(error)) {
			throw error;
		}

		ui.warn(
			`The claim secret ${claimSecretName} could not be removed from ` +
				`${controlScriptName}, so it stays set on the Worker. Its value ` +
				'was never printed or written to disk. The next `cupboard init` ' +
				'removes the secret.'
		);
	}
}

const cleanupTimeoutMs = 15_000;

/**
 * The Cloudflare API that removes the claim secret. Each removal creates a
 * client with its own time limit, because an interrupted run removes the
 * secret after the run's signal has aborted, and a request with that signal
 * fails at once.
 */
export function claimSecretCleanupApi(
	clientWithSignal: (signal: AbortSignal) => Cloudflare,
	accountId: CloudflareAccountId
): Pick<CloudflareApi, 'deleteSecret'> {
	return {
		deleteSecret: (scriptName, name) =>
			createCloudflareApi(
				clientWithSignal(AbortSignal.timeout(cleanupTimeoutMs)),
				accountId
			).deleteSecret(scriptName, name)
	};
}
