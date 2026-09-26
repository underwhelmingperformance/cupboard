import { localStep } from '@cupboard/protocol/deployment';
import {
	oidcAudienceSchema,
	oidcIssuerSchema,
	oidcSubjectSchema
} from '@cupboard/protocol/oidc';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { type Audience, audienceSchema } from '../audience.ts';
import type { TokenProvider } from '../client/credentials.ts';
import {
	CupboardHttpError,
	OwnerLoginRequiredError,
	UnreachableHostError
} from '../errors.ts';

import {
	type AdminAccess,
	adminAccessFor,
	AdminControlWorkerMissingError,
	type AdminCredentialSources,
	AdminDatabaseMismatchError,
	AdminTokenRequiredError,
	type AuthorityApi,
	type DeployAuthority,
	establishAuthority,
	removeLeftoverClaimSecret,
	tenantMigratorFor,
	withClaimSecret
} from './authority.ts';
import {
	AccountOptionRequiredError,
	AudienceWithoutGithubOidcError,
	chooseDeployAccount,
	claimServerFault,
	deployAndOnboard,
	DeployCancelledError,
	type DeployCliOptions,
	DeploymentUnclaimedError,
	envR2Credentials,
	FirstCacheAccessRequiredError,
	isVersionServed,
	obtainR2Credentials,
	outroBeforeReady,
	planMenuEntries,
	type PlanReviewWorld,
	type PlanState,
	R2CredentialsRejectedError,
	type R2KeyAction,
	r2KeyActionFor,
	requireFirstCacheAccess,
	requireGithubOidcForAudience,
	reviewPlan,
	unclaimedFirstCacheNote,
	verifyR2Credentials
} from './command.ts';
import { parseDeploymentConfig } from './config.ts';
import { collectResources } from './deploy-run.ts';
import type { StartingPlan } from './existing-deployment.ts';
import {
	cloudflareAccountIdSchema,
	databaseIdSchema,
	scriptNameSchema
} from './identifiers.ts';
import { DeploymentClaimFailedError, type OnboardOutcome } from './onboard.ts';
import { renameResource } from './overrides.ts';
import { type Claimant, claimantLabel, type OwnerBinding } from './owner.ts';
import {
	r2AccessKeyIdSchema,
	type R2CredentialCheck,
	type R2Credentials,
	r2SecretAccessKeySchema
} from './r2-credentials.ts';
import { TokenManagementNotPermittedError } from './r2-token.ts';
import { claimSecretSchema } from './secrets.ts';
import type { DeployUi, TextEdit } from './ui.ts';

function principal(
	issuer: string,
	subject: string,
	audience: string
): Required<OwnerBinding> {
	return {
		issuer: oidcIssuerSchema.parse(issuer),
		subject: oidcSubjectSchema.parse(subject),
		audience: oidcAudienceSchema.parse(audience)
	};
}

const firstClaimant: Claimant = {
	...principal('https://dash.cloudflare.com', 'cf-user-1', 'cupboard-client'),
	displayName: undefined
};

const accountId = (value: string) => cloudflareAccountIdSchema.parse(value);

const credentialPair = (id: string, secret: string): R2Credentials => ({
	accessKeyId: r2AccessKeyIdSchema.parse(id),
	secretAccessKey: r2SecretAccessKeySchema.parse(secret)
});

const accounts = [
	{ id: accountId('acc-1'), name: 'Personal' },
	{ id: accountId('acc-2'), name: 'Work' }
];

const config = parseDeploymentConfig(
	`{
		"name": "cupboard",
		"compatibility_date": "2026-05-15",
		"r2_buckets": [{ "binding": "BLOBS", "bucket_name": "cupboard-blobs" }],
		"d1_databases": [{ "binding": "CUPBOARD_DB", "database_name": "cupboard" }],
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

function pickerUi(choice?: string, uiCalls: UiCall[] = []): DeployUi {
	return {
		interactive: true,
		intro: recordUiCall(uiCalls, 'intro'),
		outro: recordUiCall(uiCalls, 'outro'),
		cancelled: recordUiCall(uiCalls, 'cancelled'),
		info: recordUiCall(uiCalls, 'info'),
		success: recordUiCall(uiCalls, 'success'),
		step: recordUiCall(uiCalls, 'step'),
		warn: recordUiCall(uiCalls, 'warn'),
		note: recordUiCall(uiCalls, 'note'),
		data: recordUiCall(uiCalls, 'data'),
		confirm: () => {
			uiCalls.push({ method: 'confirm' });

			return Promise.resolve('no');
		},
		menu: () => {
			uiCalls.push({ method: 'menu' });

			return Promise.resolve(absentValues.choice);
		},
		multiSelect: () => Promise.resolve(undefined),
		editText: () => {
			uiCalls.push({ method: 'editText' });

			return Promise.resolve({ kind: 'cancelled' });
		},
		prefixedText: () => {
			uiCalls.push({ method: 'prefixedText' });

			return Promise.resolve(absentString());
		},
		secret: () => {
			uiCalls.push({ method: 'secret' });

			return Promise.resolve(absentString());
		},
		chooseAccount: () => {
			uiCalls.push({ method: 'chooseAccount' });

			return Promise.resolve(
				choice === undefined ? undefined : accountId(choice)
			);
		},
		openBrowser: recordUiCall(uiCalls, 'openBrowser'),
		reporter: () => ({
			phase: (_label, body) =>
				Promise.resolve(
					body({
						fact: recordUiCall(uiCalls, 'fact'),
						warn: recordUiCall(uiCalls, 'reporter.warn')
					})
				),
			progress: (_label, _options, body) =>
				Promise.resolve(
					body({
						advance: recordUiCall(uiCalls, 'reporter.progress.advance'),
						fact: recordUiCall(uiCalls, 'reporter.progress.fact'),
						warn: recordUiCall(uiCalls, 'reporter.warn')
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
						}),
						warn: recordUiCall(uiCalls, 'reporter.warn')
					})
				),
			result: recordUiCall(uiCalls, 'result'),
			data: recordUiCall(uiCalls, 'reporter.data'),
			warn: recordUiCall(uiCalls, 'reporter.warn'),
			info: recordUiCall(uiCalls, 'reporter.info'),
			success: recordUiCall(uiCalls, 'reporter.success'),
			step: recordUiCall(uiCalls, 'reporter.step'),
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
						},
						warn: (label, value) => {
							warnings.push(value === undefined ? label : `${label}: ${value}`);
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
						},
						warn: (label, value) => {
							warnings.push(value === undefined ? label : `${label}: ${value}`);
						}
					})
				),
			steps: (_label, body) =>
				Promise.resolve(
					body({
						message: () => {
							return;
						},
						warn: (label, value) => {
							warnings.push(value === undefined ? label : `${label}: ${value}`);
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
			success: (message) => {
				infos.push(message);
			},
			step: (message) => {
				infos.push(message);
			},
			error: () => {
				return;
			}
		}),
		menu: (_message, entries) => {
			const taken = menuChoices.length > 0 ? [menuChoices.shift()] : [];
			const [scripted] = z.array(z.string().optional()).length(1).parse(taken);

			if (scripted === undefined) {
				return Promise.resolve(absentValues.choice);
			}

			const choice = z
				.custom<(typeof entries)[number]['value']>(
					(value) => value === scripted
				)
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
			const taken = secrets.length > 0 ? [secrets.shift()] : [];
			const [secret] = z.array(z.string().optional()).length(1).parse(taken);

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

		const resolveOutcome = async (): Promise<
			{ choice: unknown } | { error: { name: string } }
		> => {
			try {
				const choice = await chooseDeployAccount(
					pickerUi(undefined, uiCalls),
					accounts,
					true
				);

				return { choice };
			} catch (error_: unknown) {
				expect(error_).toBeInstanceOf(DeployCancelledError);

				if (error_ instanceof DeployCancelledError) {
					return { error: { name: error_.name } };
				}

				throw error_;
			}
		};

		const outcome = await resolveOutcome();

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

describe('planMenuEntries', () => {
	it('lists Deploy first, every editable value, then Cancel', () => {
		const state: PlanState = {
			accountId: accountId('acc-1'),
			domain: undefined,
			config
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
			{ value: 'cancel', label: 'Cancel' }
		]);
	});

	it('offers replacing the R2 credentials, after the bucket, when already set', () => {
		const base: PlanState = {
			accountId: accountId('acc-1'),
			domain: undefined,
			config
		};

		const keepEntries = planMenuEntries(base, true);
		const bucketIndex = keepEntries.findIndex(
			(entry) => entry.value === 'bucket:cupboard-blobs'
		);

		expect({
			omittedByDefault: planMenuEntries(base).some(
				(entry) => entry.value === 'r2-credentials'
			),
			keepEntry: keepEntries[bucketIndex + 1],
			replaceEntry: planMenuEntries(
				{ ...base, replaceR2Credentials: true },
				true
			)[bucketIndex + 1]
		}).toStrictEqual({
			omittedByDefault: false,
			keepEntry: {
				value: 'r2-credentials',
				label: 'R2 credentials',
				hint: 'keep the current key'
			},
			replaceEntry: {
				value: 'r2-credentials',
				label: 'R2 credentials',
				hint: 'replace the current key'
			}
		});
	});
});

describe('reviewPlan', () => {
	const initial: PlanState = {
		accountId: accountId('acc-1'),
		domain: undefined,
		config
	};

	function world(
		ui: DeployUi,
		options?: {
			readonly skipReview?: boolean;
			readonly canReplaceR2Credentials?: boolean;
			readonly startingPlan?: StartingPlan;
			readonly requestedDomain?: string;
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
				skipReview: options?.skipReview ?? false,
				startingPlanFor: () =>
					Promise.resolve(
						options?.startingPlan ?? { config, routedDomain: undefined }
					),
				requestedDomain: options?.requestedDomain,
				...(options?.canReplaceR2Credentials !== undefined && {
					canReplaceR2Credentials: () =>
						Promise.resolve(options.canReplaceR2Credentials ?? false)
				})
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

	it.each<[string, string | undefined, string | undefined, string | undefined]>(
		[
			[
				"uses the custom domain routed to the other account's control Worker",
				'cache.example.net',
				undefined,
				'cache.example.net'
			],
			[
				"clears the domain when the other account's control Worker has no custom domain",
				undefined,
				undefined,
				undefined
			],
			[
				'keeps the domain given with `--domain`',
				'cache.example.net',
				'flag.example.com',
				'flag.example.com'
			]
		]
	)(
		"restarts from the other account's deployment and %s",
		async (_name, routedDomain, requestedDomain, expectedDomain) => {
			const other = renameResource(config, 'bucket', 'cupboard-blobs', 'other');
			const { world: w } = world(
				scriptedUi({
					menuChoices: ['account', 'deploy'],
					accountChoice: 'acc-2'
				}),
				{
					startingPlan: { config: other, routedDomain },
					...(requestedDomain !== undefined && { requestedDomain })
				}
			);

			expect(
				await reviewPlan({ ...initial, domain: 'cache.example.com' }, w)
			).toStrictEqual({
				...initial,
				accountId: 'acc-2',
				domain: expectedDomain,
				config: other
			});
		}
	);

	it('discards a requested R2 credentials replacement when switching account', async () => {
		const { world: w } = world(
			scriptedUi({
				menuChoices: ['account', 'deploy'],
				accountChoice: 'acc-2'
			})
		);

		expect(
			await reviewPlan({ ...initial, replaceR2Credentials: true }, w)
		).toStrictEqual({ ...initial, accountId: 'acc-2' });
	});

	it('keeps the edits when the same account is chosen again', async () => {
		const edited: PlanState = {
			...initial,
			domain: 'cache.example.com',
			config: renameResource(config, 'bucket', 'cupboard-blobs', 'mine'),
			replaceR2Credentials: true
		};
		const { world: w } = world(
			scriptedUi({
				menuChoices: ['account', 'deploy'],
				accountChoice: 'acc-1'
			})
		);

		expect(await reviewPlan(edited, w)).toStrictEqual(edited);
	});

	it('rejects an empty cron trigger list', async () => {
		const offered: Parameters<DeployUi['editText']>[0][] = [];
		const ui: DeployUi = {
			...scriptedUi({ menuChoices: ['crons', 'deploy'] }),
			editText: (options) => {
				offered.push(options);

				return Promise.resolve({ kind: 'cancelled' });
			}
		};
		const { world: w } = world(ui);

		await reviewPlan(initial, w);

		expect(
			offered.map((options) => ({
				emptyClears: options.emptyClears,
				acceptsBlank: options.problem?.('  ') === undefined
			}))
		).toStrictEqual([{ emptyClears: undefined, acceptsBlank: false }]);
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

	it('records a request to replace the R2 credentials', async () => {
		const { world: w } = world(
			scriptedUi({ menuChoices: ['r2-credentials', 'replace', 'deploy'] }),
			{ canReplaceR2Credentials: true }
		);

		expect(await reviewPlan(initial, w)).toStrictEqual({
			...initial,
			replaceR2Credentials: true
		});
	});

	it('keeps the R2 credentials when that is chosen in the submenu', async () => {
		const { world: w } = world(
			scriptedUi({ menuChoices: ['r2-credentials', 'keep', 'deploy'] }),
			{ canReplaceR2Credentials: true }
		);

		expect(await reviewPlan(initial, w)).toStrictEqual({
			...initial,
			replaceR2Credentials: false
		});
	});
});

describe('r2KeyActionFor', () => {
	const existing = renameResource(
		config,
		'bucket',
		'cupboard-blobs',
		'my-blobs'
	);
	const renamed = renameResource(existing, 'bucket', 'my-blobs', 'newer');

	it.each<[string, Parameters<typeof r2KeyActionFor>[0], R2KeyAction]>([
		[
			'keeps the credentials when the plan keeps the existing bucket',
			{
				isAlreadySet: true,
				isReplaceRequested: false,
				existing,
				agreed: existing
			},
			{ kind: 'keep' }
		],
		[
			'offers to keep the credentials when the plan renames the existing bucket',
			{
				isAlreadySet: true,
				isReplaceRequested: false,
				existing,
				agreed: renamed
			},
			{ kind: 'obtain', keep: { previousBucket: 'my-blobs' } }
		],
		[
			'obtains credentials when the Worker has none',
			{
				isAlreadySet: false,
				isReplaceRequested: false,
				existing,
				agreed: existing
			},
			{ kind: 'obtain' }
		],
		[
			'obtains credentials when a replacement was requested',
			{
				isAlreadySet: true,
				isReplaceRequested: true,
				existing,
				agreed: existing
			},
			{ kind: 'obtain' }
		]
	])('%s', (_name, options, expected) => {
		expect(r2KeyActionFor(options)).toStrictEqual(expected);
	});
});

describe('R2 credential settlement', () => {
	const pair = credentialPair('a'.repeat(32), 'b'.repeat(64));
	const created = credentialPair('c'.repeat(32), 'd'.repeat(64));

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
			accountId: accountId('acc-1'),
			bucketName: 'cupboard-blobs',
			creation: {
				kind: 'available',
				isBucketPresent: true,
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
				accountId: accountId('acc-1'),
				bucketName: 'cupboard-blobs',
				creation: {
					kind: 'available',
					isBucketPresent: true,
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
			accountId: accountId('acc-1'),
			bucketName: 'cupboard-blobs',
			creation: {
				kind: 'available',
				isBucketPresent: true,
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
			accountId: accountId('acc-1'),
			bucketName: 'pantry',
			creation: {
				kind: 'available',
				isBucketPresent: false,
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
				accountId: accountId('acc-1'),
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
				accountId: accountId('acc-1'),
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
			accountId: accountId('acc-1'),
			bucketName: 'cupboard-blobs',
			creation: {
				kind: 'available',
				isBucketPresent: true,
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
	const pair = credentialPair('a'.repeat(32), 'b'.repeat(64));

	const base = {
		interactive: true,
		accountId: accountId('acc-1'),
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
				const taken = checks.length > 0 ? [checks.shift()] : [];
				const [check] = z.tuple([z.custom<R2CredentialCheck>()]).parse(taken);

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
		const replacement = credentialPair('e'.repeat(32), 'f'.repeat(64));
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

		const resolveOutcome = async (): Promise<
			{ credentials: unknown } | { error: { name: string; status: number } }
		> => {
			try {
				const credentials = await verifyR2Credentials({
					...base,
					interactive: false,
					ui,
					check: () => Promise.resolve({ kind: 'rejected', status: 403 })
				});

				return { credentials };
			} catch (error_: unknown) {
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
		};

		const outcome = await resolveOutcome();

		expect(outcome).toStrictEqual({
			error: {
				name: R2CredentialsRejectedError.name,
				status: 403
			}
		});
	});
});

describe('withClaimSecret', () => {
	const options = {
		domain: undefined,
		secrets: {
			control: [{ name: 'CONTROL_KEY_WRAP_SECRET', text: 'wrap' }],
			tenant: [{ name: 'R2_BUCKET_NAME', text: 'cupboard-blobs' }]
		}
	};
	const adminAccess = {
		credentialFor: (): TokenProvider => ({
			get: () => Promise.resolve('admin-jwt'),
			refresh: () => Promise.resolve('admin-jwt')
		}),
		storedSessionFor: () => Promise.resolve(undefined)
	};

	it.each<[string, DeployAuthority, typeof options]>([
		[
			'adds the claim secret to the control Worker on a first deploy',
			{
				kind: 'bootstrap',
				claimSecret: claimSecretSchema.parse('claim-1'),
				idToken: () => Promise.resolve('id-token-1'),
				claimant: firstClaimant
			},
			{
				...options,
				secrets: {
					...options.secrets,
					control: [
						...options.secrets.control,
						{ name: 'CUPBOARD_SIGNUP_SECRET', text: 'claim-1' }
					]
				}
			}
		],
		[
			'leaves the options unchanged on an update',
			{
				kind: 'admin',
				admin: principal('https://idp.example', 'a', 'c'),
				access: adminAccess
			},
			options
		],
		[
			'leaves the options unchanged on an unclaimed deploy',
			{ kind: 'unclaimed' },
			options
		]
	])('%s', (_name, authority, expected) => {
		expect(withClaimSecret(options, authority)).toStrictEqual(expected);
	});
});

function labelledProvider(label: string): TokenProvider {
	return {
		get: () => Promise.resolve(label),
		refresh: () => Promise.resolve(label)
	};
}

/**
 * Credential sources that record each call and return a provider whose token
 * shows which source created it and for which origin.
 */
function recordingSources(): {
	readonly calls: string[];
	readonly sources: AdminCredentialSources;
} {
	const calls: string[] = [];

	return {
		calls,
		sources: {
			session: (url) => {
				calls.push(`session:${url.href}`);
				return labelledProvider(`session:${url.origin}`);
			},
			storedSession: (url) => {
				calls.push(`storedSession:${url.href}`);
				return Promise.resolve({ accessToken: `stored:${url.origin}` });
			},
			githubOidc: (url, audience: Audience) => {
				calls.push(`githubOidc:${url.href}:${audience}`);
				return labelledProvider(`github:${url.origin}`);
			}
		}
	};
}

async function rejectionOf(pending: Promise<unknown>): Promise<unknown> {
	try {
		await pending;
	} catch (error) {
		return error;
	}

	return undefined;
}

// The value that `pending` resolves to, or the error that it rejects with.
async function settled(pending: Promise<unknown>): Promise<unknown> {
	try {
		return await pending;
	} catch (error) {
		return error;
	}
}

describe('adminAccessFor', () => {
	const deployment = new URL('https://cupboard.example.workers.dev');
	const sameOrigin = new URL('https://cupboard.example.workers.dev/t/builds');

	it.each([
		{
			name: 'the cached session',
			options: {},
			tokens: ['session:https://cupboard.example.workers.dev'],
			stored: { accessToken: 'stored:https://cupboard.example.workers.dev' },
			calls: [
				'session:https://cupboard.example.workers.dev/',
				'storedSession:https://cupboard.example.workers.dev/'
			]
		},
		{
			name: 'a CI token for the deployment URL',
			options: { githubOidc: true },
			tokens: ['github:https://cupboard.example.workers.dev'],
			stored: undefined,
			calls: [
				'githubOidc:https://cupboard.example.workers.dev/:https://cupboard.example.workers.dev'
			]
		},
		{
			name: 'a CI token for --audience',
			options: {
				githubOidc: true,
				audience: audienceSchema.parse('cupboard-ci')
			},
			tokens: ['github:https://cupboard.example.workers.dev'],
			stored: undefined,
			calls: ['githubOidc:https://cupboard.example.workers.dev/:cupboard-ci']
		}
	])(
		'uses $name, with one provider for each origin',
		async ({ options, tokens, stored, calls: expectedCalls }) => {
			const { calls, sources } = recordingSources();
			const access = adminAccessFor(options, sources)(deployment);

			const first = access.credentialFor(deployment);
			const second = access.credentialFor(sameOrigin);

			expect({
				isSameProvider: first === second,
				tokens: [await first.get()],
				stored: await access.storedSessionFor(deployment),
				calls
			}).toStrictEqual({
				isSameProvider: true,
				tokens,
				stored,
				calls: expectedCalls
			});
		}
	);
});

function describeResult(result: unknown): unknown {
	if (result instanceof AdminTokenRequiredError) {
		return {
			kind: 'admin-token',
			admin: result.admin,
			url: result.url.href
		};
	}

	if (result instanceof AdminDatabaseMismatchError) {
		return {
			kind: 'database',
			boundDatabase: result.boundDatabase,
			plannedDatabase: result.plannedDatabase
		};
	}

	if (result instanceof AdminControlWorkerMissingError) {
		return { kind: 'control-worker', admin: result.admin };
	}

	return result;
}

describe('establishAuthority', () => {
	const deployedConfig = parseDeploymentConfig(
		`{
			"name": "cupboard",
			"compatibility_date": "2026-05-15",
			"d1_databases": [{ "binding": "CUPBOARD_DB", "database_name": "cupboard" }]
		}`,
		`{
			"name": "cupboard-tenant",
			"compatibility_date": "2026-05-15",
			"d1_databases": [{ "binding": "CUPBOARD_DB", "database_name": "cupboard" }]
		}`
	);
	const admin = principal(
		'https://dash.cloudflare.com',
		'cf-user-1',
		'cupboard-client'
	);

	/**
	 * A Cloudflare account whose `cupboard` database has an admin and whose
	 * `fresh` database has none. The Workers are bound to `cupboard`, and the
	 * control Worker has `recordedUrl` as its recorded deployment URL when that
	 * is given. With `isControlDeleted`, only the tenant Worker exists. Every
	 * read is recorded.
	 */
	function claimedAccount(
		calls: string[],
		options: {
			readonly routedDomain?: string;
			readonly recordedUrl?: string;
			readonly isControlDeleted?: boolean;
		} = {}
	): AuthorityApi {
		const claimedId = databaseIdSchema.parse('cupboard-id');
		const freshId = databaseIdSchema.parse('fresh-id');

		return {
			findD1Database: (name) => {
				calls.push(`findD1Database:${name}`);
				return Promise.resolve(name === 'cupboard' ? claimedId : freshId);
			},
			findD1DatabaseName: (id) => {
				calls.push(`findD1DatabaseName:${id}`);
				return Promise.resolve(id === claimedId ? 'cupboard' : 'fresh');
			},
			d1QueryRows: (id, sql) => {
				calls.push(`d1QueryRows:${id}`);

				if (sql.includes('pragma_table_info')) {
					return Promise.resolve(['issuer', 'subject', 'audience']);
				}

				return Promise.resolve(
					id === claimedId
						? [JSON.stringify([admin.issuer, admin.subject, admin.audience])]
						: []
				);
			},
			findCustomDomain: () => {
				calls.push('findCustomDomain');
				return Promise.resolve(options.routedDomain);
			},
			getWorkersDevSubdomain: () => {
				calls.push('getWorkersDevSubdomain');
				return Promise.resolve('example');
			},
			getScriptConfiguration: (scriptName) => {
				calls.push(`getScriptConfiguration:${scriptName}`);

				if (scriptName === 'cupboard' && options.isControlDeleted === true) {
					return Promise.resolve(undefined);
				}

				return Promise.resolve({
					bindings: [
						{ type: 'd1', name: 'CUPBOARD_DB', database_id: claimedId },
						...(options.recordedUrl === undefined
							? []
							: [
									{
										type: 'plain_text',
										name: 'CUPBOARD_DEPLOYMENT_URL',
										text: options.recordedUrl
									}
								])
					],
					cacheEnabled: false,
					crossVersionCache: false
				});
			}
		};
	}

	const freshDatabaseName: TextEdit = { kind: 'set', value: 'fresh' };

	it.each([
		{
			name: 'the deployed database, without an admin token',
			menuChoices: ['deploy'],
			textEdits: [],
			result: {
				kind: 'admin-token',
				admin,
				url: 'https://cupboard.example.workers.dev/'
			},
			calls: [
				'getScriptConfiguration:cupboard',
				'findD1DatabaseName:cupboard-id',
				'findD1Database:cupboard',
				'd1QueryRows:cupboard-id',
				'd1QueryRows:cupboard-id',
				'findCustomDomain',
				'getWorkersDevSubdomain'
			]
		},
		{
			name: 'another database selected in the plan',
			menuChoices: ['database:cupboard', 'deploy'],
			textEdits: [freshDatabaseName],
			result: {
				kind: 'database',
				boundDatabase: 'cupboard',
				plannedDatabase: 'fresh'
			},
			calls: [
				'getScriptConfiguration:cupboard',
				'findD1DatabaseName:cupboard-id',
				'findD1Database:fresh',
				'd1QueryRows:fresh-id',
				'd1QueryRows:fresh-id',
				'd1QueryRows:cupboard-id',
				'd1QueryRows:cupboard-id'
			]
		}
	])(
		'reads the admin of a claimed deployment from both databases, with $name',
		async ({
			menuChoices,
			textEdits,
			result: expectedResult,
			calls: expectedCalls
		}) => {
			const ui = scriptedUi({ menuChoices, textEdits });
			const agreed = z
				.custom<PlanState>((value) => value !== undefined)
				.parse(
					await reviewPlan(
						{
							accountId: accountId('acc-1'),
							domain: undefined,
							config: deployedConfig
						},
						{
							ui,
							render: () => Promise.resolve(),
							accounts: () => Promise.resolve(accounts),
							skipReview: false,
							startingPlanFor: () =>
								Promise.resolve({
									config: deployedConfig,
									routedDomain: undefined
								}),
							requestedDomain: undefined
						}
					)
				);
			const calls: string[] = [];

			const result = await settled(
				establishAuthority(
					{ agreed },
					{
						ui,
						api: claimedAccount(calls),
						adminAccess: () => ({
							credentialFor: () => ({
								get: () => Promise.reject(new OwnerLoginRequiredError()),
								refresh: () => Promise.reject(new OwnerLoginRequiredError())
							}),
							storedSessionFor: () => Promise.resolve(undefined)
						}),
						checkAdmin: () => {
							calls.push('checkAdmin');
							return Promise.resolve();
						},
						idToken: () => {
							calls.push('login');
							return Promise.resolve('id-token-1');
						},
						servesCupboard: () => Promise.resolve(true),
						confirmClaim: () => {
							calls.push('confirmClaim');
							return Promise.resolve(true);
						},
						interactive: true
					}
				)
			);

			expect({
				agreedDatabase: collectResources(agreed.config).d1Databases,
				result: describeResult(result),
				// Only reads ran. The run did not log in or create a claim secret.
				calls
			}).toStrictEqual({
				agreedDatabase: [menuChoices.length > 1 ? 'fresh' : 'cupboard'],
				result: expectedResult,
				calls: expectedCalls
			});
		}
	);

	it('takes the current URL from the deployment record, not from a domain routed in the dashboard', async () => {
		const calls: string[] = [];
		const accessBases: string[] = [];
		const wildcardToken = `e30.${Buffer.from(
			JSON.stringify({ authorization_details: [{ type: 'cupboard_wildcard' }] })
		).toString('base64url')}.signature`;

		const authority = await establishAuthority(
			{
				agreed: { config: deployedConfig, domain: 'cache.example.com' }
			},
			{
				ui: pickerUi(),
				api: claimedAccount(calls, {
					routedDomain: 'cache.example.com',
					recordedUrl: 'https://cupboard.example.workers.dev'
				}),
				adminAccess: (deploymentUrl) => {
					accessBases.push(deploymentUrl.href);

					return {
						credentialFor: () => ({
							get: () => Promise.resolve(wildcardToken),
							refresh: () => Promise.resolve(wildcardToken)
						}),
						storedSessionFor: () => Promise.resolve(undefined)
					};
				},
				checkAdmin: (url) => {
					calls.push(`checkAdmin:${url.href}`);
					return Promise.resolve();
				},
				idToken: () => Promise.reject(new Error('no login expected')),
				servesCupboard: (url) => {
					calls.push(`servesCupboard:${url.href}`);
					return Promise.resolve(true);
				},
				confirmClaim: () => Promise.resolve(true),
				interactive: false
			}
		);

		expect({
			kind: authority.kind,
			accessBases,
			checks: calls.filter(
				(call) =>
					call.startsWith('checkAdmin') ||
					call.startsWith('servesCupboard') ||
					call === 'findCustomDomain'
			)
		}).toStrictEqual({
			kind: 'admin',
			accessBases: ['https://cupboard.example.workers.dev/'],
			checks: [
				'checkAdmin:https://cupboard.example.workers.dev/',
				'servesCupboard:https://cache.example.com/',
				'checkAdmin:https://cache.example.com/'
			]
		});
	});

	it.each([
		{
			name: 'another database in the plan',
			database: 'fresh',
			result: {
				kind: 'database',
				boundDatabase: 'cupboard',
				plannedDatabase: 'fresh'
			}
		},
		{
			name: 'the same database in the plan',
			database: 'cupboard',
			result: { kind: 'control-worker', admin }
		}
	])(
		"reads the admin from the tenant Worker's database when the control Worker was deleted, with $name",
		async ({ database, result: expectedResult }) => {
			const config = parseDeploymentConfig(
				`{
					"name": "cupboard",
					"compatibility_date": "2026-05-15",
					"d1_databases": [{ "binding": "CUPBOARD_DB", "database_name": "${database}" }]
				}`,
				`{
					"name": "cupboard-tenant",
					"compatibility_date": "2026-05-15",
					"d1_databases": [{ "binding": "CUPBOARD_DB", "database_name": "${database}" }]
				}`
			);
			const calls: string[] = [];

			const result = await settled(
				establishAuthority(
					{ agreed: { config, domain: undefined } },
					{
						ui: pickerUi(),
						api: claimedAccount(calls, { isControlDeleted: true }),
						adminAccess: () => updateAccess,
						checkAdmin: () => {
							calls.push('checkAdmin');
							return Promise.resolve();
						},
						idToken: () => {
							calls.push('login');
							return Promise.resolve('id-token-1');
						},
						servesCupboard: () => Promise.resolve(true),
						confirmClaim: () => Promise.resolve(true),
						interactive: true
					}
				)
			);

			expect({
				result: describeResult(result),
				calls: calls.filter(
					(call) =>
						call.startsWith('getScriptConfiguration') ||
						call === 'login' ||
						call === 'checkAdmin'
				)
			}).toStrictEqual({
				result: expectedResult,
				calls: [
					'getScriptConfiguration:cupboard',
					'getScriptConfiguration:cupboard-tenant'
				]
			});
		}
	);
});

const updateAccess: AdminAccess = {
	credentialFor: () => labelledProvider('admin-jwt'),
	storedSessionFor: () => Promise.resolve(undefined)
};
const updateAuthority: DeployAuthority = {
	kind: 'admin',
	admin: principal('https://idp.example.test', 'a', 'c'),
	access: updateAccess
};
const bootstrapAuthority: DeployAuthority = {
	kind: 'bootstrap',
	claimSecret: claimSecretSchema.parse('claim-1'),
	idToken: () => Promise.resolve('id-token-1'),
	claimant: firstClaimant
};
const unclaimedAuthority: DeployAuthority = { kind: 'unclaimed' };

type FirstCacheOptions = Pick<DeployCliOptions, 'cache' | 'access'>;

describe('requireFirstCacheAccess', () => {
	it.each([
		{
			name: 'with --cache and --access',
			options: {
				cache: 'builds',
				access: 'public'
			} satisfies FirstCacheOptions,
			interactive: false,
			isRefused: false
		},
		{
			name: 'with --cache alone',
			options: { cache: 'builds' },
			interactive: false,
			isRefused: true
		},
		{
			name: 'with --cache alone at a terminal',
			options: { cache: 'builds' },
			interactive: true,
			isRefused: false
		},
		{
			name: 'without --cache',
			options: {},
			interactive: false,
			isRefused: false
		}
	])('checks a run $name', ({ options, interactive, isRefused }) => {
		let refusal: unknown;

		try {
			requireFirstCacheAccess(options, interactive);
		} catch (error) {
			refusal = error;
		}

		if (isRefused) {
			expect(refusal).toBeInstanceOf(FirstCacheAccessRequiredError);
		} else {
			expect(refusal).toBeUndefined();
		}
	});
});

describe('unclaimedFirstCacheNote', () => {
	it.each([
		{
			name: 'an unclaimed run with --cache',
			authority: unclaimedAuthority,
			options: { cache: 'builds' },
			hasNote: true
		},
		{
			name: 'an unclaimed run with --access',
			authority: unclaimedAuthority,
			options: { access: 'private' } satisfies FirstCacheOptions,
			hasNote: true
		},
		{
			name: 'an unclaimed run without either',
			authority: unclaimedAuthority,
			options: {},
			hasNote: false
		},
		{
			name: 'a first deploy at a terminal',
			authority: bootstrapAuthority,
			options: { cache: 'builds' },
			hasNote: false
		},
		{
			name: 'an update',
			authority: updateAuthority,
			options: { cache: 'builds' },
			hasNote: false
		}
	])(
		'returns the ignored-options note only for an unclaimed run ($name)',
		({ authority, options, hasNote }) => {
			const note = unclaimedFirstCacheNote(authority, options);

			if (hasNote) {
				expect({
					mentionsCache: note?.includes('--cache'),
					mentionsAccess: note?.includes('--access')
				}).toStrictEqual({ mentionsCache: true, mentionsAccess: true });
			} else {
				expect(note).toBeUndefined();
			}
		}
	);
});

describe('tenantMigratorFor', () => {
	it.each([
		{ name: 'a first deploy', authority: bootstrapAuthority },
		{ name: 'an unclaimed deploy', authority: unclaimedAuthority }
	])('migrates no tenants on $name', ({ authority }) => {
		expect(
			tenantMigratorFor(authority, () => Promise.resolve())
		).toBeUndefined();
	});

	it('migrates tenants on an update with its admin access', async () => {
		const steps: unknown[] = [];
		const migrate = tenantMigratorFor(updateAuthority, (access, step) => {
			steps.push({
				isUpdateAccess: access === updateAccess,
				step
			});
			return Promise.resolve();
		});

		await migrate?.(localStep(3));

		expect(steps).toStrictEqual([{ isUpdateAccess: true, step: localStep(3) }]);
	});
});

describe('removeLeftoverClaimSecret', () => {
	it.each([
		{
			name: 'an update with a leftover secret',
			authority: updateAuthority,
			secrets: ['CUPBOARD_SIGNUP_SECRET'],
			deleted: ['cupboard:CUPBOARD_SIGNUP_SECRET'],
			reads: 1
		},
		{
			name: 'an update without a leftover secret',
			authority: updateAuthority,
			secrets: ['CONTROL_KEY_WRAP_SECRET'],
			deleted: [],
			reads: 1
		},
		{
			name: 'a first deploy',
			authority: bootstrapAuthority,
			secrets: ['CUPBOARD_SIGNUP_SECRET'],
			deleted: [],
			reads: 0
		},
		{
			name: 'an unclaimed deploy',
			authority: unclaimedAuthority,
			secrets: ['CUPBOARD_SIGNUP_SECRET'],
			deleted: ['cupboard:CUPBOARD_SIGNUP_SECRET'],
			reads: 1
		}
	])(
		'removes a leftover claim secret except on a first deploy ($name)',
		async ({
			authority,
			secrets,
			deleted: expectedDeleted,
			reads: expectedReads
		}) => {
			const deleted: string[] = [];
			let reads = 0;

			await removeLeftoverClaimSecret(authority, {
				ui: pickerUi(),
				api: {
					deleteSecret: (scriptName, name) => {
						deleted.push(`${scriptName}:${name}`);
						return Promise.resolve();
					}
				},
				controlScriptName: scriptNameSchema.parse('cupboard'),
				controlSecrets: () => {
					reads += 1;
					return Promise.resolve(secrets);
				}
			});

			expect({ deleted, reads }).toStrictEqual({
				deleted: expectedDeleted,
				reads: expectedReads
			});
		}
	);
});

describe('removeLeftoverClaimSecret failures', () => {
	it('warns and continues when the leftover secret cannot be removed', async () => {
		const warnings: string[] = [];

		await removeLeftoverClaimSecret(updateAuthority, {
			ui: {
				...pickerUi(),
				warn: (message) => {
					warnings.push(message);
				}
			},
			api: {
				deleteSecret: () =>
					Promise.reject(new Error('Cloudflare is unavailable'))
			},
			controlScriptName: scriptNameSchema.parse('cupboard'),
			controlSecrets: () => Promise.resolve(['CUPBOARD_SIGNUP_SECRET'])
		});

		expect({
			count: warnings.length,
			namesSecret: warnings[0]?.includes('CUPBOARD_SIGNUP_SECRET'),
			namesWorker: warnings[0]?.includes('cupboard')
		}).toStrictEqual({ count: 1, namesSecret: true, namesWorker: true });
	});
});

describe('requireGithubOidcForAudience', () => {
	it.each([
		{
			name: '--audience with --github-oidc',
			options: { audience: audienceSchema.parse('ci'), githubOidc: true },
			isRefused: false
		},
		{
			name: '--audience alone',
			options: { audience: audienceSchema.parse('ci') },
			isRefused: true
		},
		{ name: 'neither option', options: {}, isRefused: false }
	])('checks a run with $name', ({ options, isRefused }) => {
		let refusal: unknown;

		try {
			requireGithubOidcForAudience(options);
		} catch (error) {
			refusal = error;
		}

		if (isRefused) {
			expect(refusal).toBeInstanceOf(AudienceWithoutGithubOidcError);
		} else {
			expect(refusal).toBeUndefined();
		}
	});
});

describe('claimantLabel', () => {
	it.each([
		{
			name: 'a display name',
			claimant: {
				...principal('https://dash.cloudflare.com', 'cf-1', 'cupboard-client'),
				displayName: 'ada@example.com'
			},
			label:
				'ada@example.com (issuer https://dash.cloudflare.com, subject cf-1, audience cupboard-client)'
		},
		{
			name: 'no display name',
			claimant: {
				...principal('https://idp.example.test', 'founder', 'cupboard-cli'),
				displayName: undefined
			},
			label:
				'founder (issuer https://idp.example.test, subject founder, audience cupboard-cli)'
		}
	])('shows a claimant with $name', ({ claimant, label }) => {
		expect(claimantLabel(claimant)).toBe(label);
	});
});

describe('isVersionServed', () => {
	const serverError = new CupboardHttpError('GET', '/_version', 503, '');

	it.each([
		{ name: 'a build', version: () => Promise.resolve('v-1'), result: true },
		{
			name: 'an unreachable host',
			version: () =>
				Promise.reject(
					new UnreachableHostError(
						'cache.example.com',
						new TypeError('fetch failed')
					)
				),
			result: false
		},
		{
			name: 'a 404',
			version: () =>
				Promise.reject(new CupboardHttpError('GET', '/_version', 404, '')),
			result: false
		},
		{
			name: 'a server error',
			version: () => Promise.reject(serverError),
			result: serverError
		}
	])('reports $name', async ({ version, result }) => {
		expect(await settled(isVersionServed(version))).toBe(result);
	});
});

describe('outroBeforeReady', () => {
	it.each([
		{
			name: 'fails a first deploy, which leaves the deployment without an admin',
			authority: bootstrapAuthority,
			outro: 'Deployed; the deployment has no admin yet.',
			exitCode: 1
		},
		{
			name: 'succeeds for an update',
			authority: updateAuthority,
			outro: 'Deployed.',
			exitCode: 0
		}
	])('$name', ({ authority, outro, exitCode }) => {
		const outros: string[] = [];

		expect({
			exitCode: outroBeforeReady(
				{
					outro: (message) => {
						outros.push(message);
					}
				},
				authority
			),
			outros
		}).toStrictEqual({ exitCode, outros: [outro] });
	});
});

describe('claimServerFault', () => {
	const url = new URL('https://cache.example.com');

	it.each([
		{
			name: 'a 500',
			error: new DeploymentClaimFailedError(url, 'HTTP 500', 500, 'ray-1'),
			fault: 'from the error'
		},
		{
			name: 'a 409',
			error: new DeploymentClaimFailedError(url, 'HTTP 409', 409, undefined),
			fault: undefined
		},
		{ name: 'another error', error: new Error('boom'), fault: undefined }
	])(
		'returns a log lookup only for a 5xx claim failure ($name)',
		({ error, fault }) => {
			expect(claimServerFault(error)).toStrictEqual(
				fault === undefined
					? undefined
					: { message: error.message, ray: 'ray-1' }
			);
		}
	);
});

describe('establishAuthority on a first deploy', () => {
	const firstConfig = parseDeploymentConfig(
		`{
			"name": "cupboard",
			"compatibility_date": "2026-05-15",
			"d1_databases": [{ "binding": "CUPBOARD_DB", "database_name": "cupboard" }]
		}`,
		`{
			"name": "cupboard-tenant",
			"compatibility_date": "2026-05-15",
			"d1_databases": [{ "binding": "CUPBOARD_DB", "database_name": "cupboard" }]
		}`
	);
	const idToken = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(
		JSON.stringify({
			iss: 'https://idp.example.test',
			sub: 'founder',
			aud: 'cupboard-cli',
			name: 'Ada'
		})
	).toString('base64url')}.signature`;

	it.each([
		{ name: 'confirmed', isConfirmed: true, kind: 'bootstrap' },
		{ name: 'declined', isConfirmed: false, kind: 'declined' }
	])(
		'shows the claimant before the claim, then continues or stops ($name)',
		async ({ isConfirmed, kind }) => {
			const infos: string[] = [];
			const asked: unknown[] = [];

			const authority = await establishAuthority(
				{
					agreed: { config: firstConfig, domain: undefined }
				},
				{
					ui: {
						...pickerUi(),
						info: (message) => {
							infos.push(message);
						}
					},
					api: {
						findD1Database: () => Promise.resolve(undefined),
						findD1DatabaseName: () => Promise.resolve(undefined),
						d1QueryRows: () => Promise.resolve([]),
						findCustomDomain: () => Promise.resolve(undefined),
						getWorkersDevSubdomain: () => Promise.resolve('example'),
						getScriptConfiguration: () => Promise.resolve(undefined)
					},
					adminAccess: () => updateAccess,
					checkAdmin: () => Promise.resolve(),
					servesCupboard: () => Promise.resolve(true),
					idToken: () => Promise.resolve(idToken),
					confirmClaim: (claimant) => {
						asked.push(claimant);
						return Promise.resolve(isConfirmed);
					},
					interactive: true
				}
			);

			const claimant = {
				...principal('https://idp.example.test', 'founder', 'cupboard-cli'),
				displayName: 'Ada'
			};

			expect({
				kind: authority.kind,
				infoCount: infos.length,
				showsClaimant: infos[0]?.includes(claimantLabel(claimant)),
				asked
			}).toStrictEqual({
				kind,
				infoCount: 1,
				showsClaimant: true,
				asked: [claimant]
			});
		}
	);
});

describe('deployAndOnboard', () => {
	const cancelled: OnboardOutcome = {
		kind: 'cancelled',
		url: 'https://cache.example.com'
	};

	type FailingStep =
		| 'removing a leftover secret'
		| 'the upload'
		| 'onboarding before the claim'
		| 'nothing';
	const authorities: readonly (readonly [string, DeployAuthority])[] = [
		['a first deploy', bootstrapAuthority],
		['an update', updateAuthority],
		['an unclaimed deploy', unclaimedAuthority]
	];
	const failingSteps: readonly FailingStep[] = [
		'removing a leftover secret',
		'the upload',
		'onboarding before the claim',
		'nothing'
	];

	it.each(
		authorities.flatMap(([authorityName, authority]) =>
			failingSteps.map((failingStep) => ({
				name: `${authorityName} when ${failingStep} fails`,
				authority,
				failingStep
			}))
		)
	)('removes the claim secret on $name', async ({ authority, failingStep }) => {
		const calls: string[] = [];
		const step = (name: FailingStep, call: string): Promise<void> => {
			calls.push(call);
			return name === failingStep
				? Promise.reject(new Error(`${call} failed`))
				: Promise.resolve();
		};

		const result = await rejectionOf(
			deployAndOnboard(authority, {
				removeLeftoverClaimSecret: () =>
					step('removing a leftover secret', 'removeLeftover'),
				deploy: () => step('the upload', 'deploy'),
				removeClaimSecret: () => {
					calls.push('removeClaimSecret');
					return Promise.resolve();
				},
				onboard: async (removeClaimSecretOnce) => {
					await step('onboarding before the claim', 'onboard');

					// The claim on a first deploy removes the secret itself, so the
					// `finally` must not remove it a second time.
					if (authority.kind === 'bootstrap') {
						await removeClaimSecretOnce();
					}

					return cancelled;
				}
			})
		);

		const expectedSteps = {
			'removing a leftover secret': ['removeLeftover'],
			'the upload': ['removeLeftover', 'deploy'],
			'onboarding before the claim': ['removeLeftover', 'deploy', 'onboard'],
			nothing: ['removeLeftover', 'deploy', 'onboard']
		}[failingStep];
		const secretRemovals =
			authority.kind === 'bootstrap' ? ['removeClaimSecret'] : [];

		expect({
			isFailure: result instanceof Error,
			calls
		}).toStrictEqual({
			isFailure: failingStep !== 'nothing',
			calls: [...expectedSteps, ...secretRemovals]
		});
	});

	it('fails a deploy that leaves the deployment without an admin', async () => {
		const calls: string[] = [];
		const record = (call: string) => (): Promise<void> => {
			calls.push(call);
			return Promise.resolve();
		};

		const result = await rejectionOf(
			deployAndOnboard(unclaimedAuthority, {
				removeLeftoverClaimSecret: record('removeLeftover'),
				deploy: record('deploy'),
				removeClaimSecret: record('removeClaimSecret'),
				onboard: () => {
					calls.push('onboard');
					return Promise.resolve({
						kind: 'unclaimed',
						url: 'https://cache.example.com'
					});
				}
			})
		);

		expect({
			isUnclaimedError: result instanceof DeploymentUnclaimedError,
			calls
		}).toStrictEqual({
			isUnclaimedError: true,
			calls: ['removeLeftover', 'deploy', 'onboard']
		});
	});
});
