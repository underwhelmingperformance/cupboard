import { describe, expect, it } from 'vitest';

import {
	AccountOptionRequiredError,
	chooseDeployAccount,
	collectR2Credentials,
	DeployCancelledError,
	planMenuEntries,
	type PlanReviewWorld,
	type PlanState,
	R2CredentialsRequiredError,
	reviewPlan
} from './command.ts';
import { parseDeploymentConfig } from './config.ts';
import { collectResources } from './deploy-run.ts';
import type { DeployUi, TextEdit } from './ui.ts';

const accounts = [
	{ id: 'acc-1', name: 'Personal' },
	{ id: 'acc-2', name: 'Work' }
];

const config = parseDeploymentConfig(
	`{
		"name": "cupboard",
		"compatibility_date": "2026-05-15",
		"r2_buckets": [{ "binding": "BLOBS", "bucket_name": "cupboard-blobs" }],
		"d1_databases": [{ "binding": "DB", "database_name": "cupboard" }],
		"queues": {
			"producers": [{ "binding": "Q", "queue": "cupboard-maintenance" }],
			"consumers": [{ "queue": "cupboard-maintenance" }]
		},
		"triggers": { "crons": ["0 * * * *"] }
	}`,
	`{
		"name": "cupboard-tenant",
		"compatibility_date": "2026-05-15",
		"r2_buckets": [{ "binding": "BLOBS", "bucket_name": "cupboard-blobs" }]
	}`
);

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
		menu: unexpected('menu'),
		editText: unexpected('editText'),
		secret: unexpected('secret'),
		chooseAccount: () => Promise.resolve(choice),
		openBrowser: unexpected('openBrowser'),
		reporter: unexpected('reporter')
	};
}

interface ReviewScript {
	readonly menuChoices?: readonly (string | undefined)[];
	readonly textEdits?: readonly TextEdit[];
	readonly secrets?: readonly (string | undefined)[];
	readonly accountChoice?: string;
}

function scriptedUi(script: ReviewScript): DeployUi {
	const menuChoices = [...(script.menuChoices ?? [])];
	const textEdits = [...(script.textEdits ?? [])];
	const secrets = [...(script.secrets ?? [])];
	const infos: string[] = [];

	return {
		...pickerUi(script.accountChoice),
		info: (message) => {
			infos.push(message);
		},
		menu: (_message, entries) => {
			if (menuChoices.length === 0) {
				throw new Error('menu asked more often than scripted');
			}

			const scripted = menuChoices.shift();

			// Resolve through the caller's entries, as the real menu does, so the
			// scripted answer keeps the caller's narrow type.
			return Promise.resolve(
				entries.find((entry) => entry.value === scripted)?.value
			);
		},
		editText: () => {
			const edit = textEdits.shift();

			if (edit === undefined) {
				throw new Error('editText asked more often than scripted');
			}

			return Promise.resolve(edit);
		},
		secret: () => {
			if (secrets.length === 0) {
				throw new Error('secret asked more often than scripted');
			}

			return Promise.resolve(secrets.shift());
		}
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

describe('planMenuEntries', () => {
	it('lists Deploy first, every editable value, then Cancel', () => {
		const state: PlanState = { accountId: 'acc-1', domain: undefined, config };

		expect(planMenuEntries(state)).toStrictEqual([
			{ value: 'deploy', label: 'Deploy' },
			{ value: 'account', label: 'Account', hint: 'acc-1' },
			{ value: 'domain', label: 'Custom domain', hint: '(none)' },
			{
				value: 'bucket:cupboard-blobs',
				label: 'R2 bucket',
				hint: 'cupboard-blobs'
			},
			{ value: 'database:cupboard', label: 'D1 database', hint: 'cupboard' },
			{
				value: 'queue:cupboard-maintenance',
				label: 'Queue',
				hint: 'cupboard-maintenance'
			},
			{ value: 'crons', label: 'Cron triggers', hint: '0 * * * *' },
			{ value: 'cancel', label: 'Cancel' }
		]);
	});
});

describe('reviewPlan', () => {
	const initial: PlanState = { accountId: 'acc-1', domain: undefined, config };

	function world(
		ui: DeployUi,
		options?: { readonly skipReview?: boolean }
	): { world: PlanReviewWorld; rendered: PlanState[] } {
		const rendered: PlanState[] = [];

		return {
			rendered,
			world: {
				ui,
				render: (state) => {
					rendered.push(state);
					return Promise.resolve();
				},
				accounts: () => Promise.resolve(accounts),
				skipReview: options?.skipReview ?? false
			}
		};
	}

	it('accepts the plan without prompting when the review is skipped', async () => {
		const { world: w, rendered } = world(scriptedUi({}), { skipReview: true });

		expect({
			agreed: await reviewPlan(initial, w),
			rendered
		}).toStrictEqual({ agreed: initial, rendered: [initial] });
	});

	it('deploys with the initial state when chosen straight away', async () => {
		const { world: w } = world(scriptedUi({ menuChoices: ['deploy'] }));

		expect(await reviewPlan(initial, w)).toStrictEqual(initial);
	});

	it.each([
		['cancel was chosen', 'cancel'],
		['the menu prompt was cancelled', undefined]
	])('returns undefined when %s', async (_name, choice) => {
		const { world: w } = world(scriptedUi({ menuChoices: [choice] }));

		expect(await reviewPlan(initial, w)).toBeUndefined();
	});

	it('applies a domain edit and re-renders before deploying', async () => {
		const { world: w, rendered } = world(
			scriptedUi({
				menuChoices: ['domain', 'deploy'],
				textEdits: [{ kind: 'set', value: 'cache.example.com' }]
			})
		);

		const agreed = await reviewPlan(initial, w);

		expect({ agreed, renders: rendered.length }).toStrictEqual({
			agreed: { ...initial, domain: 'cache.example.com' },
			renders: 2
		});
	});

	it('renames a bucket everywhere both workers reference it', async () => {
		const { world: w } = world(
			scriptedUi({
				menuChoices: ['bucket:cupboard-blobs', 'deploy'],
				textEdits: [{ kind: 'set', value: 'my-cache' }]
			})
		);

		const agreed = await reviewPlan(initial, w);

		expect(collectResources(agreed?.config ?? config).r2Buckets).toStrictEqual([
			'my-cache'
		]);
	});

	it('replaces the cron triggers from a comma-separated edit', async () => {
		const { world: w } = world(
			scriptedUi({
				menuChoices: ['crons', 'deploy'],
				textEdits: [{ kind: 'set', value: '*/30 * * * *, 0 4 * * MON' }]
			})
		);

		const agreed = await reviewPlan(initial, w);

		expect(agreed?.config.control.crons).toStrictEqual([
			'*/30 * * * *',
			'0 4 * * MON'
		]);
	});

	it('switches account from the live account list', async () => {
		const { world: w } = world(
			scriptedUi({
				menuChoices: ['account', 'deploy'],
				accountChoice: 'acc-2'
			})
		);

		expect(await reviewPlan(initial, w)).toStrictEqual({
			...initial,
			accountId: 'acc-2'
		});
	});

	it('keeps the state when an edit is cancelled', async () => {
		const { world: w } = world(
			scriptedUi({
				menuChoices: ['domain', 'deploy'],
				textEdits: [{ kind: 'cancelled' }]
			})
		);

		expect(await reviewPlan(initial, w)).toStrictEqual(initial);
	});
});

describe('collectR2Credentials', () => {
	const pair = {
		accessKeyId: 'a'.repeat(32),
		secretAccessKey: 'b'.repeat(64)
	};

	it('takes both parts from the environment without prompting', async () => {
		expect(
			await collectR2Credentials(
				scriptedUi({}),
				{
					R2_ACCESS_KEY_ID: pair.accessKeyId,
					R2_SECRET_ACCESS_KEY: pair.secretAccessKey
				},
				true
			)
		).toStrictEqual(pair);
	});

	it('requires the environment when not interactive', async () => {
		await expect(
			collectR2Credentials(scriptedUi({}), {}, false)
		).rejects.toStrictEqual(new R2CredentialsRequiredError());
	});

	it('prompts for both parts when the environment has neither', async () => {
		const ui = scriptedUi({
			textEdits: [{ kind: 'set', value: pair.accessKeyId }],
			secrets: [pair.secretAccessKey]
		});

		expect(await collectR2Credentials(ui, {}, true)).toStrictEqual(pair);
	});

	it('returns undefined when the secret prompt is cancelled', async () => {
		const ui = scriptedUi({
			textEdits: [{ kind: 'set', value: pair.accessKeyId }],
			secrets: [undefined]
		});

		expect(await collectR2Credentials(ui, {}, true)).toBeUndefined();
	});
});
