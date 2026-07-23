import { type CliUi, createCliUi } from '@cupboard/cli-ui';

import type { AccountSummary } from './cloudflare-api.ts';
import type { CloudflareAccountId } from './identifiers.ts';

export { type MenuEntry, terminalLink, type TextEdit } from '@cupboard/cli-ui';

/**
 * The {@link CliUi} for `cupboard deploy`, with the one prompt unique to it:
 * picking the Cloudflare account the deploy targets.
 */
export interface DeployUi extends CliUi {
	/** Undefined when cancelled. */
	chooseAccount(
		accounts: readonly AccountSummary[]
	): Promise<CloudflareAccountId | undefined>;
}

export interface DeployUiOptions {
	readonly signal?: AbortSignal;
	/** ANSI colour preference from `--colour`/`--no-colour`. */
	readonly colour?: boolean;
}

export function createDeployUi(options: DeployUiOptions = {}): DeployUi {
	const ui = createCliUi({
		mode: 'terminal',
		colour: options.colour,
		signal: options.signal
	});

	return {
		...ui,

		chooseAccount: (accounts) =>
			ui.menu(
				'Which Cloudflare account?',
				accounts.map((account) => ({
					value: account.id,
					label: account.name,
					hint: account.id
				}))
			)
	};
}
