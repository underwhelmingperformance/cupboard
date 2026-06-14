import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	AccountOptionRequiredError,
	chooseDeployAccount,
	DeployCancelledError,
	envR2Credentials,
	obtainR2Credentials,
	planMenuEntries,
	type PlanReviewWorld,
	type PlanState,
	R2CredentialsRejectedError,
	reviewPlan,
	verifyR2Credentials
} from './command.ts';
import { parseDeploymentConfig } from './config.ts';
import { collectResources } from './deploy-run.ts';
import { deployerOwner, type OwnerBinding } from './owner.ts';
import type { R2CredentialCheck } from './r2-credentials.ts';
import { TokenManagementNotPermittedError } from './r2-token.ts';
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

interface UiCall {
	readonly method: string;
}

const recordUiCall =
	(calls: UiCall[], method: string): (() => void) =>
	() => {
		calls.push({ method });
	};

const absentValues: { readonly choice?: never } = {};

function absentString(): string | undefined {
	return undefined;
}

/** A {@link DeployUi} whose account picker answers with `choice` (or cancels). */
function pickerUi(choice?: string, uiCalls: UiCall[] = []): DeployUi {
	return {
		interactive: true,
		intro: recordUiCall(uiCalls, 'intro'),
		outro: recordUiCall(uiCalls, 'outro'),
		cancelled: recordUiCall(uiCalls, 'cancelled'),
		info: recordUiCall(uiCalls, 'info'),
		success: recordUiCall(uiCalls, 'success'),
		warn: recordUiCall(uiCalls, 'warn'),
		note: recordUiCall(uiCalls, 'note'),
		data: recordUiCall(uiCalls, 'data'),
		confirm: (options) => {
			uiCalls.push({ method: 'confirm' });
			void options;

			return Promise.resolve('no');
		},
		menu: (_message, entries) => {
			uiCalls.push({ method: 'menu' });
			void entries;

			return Promise.resolve(absentValues.choice);
		},
		editText: (options) => {
			uiCalls.push({ method: 'editText' });
			void options;

			return Promise.resolve({ kind: 'cancelled' });
		},
		prefixedText: (options) => {
			uiCalls.push({ method: 'prefixedText' });
			void options;

			return Promise.resolve(absentString());
		},
		secret: (message) => {
			uiCalls.push({ method: 'secret' });
			void message;

			return Promise.resolve(absentString());
		},
		chooseAccount: () => {
			uiCalls.push({ method: 'chooseAccount' });

			return Promise.resolve(choice);
		},
		openBrowser: recordUiCall(uiCalls, 'openBrowser'),
		reporter: () => ({
			phase: (_label, body) =>
				Promise.resolve(body({ fact: recordUiCall(uiCalls, 'fact') })),
			progress: (_label, _options, body) =>
				Promise.resolve(
					body({
						advance: recordUiCall(uiCalls, 'reporter.progress.advance'),
						fact: recordUiCall(uiCalls, 'reporter.progress.fact')
					})
				),
			steps: (_label, body) =>
				Promise.resolve(
					body({
						message: recordUiCall(uiCalls, 'reporter.steps.message'),
						group: () => ({
							message: recordUiCall(uiCalls, 'reporter.steps.group.message'),
							success: recordUiCall(uiCalls, 'reporter.steps.group.success'),
							error: recordUiCall(uiCalls, 'reporter.steps.group.error')
						})
					})
				),
			result: recordUiCall(uiCalls, 'result'),
			data: recordUiCall(uiCalls, 'reporter.data'),
			warn: recordUiCall(uiCalls, 'reporter.warn'),
			info: recordUiCall(uiCalls, 'reporter.info'),
			error: recordUiCall(uiCalls, 'reporter.error')
		})
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
	const warnings: string[] = [];
	const facts: string[] = [];

	return {
		...pickerUi(script.accountChoice),
		info: (message) => {
			infos.push(message);
		},
		warn: (message) => {
			warnings.push(message);
		},
		reporter: () => ({
			phase: (_label, body) =>
				Promise.resolve(
					body({
						fact: (label, value) => {
							facts.push(`${label} ${String(value)}`);
						}
					})
				),
			progress: (_label, _options, body) =>
				Promise.resolve(
					body({
						advance: () => {
							return;
						},
						fact: (label, value) => {
							facts.push(`${label} ${String(value)}`);
						}
					})
				),
			steps: (_label, body) =>
				Promise.resolve(
					body({
						message: () => {
							return;
						},
						group: () => ({
							message: () => {
								return;
							},
							success: () => {
								return;
							},
							error: () => {
								return;
							}
						})
					})
				),
			result: () => {
				facts.push('result');
			},
			data: () => {
				return;
			},
			warn: (message) => {
				warnings.push(message);
			},
			info: (message) => {
				infos.push(message);
			},
			error: () => {
				return;
			}
		}),
		menu: (_message, entries) => {
			const [scripted] = z
				.array(z.string().optional())
				.length(1)
				.parse(menuChoices.splice(0, 1));

			if (scripted === undefined) {
				return Promise.resolve(absentValues.choice);
			}

			const choice = z
				.custom<
					(typeof entries)[number]['value']
				>((value) => value === scripted)
				.parse(entries.find((entry) => entry.value === scripted)?.value);

			return Promise.resolve(choice);
		},
		editText: () => {
			const edit = z
				.custom<TextEdit>((value) => value !== undefined)
				.parse(textEdits.shift());

			return Promise.resolve(edit);
		},
		secret: () => {
			const [secret] = z
				.array(z.string().optional())
				.length(1)
				.parse(secrets.splice(0, 1));

			return Promise.resolve(secret);
		}
	};
}

describe('chooseDeployAccount', () => {
	it('returns the account picked in the terminal', async () => {
		const uiCalls: UiCall[] = [];
		const choice = await chooseDeployAccount(
			pickerUi('acc-2', uiCalls),
			accounts,
			true
		);

		expect({ choice, uiCalls }).toStrictEqual({
			choice: 'acc-2',
			uiCalls: [{ method: 'chooseAccount' }]
		});
	});

	it('treats a cancelled picker as a cancelled deploy', async () => {
		const uiCalls: UiCall[] = [];
		const outcome = await chooseDeployAccount(
			pickerUi(undefined, uiCalls),
			accounts,
			true
		).then(
			(choice) => ({ choice }),
			(error_: unknown) => {
				expect(error_).toBeInstanceOf(DeployCancelledError);

				if (error_ instanceof DeployCancelledError) {
					return { error: { name: error_.name } };
				}

				throw error_;
			}
		);

		expect({ outcome, uiCalls }).toStrictEqual({
			outcome: { error: { name: 'DeployCancelledError' } },
			uiCalls: [{ method: 'chooseAccount' }]
		});
	});

	it('instructs non-interactive callers to pass --account, listing them', async () => {
		let rejection: unknown;
		try {
			await chooseDeployAccount(pickerUi('acc-1'), accounts, false);
		} catch (error_) {
			rejection = error_;
		}

		expect(rejection).toBeInstanceOf(AccountOptionRequiredError);

		if (rejection instanceof AccountOptionRequiredError) {
			expect({
				error: { name: rejection.name, accounts: rejection.accounts }
			}).toStrictEqual({
				error: { name: AccountOptionRequiredError.name, accounts }
			});
		}
	});
});

const deployer = deployerOwner('cf-user-1');

describe('planMenuEntries', () => {
	it('lists Deploy first, every editable value, then Cancel', () => {
		const state: PlanState = {
			accountId: 'acc-1',
			domain: undefined,
			config,
			owner: { kind: 'owner', owner: deployer, origin: 'deployer' }
		};

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
			{
				value: 'owner',
				label: 'Admin',
				hint: 'dash.cloudflare.com · cf-user-1 (you, the deployer)'
			},
			{ value: 'cancel', label: 'Cancel' }
		]);
	});
});

describe('reviewPlan', () => {
	const initial: PlanState = {
		accountId: 'acc-1',
		domain: undefined,
		config,
		owner: { kind: 'none' }
	};

	function world(
		ui: DeployUi,
		options?: {
			readonly skipReview?: boolean;
			readonly deployer?: OwnerBinding;
		}
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
				deployer: options?.deployer,
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

		expect({ agreed, rendered }).toStrictEqual({
			agreed: { ...initial, domain: 'cache.example.com' },
			rendered: [initial, { ...initial, domain: 'cache.example.com' }]
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
		const plan = z
			.custom<PlanState>((value) => value !== undefined)
			.parse(agreed);

		expect({
			r2Buckets: collectResources(plan.config).r2Buckets
		}).toStrictEqual({ r2Buckets: ['my-cache'] });
	});

	it('replaces the cron triggers from a comma-separated edit', async () => {
		const { world: w } = world(
			scriptedUi({
				menuChoices: ['crons', 'deploy'],
				textEdits: [{ kind: 'set', value: '*/30 * * * *, 0 4 * * MON' }]
			})
		);

		const agreed = await reviewPlan(initial, w);
		const plan = z
			.custom<PlanState>((value) => value !== undefined)
			.parse(agreed);

		expect({ crons: plan.config.control.crons }).toStrictEqual({
			crons: ['*/30 * * * *', '0 4 * * MON']
		});
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

	it('binds the deployer as owner from the owner submenu', async () => {
		const { world: w } = world(
			scriptedUi({ menuChoices: ['owner', 'deployer', 'deploy'] }),
			{ deployer }
		);

		expect(await reviewPlan(initial, w)).toStrictEqual({
			...initial,
			owner: { kind: 'owner', owner: deployer, origin: 'deployer' }
		});
	});

	it('binds a manually entered identity', async () => {
		const { world: w } = world(
			scriptedUi({
				menuChoices: ['owner', 'manual', 'deploy'],
				textEdits: [
					{ kind: 'set', value: 'https://accounts.example.com' },
					{ kind: 'set', value: 'user-7' },
					{ kind: 'set', value: 'client-9' }
				]
			})
		);

		expect(await reviewPlan(initial, w)).toStrictEqual({
			...initial,
			owner: {
				kind: 'owner',
				owner: {
					issuer: 'https://accounts.example.com',
					subject: 'user-7',
					audience: 'client-9'
				},
				origin: 'manual'
			}
		});
	});

	it('keeps the owner when the manual entry is cancelled midway', async () => {
		const { world: w } = world(
			scriptedUi({
				menuChoices: ['owner', 'manual', 'deploy'],
				textEdits: [
					{ kind: 'set', value: 'https://accounts.example.com' },
					{ kind: 'cancelled' }
				]
			})
		);

		expect(await reviewPlan(initial, w)).toStrictEqual(initial);
	});

	it('unbinds the owner when nobody is chosen', async () => {
		const bound: PlanState = {
			...initial,
			owner: { kind: 'owner', owner: deployer, origin: 'deployer' }
		};
		const { world: w } = world(
			scriptedUi({ menuChoices: ['owner', 'none', 'deploy'] }),
			{ deployer }
		);

		expect(await reviewPlan(bound, w)).toStrictEqual({
			...bound,
			owner: { kind: 'none' }
		});
	});
});

describe('R2 credential settlement', () => {
	const pair = {
		accessKeyId: 'a'.repeat(32),
		secretAccessKey: 'b'.repeat(64)
	};
	const created = {
		accessKeyId: 'c'.repeat(32),
		secretAccessKey: 'd'.repeat(64)
	};

	it('takes both parts from the environment', () => {
		expect(
			envR2Credentials({
				R2_ACCESS_KEY_ID: pair.accessKeyId,
				R2_SECRET_ACCESS_KEY: pair.secretAccessKey
			})
		).toStrictEqual(pair);
	});

	it.each([
		['both absent', {}],
		['the secret absent', { R2_ACCESS_KEY_ID: 'a'.repeat(32) }],
		['the id empty', { R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: 'b' }]
	])('reads the environment as unset with %s', (_name, env) => {
		expect(envR2Credentials(env)).toBeUndefined();
	});

	it('creates a scoped key when chosen', async () => {
		const ui = scriptedUi({ menuChoices: ['create'] });
		const creates: string[] = [];

		const outcome = await obtainR2Credentials({
			ui,
			accountId: 'acc-1',
			bucketName: 'cupboard-blobs',
			creation: {
				kind: 'available',
				bucketExists: true,
				create: () => {
					creates.push('create');

					return Promise.resolve(created);
				}
			}
		});

		expect({ outcome, creates }).toStrictEqual({
			outcome: { kind: 'settled', credentials: created, created: true },
			creates: ['create']
		});
	});

	it('falls back to manual entry when token management is not permitted', async () => {
		const ui = scriptedUi({
			menuChoices: ['create'],
			textEdits: [{ kind: 'set', value: pair.accessKeyId }],
			secrets: [pair.secretAccessKey]
		});

		expect(
			await obtainR2Credentials({
				ui,
				accountId: 'acc-1',
				bucketName: 'cupboard-blobs',
				creation: {
					kind: 'available',
					bucketExists: true,
					create: () =>
						Promise.reject(
							new TokenManagementNotPermittedError({ cause: undefined })
						)
				}
			})
		).toStrictEqual({ kind: 'settled', credentials: pair, created: false });
	});

	it('accepts an existing pair when chosen', async () => {
		const ui = scriptedUi({
			menuChoices: ['enter'],
			textEdits: [{ kind: 'set', value: pair.accessKeyId }],
			secrets: [pair.secretAccessKey]
		});
		const creates: string[] = [];

		const outcome = await obtainR2Credentials({
			ui,
			accountId: 'acc-1',
			bucketName: 'cupboard-blobs',
			creation: {
				kind: 'available',
				bucketExists: true,
				create: () => {
					creates.push('create');

					return Promise.resolve(created);
				}
			}
		});

		expect({ outcome, creates }).toStrictEqual({
			outcome: {
				kind: 'settled',
				credentials: pair,
				created: false
			},
			creates: []
		});
	});

	it('keeps the current key when the user says so after a bucket rename', async () => {
		const ui = scriptedUi({ menuChoices: ['keep'] });
		const creates: string[] = [];

		const outcome = await obtainR2Credentials({
			ui,
			accountId: 'acc-1',
			bucketName: 'pantry',
			creation: {
				kind: 'available',
				bucketExists: false,
				create: () => {
					creates.push('create');

					return Promise.resolve(created);
				}
			},
			keep: { previousBucket: 'cupboard-blobs' }
		});

		expect({ outcome, creates }).toStrictEqual({
			outcome: { kind: 'keep' },
			creates: []
		});
	});

	it('offers keeping the key even when creation is unavailable', async () => {
		const ui = scriptedUi({ menuChoices: ['keep'] });

		expect(
			await obtainR2Credentials({
				ui,
				accountId: 'acc-1',
				bucketName: 'pantry',
				creation: { kind: 'unavailable' },
				keep: { previousBucket: 'cupboard-blobs' }
			})
		).toStrictEqual({ kind: 'keep' });
	});

	it('goes straight to manual entry when creation is unavailable', async () => {
		const ui = scriptedUi({
			textEdits: [{ kind: 'set', value: pair.accessKeyId }],
			secrets: [pair.secretAccessKey]
		});

		expect(
			await obtainR2Credentials({
				ui,
				accountId: 'acc-1',
				bucketName: 'cupboard-blobs',
				creation: { kind: 'unavailable' }
			})
		).toStrictEqual({ kind: 'settled', credentials: pair, created: false });
	});

	it('cancels cleanly from the settle menu', async () => {
		const ui = scriptedUi({ menuChoices: ['cancel'] });
		const creates: string[] = [];

		const outcome = await obtainR2Credentials({
			ui,
			accountId: 'acc-1',
			bucketName: 'cupboard-blobs',
			creation: {
				kind: 'available',
				bucketExists: true,
				create: () => {
					creates.push('create');

					return Promise.resolve(created);
				}
			}
		});

		expect({ outcome, creates }).toStrictEqual({
			outcome: { kind: 'cancelled' },
			creates: []
		});
	});
});

describe('verifyR2Credentials', () => {
	const pair = {
		accessKeyId: 'a'.repeat(32),
		secretAccessKey: 'b'.repeat(64)
	};

	const base = {
		interactive: true,
		accountId: 'acc-1',
		bucketName: 'cupboard-blobs',
		initial: pair,
		sleep: () => Promise.resolve()
	};

	it('returns the pair once the probe accepts it', async () => {
		const ui = scriptedUi({});

		expect(
			await verifyR2Credentials({
				...base,
				ui,
				check: () => Promise.resolve({ kind: 'valid' })
			})
		).toStrictEqual(pair);
	});

	it('retries a freshly created key while it propagates', async () => {
		const ui = scriptedUi({});
		const checks: R2CredentialCheck[] = [
			{ kind: 'rejected', status: 403 },
			{ kind: 'rejected', status: 403 },
			{ kind: 'valid' }
		];
		const sleeps: number[] = [];

		const verified = await verifyR2Credentials({
			...base,
			ui,
			attempts: 5,
			check: () => {
				const [check] = z
					.tuple([z.custom<R2CredentialCheck>()])
					.parse(checks.splice(0, 1));

				return Promise.resolve(check);
			},
			sleep: (milliseconds) => {
				sleeps.push(milliseconds);

				return Promise.resolve();
			}
		});

		expect({ verified, sleeps }).toStrictEqual({
			verified: pair,
			sleeps: [5000, 5000]
		});
	});

	it('lets a rejection be overridden with deploy-anyway', async () => {
		const ui = scriptedUi({ menuChoices: ['continue'] });

		expect(
			await verifyR2Credentials({
				...base,
				ui,
				check: () => Promise.resolve({ kind: 'rejected', status: 403 })
			})
		).toStrictEqual(pair);
	});

	it('verifies a re-entered pair before accepting it', async () => {
		const replacement = {
			accessKeyId: 'e'.repeat(32),
			secretAccessKey: 'f'.repeat(64)
		};
		const ui = scriptedUi({
			menuChoices: ['reenter'],
			textEdits: [{ kind: 'set', value: replacement.accessKeyId }],
			secrets: [replacement.secretAccessKey]
		});

		const verified = await verifyR2Credentials({
			...base,
			ui,
			check: ({ credentials }) =>
				Promise.resolve(
					credentials.accessKeyId === replacement.accessKeyId
						? { kind: 'valid' }
						: { kind: 'rejected', status: 403 }
				)
		});

		expect(verified).toStrictEqual(replacement);
	});

	it('cancels cleanly from the rejection menu', async () => {
		const ui = scriptedUi({ menuChoices: ['cancel'] });

		expect(
			await verifyR2Credentials({
				...base,
				ui,
				check: () => Promise.resolve({ kind: 'rejected', status: 403 })
			})
		).toBeUndefined();
	});

	it('is fatal without a terminal', async () => {
		const ui = scriptedUi({});

		const outcome = await verifyR2Credentials({
			...base,
			interactive: false,
			ui,
			check: () => Promise.resolve({ kind: 'rejected', status: 403 })
		}).then(
			(credentials) => ({ credentials }),
			(error_: unknown) => {
				expect(error_).toBeInstanceOf(R2CredentialsRejectedError);

				if (error_ instanceof R2CredentialsRejectedError) {
					return {
						error: {
							name: error_.name,
							status: error_.status
						}
					};
				}

				throw error_;
			}
		);

		expect(outcome).toStrictEqual({
			error: {
				name: R2CredentialsRejectedError.name,
				status: 403
			}
		});
	});
});
