import { describe, expect, it } from 'vitest';

import {
	AccountOptionRequiredError,
	chooseDeployAccount,
	DeployCancelledError
} from './command.ts';
import type { DeployUi } from './ui.ts';

const accounts = [
	{ id: 'acc-1', name: 'Personal' },
	{ id: 'acc-2', name: 'Work' }
];

const unexpected = (member: string) => (): never => {
	throw new Error(`${member} was not expected`);
};

/** A {@link DeployUi} whose account picker answers with `choice` (or cancels). */
function pickerUi(choice?: string): DeployUi {
	return {
		intro: unexpected('intro'),
		outro: unexpected('outro'),
		cancelled: unexpected('cancelled'),
		info: unexpected('info'),
		success: unexpected('success'),
		warn: unexpected('warn'),
		note: unexpected('note'),
		confirmDeploy: unexpected('confirmDeploy'),
		chooseAccount: () => Promise.resolve(choice),
		openBrowser: unexpected('openBrowser'),
		reporter: unexpected('reporter')
	};
}

describe('chooseDeployAccount', () => {
	it('returns the account picked in the terminal', async () => {
		expect(await chooseDeployAccount(pickerUi('acc-2'), accounts, true)).toBe(
			'acc-2'
		);
	});

	it('treats a cancelled picker as a cancelled deploy', async () => {
		await expect(
			chooseDeployAccount(pickerUi(), accounts, true)
		).rejects.toStrictEqual(new DeployCancelledError());
	});

	it('instructs non-interactive callers to pass --account, listing them', async () => {
		const choice = chooseDeployAccount(pickerUi('acc-1'), accounts, false);

		await expect(choice).rejects.toStrictEqual(
			new AccountOptionRequiredError(accounts)
		);
		await expect(choice).rejects.toThrow('acc-2  Work');
	});
});
