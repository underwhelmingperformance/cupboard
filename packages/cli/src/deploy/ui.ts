import { type CliUi, createCliUi } from '@cupboard/cli-ui';

import type { AccountSummary } from './cloudflare-api.ts';

export { type MenuEntry, terminalLink, type TextEdit } from '@cupboard/cli-ui';

/**
 * The {@link CliUi} for `cupboard deploy`, with the one prompt unique to it:
 * picking the Cloudflare account the deploy targets.
 */
export interface DeployUi extends CliUi {
	/** Undefined when cancelled. */
	chooseAccount(
		accounts: readonly AccountSummary[]
	): Promise<string | undefined>;
}

export function createDeployUi(signal?: AbortSignal): DeployUi {
	const ui = createCliUi({ mode: 'terminal', signal });

	return {
		...ui,

		chooseAccount(accounts) {
			return ui.menu(
				'Which Cloudflare account?',
				accounts.map((account) => ({
					value: account.id,
					label: account.name,
					hint: account.id
				}))
			);
		}
	};
}
