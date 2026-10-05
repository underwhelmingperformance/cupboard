import { capturingReporter as reporter } from '@cupboard/cli-ui/testing';
import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import {
	currentLocalStep,
	expansionLocalStep,
	type LocalStep,
	type LocalStepStatus,
	type ParsedDeploymentTransitionsResponse,
	requiredLocalStepFrom
} from '@cupboard/protocol/deployment';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import type { Reporter, ResultPayload, ResultRow } from '@cupboard/reporter';
import { Command } from 'commander';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { describe, expect, it, vi } from 'vitest';

import { writeCachedSession } from '../auth/token-store.ts';
import { LocalStepUnreachedError } from '../errors.ts';
import { testWithConfigHome } from '../test-support.ts';

import {
	type DeploymentClient,
	registerDeploymentCommands,
	runDeploymentResume,
	runDeploymentStatus
} from './deployment.ts';

const tenant = tenantIdSchema.parse('acme');
const recorded = isoTimestampSchema.parse('2026-01-01T00:20:30.000Z');

const expanded: ParsedDeploymentTransitionsResponse = {
	transitions: [
		{ id: 'cache-identity', state: 'expanded', updatedAt: recorded },
		{ id: 'deployment-transitions', state: 'complete', updatedAt: recorded },
		{ id: 'attestation-path-index', state: 'expanded', updatedAt: recorded },
		{ id: 'local-step-attempts', state: 'complete', updatedAt: recorded },
		{ id: 'publication-identity', state: 'complete', updatedAt: recorded },
		{
			id: 'blob-reference-read-authority',
			state: 'expanded',
			updatedAt: recorded
		}
	],
	unrecognised: []
};
const complete: ParsedDeploymentTransitionsResponse = {
	transitions: [
		{ id: 'cache-identity', state: 'complete', updatedAt: recorded },
		{ id: 'deployment-transitions', state: 'complete', updatedAt: recorded },
		{ id: 'attestation-path-index', state: 'complete', updatedAt: recorded },
		{ id: 'local-step-attempts', state: 'complete', updatedAt: recorded },
		{ id: 'publication-identity', state: 'complete', updatedAt: recorded },
		{
			id: 'blob-reference-read-authority',
			state: 'complete',
			updatedAt: recorded
		},
		{ id: 'tenant-retry-clock', state: 'complete', updatedAt: recorded },
		{ id: 'tenant-schema-progress', state: 'complete', updatedAt: recorded }
	],
	unrecognised: []
};

// The required local step that the server derives from the recorded states.
function requiredStepOf(
	response: ParsedDeploymentTransitionsResponse
): LocalStep {
	return requiredLocalStepFrom(
		new Map(
			response.transitions.map((transition) => [
				transition.id,
				transition.state
			])
		)
	);
}

// A status in which every pending tenant is unwoken.
function statusFor(required: number, pending: number): LocalStepStatus {
	return {
		current: currentLocalStep,
		required,
		ready: 1,
		pending,
		working: 0,
		stalled: 0,
		unwoken: pending,
		stalledSample: [],
		unwokenSample: pending > 0 ? [{ tenant }] : []
	};
}

function client(
	transitions: ParsedDeploymentTransitionsResponse,
	calls: unknown[],
	pending: { count: number }
): DeploymentClient {
	return {
		transitions: () => {
			calls.push('transitions');
			return Promise.resolve(transitions);
		},
		localStep: {
			status: () => {
				calls.push('status');
				return Promise.resolve(
					statusFor(requiredStepOf(transitions), pending.count)
				);
			},
			wake: () => {
				calls.push('wake');
				const woken = pending.count;
				pending.count = 0;
				return Promise.resolve({
					required: requiredStepOf(transitions),
					enqueued: woken,
					pending: woken
				});
			}
		}
	};
}

// A reporter that also keeps each result payload, so a test can assert the
// `data` that `--json` prints.
function payloadReporter(
	payloads: ResultPayload[],
	infos: string[] = []
): Reporter {
	const base = reporter([], infos);

	return {
		...base,
		result: (payload) => {
			payloads.push(payload);
			base.result(payload);
		}
	};
}

const since = 'since 2026-01-01 00:20 UTC';

it('shows readiness without completed transitions or numeric migration steps by default', async () => {
	const results: ResultRow[][] = [];
	await runDeploymentStatus(
		reporter(results),
		client(complete, [], { count: 0 })
	);
	expect(results).toStrictEqual([
		[
			{ label: 'Deployment', value: 'Ready' },
			{ label: 'Tenants', value: '1 ready' }
		]
	]);
});

it('directs the operator to init when schema transitions are incomplete', async () => {
	const results: ResultRow[][] = [];

	await runDeploymentStatus(
		reporter(results),
		client(expanded, [], { count: 1 })
	);

	expect(results).toStrictEqual([
		[
			{ label: 'Deployment', value: 'Deployment incomplete' },
			{ label: 'Tenants', value: '1 ready, 1 waiting to start' },
			{
				label: 'Next step',
				value:
					'Re-run cupboard init with the same release and source to finish the deployment.'
			},
			{
				label: 'Waiting to start',
				value: 'acme: no attempt at the outstanding work'
			}
		]
	]);
});

it('shows active schema migration progress by default', async () => {
	const results: ResultRow[][] = [];
	const status: LocalStepStatus = {
		...statusFor(currentLocalStep, 1),
		working: 1,
		unwoken: 0,
		unwokenSample: [],
		workingSample: [
			{
				tenant,
				attemptedAt: recorded,
				progressedAt: recorded,
				migration: {
					migration: '0066_publication_recovery',
					stage: 'copy-narinfo',
					cursor: 1000
				}
			}
		]
	};
	const deploymentClient: DeploymentClient = {
		...client(complete, [], { count: 1 }),
		localStep: { status: () => Promise.resolve(status), wake: vi.fn() }
	};
	await runDeploymentStatus(reporter(results), deploymentClient);
	expect(results).toStrictEqual([
		[
			{ label: 'Deployment', value: 'Updating tenants' },
			{ label: 'Tenants', value: '1 ready, 1 migrating' },
			{
				label: 'Next step',
				value:
					'Use deployment resume with this deployment URL to wake pending tenants and wait for completion.'
			},
			{ label: 'Migrating', value: 'acme: last progress 2026-01-01 00:20 UTC' }
		]
	]);
});

// Rows that this build does not define, and what each command prints for them.
const unrecognisedCases = [
	{
		name: 'a later-release row in state expanded',
		row: { id: 'later-transition', state: 'expanded' },
		value: `expanded ${since}; this build does not define this transition, and no contract migration of it has started, so cupboard deploy leaves it unchanged`,
		isRefused: false
	},
	{
		name: 'a later-release row in state complete, with no contract migration started',
		row: { id: 'later-transition', state: 'complete' },
		value: `complete ${since}; this build does not define this transition, and no contract migration of it has started, so cupboard deploy leaves it unchanged`,
		isRefused: false
	},
	{
		name: 'a later-release row in state complete, with its contract migrations started',
		row: {
			id: 'later-transition',
			state: 'complete',
			contractedAt: recorded
		},
		value: `complete ${since}; this build does not define this transition, and cupboard deploy stops because its contract migrations have started and may have removed schema that this build needs`,
		isRefused: true
	},
	{
		name: 'a later-release row in state expanded, with its contract migrations started',
		row: {
			id: 'later-transition',
			state: 'expanded',
			contractedAt: recorded
		},
		value: `expanded ${since}; this build does not define this transition, and cupboard deploy stops because its contract migrations have started and may have removed schema that this build needs`,
		isRefused: true
	},
	{
		name: 'an unknown state of cache-identity',
		row: { id: 'cache-identity', state: 'later-state' },
		value: `later-state ${since}; this build defines the transition but not state 'later-state', so cupboard deploy stops; deploy a build that defines that state`,
		isRefused: true
	},
	{
		name: 'a later-release row in an unknown state',
		row: { id: 'later-transition', state: 'later-state' },
		value: `later-state ${since}; this build defines neither the transition nor the state, so cupboard deploy stops; deploy a build that defines both`,
		isRefused: true
	}
];

function runDetailedDeploymentStatus(
	reporter: Reporter,
	client: DeploymentClient
): Promise<void> {
	return runDeploymentStatus(reporter, client, { details: true });
}

describe('runDeploymentStatus', () => {
	it('reports each transition and the readiness at the required local step', async () => {
		const payloads: ResultPayload[] = [];
		const calls: unknown[] = [];

		await runDetailedDeploymentStatus(
			payloadReporter(payloads),
			client(expanded, calls, { count: 1 })
		);

		expect({ payloads, calls }).toStrictEqual({
			payloads: [
				{
					kind: 'deployment-status',
					data: {
						transitions: expanded.transitions,
						unrecognised: [],
						...statusFor(expansionLocalStep, 1)
					},
					rows: [
						{
							label: 'Transition cache-identity',
							value: `expanded ${since}`
						},
						{
							label: 'Transition deployment-transitions',
							value: `complete ${since}`
						},
						{
							label: 'Transition attestation-path-index',
							value: `expanded ${since}`
						},
						{
							label: 'Transition local-step-attempts',
							value: `complete ${since}`
						},
						{
							label: 'Transition publication-identity',
							value: `complete ${since}`
						},
						{
							label: 'Transition blob-reference-read-authority',
							value: `expanded ${since}`
						},
						{ label: 'Required local step', value: '4' },
						{ label: 'Ready tenants', value: '1' },
						{
							label: 'Pending tenants',
							value: '1 (working 0, stalled 0, unwoken 1)'
						},
						{
							label: 'Not yet woken',
							value: 'acme: no attempt at the outstanding work'
						}
					]
				}
			],
			calls: ['transitions', 'status']
		});
	});

	it.each(unrecognisedCases)('lists $name', async ({ row, value }) => {
		const payloads: ResultPayload[] = [];
		const unrecognised = [{ ...row, updatedAt: recorded }];

		await runDetailedDeploymentStatus(
			payloadReporter(payloads),
			client({ ...complete, unrecognised }, [], { count: 0 })
		);

		expect(payloads).toStrictEqual([
			{
				kind: 'deployment-status',
				data: {
					transitions: complete.transitions,
					unrecognised,
					...statusFor(currentLocalStep, 0)
				},
				rows: [
					{
						label: 'Transition cache-identity',
						value: `complete ${since}`
					},
					{
						label: 'Transition deployment-transitions',
						value: `complete ${since}`
					},
					{
						label: 'Transition attestation-path-index',
						value: `complete ${since}`
					},
					{
						label: 'Transition local-step-attempts',
						value: `complete ${since}`
					},
					{
						label: 'Transition publication-identity',
						value: `complete ${since}`
					},
					{
						label: 'Transition blob-reference-read-authority',
						value: `complete ${since}`
					},
					{
						label: 'Transition tenant-retry-clock',
						value: `complete ${since}`
					},
					{
						label: 'Transition tenant-schema-progress',
						value: `complete ${since}`
					},
					{ label: `Transition ${row.id}`, value },
					{ label: 'Required local step', value: '5' },
					{ label: 'Ready tenants', value: '1' },
					{
						label: 'Pending tenants',
						value: '0 (working 0, stalled 0, unwoken 0)'
					}
				]
			}
		]);
	});

	it("reports 'none recorded' when no transition has been recorded", async () => {
		const results: ResultRow[][] = [];

		await runDetailedDeploymentStatus(
			reporter(results),
			client({ transitions: [], unrecognised: [] }, [], {
				count: 0
			})
		);

		expect(results).toStrictEqual([
			[
				{ label: 'Transitions', value: 'none recorded' },
				{ label: 'Required local step', value: '4' },
				{ label: 'Ready tenants', value: '1' },
				{
					label: 'Pending tenants',
					value: '0 (working 0, stalled 0, unwoken 0)'
				}
			]
		]);
	});

	it('lists sampled migration progress, stalled and unwoken tenants and counts the others', async () => {
		const results: ResultRow[][] = [];
		const status: LocalStepStatus = {
			current: currentLocalStep,
			required: expansionLocalStep,
			ready: 4,
			pending: 4,
			working: 1,
			stalled: 2,
			unwoken: 1,
			stalledSample: [
				{
					tenant: 'acme',
					attemptedAt: '2026-01-01T00:31:04.000Z',
					progressedAt: '2026-01-01T00:02:11.000Z',
					error: 'InjectedPageFault'
				}
			],
			workingSample: [
				{
					tenant: 'beta',
					progressedAt: recorded,
					migration: {
						migration: '0066_publication_recovery',
						stage: 'copy-narinfo',
						cursor: 1000
					}
				}
			],
			unwokenSample: [{ tenant: 'gamma' }]
		};

		await runDetailedDeploymentStatus(reporter(results), {
			...client(expanded, [], { count: 0 }),
			localStep: {
				status: () => Promise.resolve(status),
				wake: () => Promise.reject(new Error('status does not wake'))
			}
		});

		expect(results).toStrictEqual([
			[
				{ label: 'Transition cache-identity', value: `expanded ${since}` },
				{
					label: 'Transition deployment-transitions',
					value: `complete ${since}`
				},
				{
					label: 'Transition attestation-path-index',
					value: `expanded ${since}`
				},
				{ label: 'Transition local-step-attempts', value: `complete ${since}` },
				{
					label: 'Transition publication-identity',
					value: `complete ${since}`
				},
				{
					label: 'Transition blob-reference-read-authority',
					value: `expanded ${since}`
				},
				{ label: 'Required local step', value: '4' },
				{ label: 'Ready tenants', value: '4' },
				{
					label: 'Pending tenants',
					value: '4 (working 1, stalled 2, unwoken 1)'
				},
				{
					label: 'Migrating',
					value:
						'beta: last progress 2026-01-01 00:20 UTC; 0066_publication_recovery, copy-narinfo, cursor 1000'
				},
				{
					label: 'Stalled',
					value:
						'acme: attempted 2026-01-01 00:31 UTC, last progress 2026-01-01 00:02 UTC, InjectedPageFault'
				},
				{
					label: 'Not yet woken',
					value: 'gamma: no attempt at the outstanding work'
				},
				{ label: 'Not listed', value: '1 more pending tenants' }
			]
		]);
	});
});

describe('runDeploymentResume', () => {
	it.each([
		{
			name: 'every transition is complete',
			transitions: complete,
			step: currentLocalStep,
			info: 'Every active or suspended tenant has reached local step 5, and every schema transition is complete.'
		},
		{
			name: 'cache-identity is still expanded',
			transitions: expanded,
			step: expansionLocalStep,
			info: 'Every active or suspended tenant has reached local step 4. Re-run cupboard deploy to complete cache-identity, attestation-path-index, blob-reference-read-authority, tenant-retry-clock, tenant-schema-progress.'
		}
	])(
		'wakes tenants to the required local step and reports the next action when $name',
		async ({ transitions, step, info }) => {
			const payloads: ResultPayload[] = [];
			const infos: string[] = [];
			const calls: unknown[] = [];

			await runDeploymentResume(
				payloadReporter(payloads, infos),
				client(transitions, calls, { count: 1 }),
				{}
			);

			expect({ payloads, infos, calls }).toStrictEqual({
				payloads: [
					{
						kind: 'deployment-readiness',
						data: statusFor(step, 0),
						rows: [
							{ label: 'Ready tenants', value: '1' },
							{ label: 'Required local step', value: String(step) }
						]
					}
				],
				infos: [info],
				calls: ['status', 'wake', 'status', 'transitions']
			});
		}
	);

	it.each(unrecognisedCases)(
		'lists $name and leaves it out of the transitions to complete',
		async ({ row, value, isRefused }) => {
			const payloads: ResultPayload[] = [];
			const infos: string[] = [];
			const transitions = {
				transitions: complete.transitions.filter(
					(transition) => transition.id !== row.id
				),
				unrecognised: [{ ...row, updatedAt: recorded }]
			};
			const step = requiredStepOf(transitions);

			await runDeploymentResume(
				payloadReporter(payloads, infos),
				client(transitions, [], { count: 0 }),
				{}
			);

			expect({ payloads, infos }).toStrictEqual({
				payloads: [
					{
						kind: 'deployment-readiness',
						data: statusFor(step, 0),
						rows: [
							{ label: 'Ready tenants', value: '1' },
							{ label: 'Required local step', value: String(step) },
							{ label: `Transition ${row.id}`, value }
						]
					}
				],
				infos: [
					isRefused
						? `Every active or suspended tenant has reached local step ${String(step)}. This build's cupboard deploy stops on ${row.id}, as listed above.`
						: `Every active or suspended tenant has reached local step ${String(step)}, and every schema transition is complete.`
				]
			});
		}
	);

	it('fails when no tenant has worked for the stall window after the wake', async () => {
		let now = 0;
		const stalled = statusFor(expansionLocalStep, 1);
		const failing: DeploymentClient = {
			...client(expanded, [], { count: 1 }),
			localStep: {
				status: () => Promise.resolve(stalled),
				wake: () =>
					Promise.resolve({
						required: expansionLocalStep,
						enqueued: 1,
						pending: 1
					})
			}
		};

		let caught: unknown;

		try {
			await runDeploymentResume(reporter([]), failing, {
				now: () => now,
				delay: (ms) => {
					now += ms;

					return Promise.resolve();
				}
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toStrictEqual(
			new LocalStepUnreachedError({ kind: 'stalled', status: stalled })
		);
	});
});

describe('deployment command authentication', () => {
	testWithConfigHome.each([
		{ command: 'status', githubOidc: false, audience: undefined },
		{ command: 'resume', githubOidc: false, audience: undefined },
		{ command: 'status', githubOidc: true, audience: undefined },
		{ command: 'status', githubOidc: true, audience: 'deployment-recovery' },
		{ command: 'resume', githubOidc: true, audience: undefined },
		{ command: 'resume', githubOidc: true, audience: 'deployment-recovery' }
	])(
		'authenticates $command with OIDC=$githubOidc and audience=$audience',
		async ({ command, githubOidc, audience }) => {
			const origin = 'https://cupboard.example.workers.dev';
			const payload = JSON.stringify({
				iss: origin,
				aud: origin,
				exp: Math.floor(Date.now() / 1000) + 3600
			});
			const claims = Buffer.from(payload).toString('base64url');
			const cachedToken = `e30.${claims}.signature`;
			await writeCachedSession({ accessToken: cachedToken }, new URL(origin));
			const calls: unknown[] = [];
			let pending = command === 'resume' ? 1 : 0;
			const server = setupServer(
				http.get('https://actions.example.com/token', ({ request }) => {
					calls.push({
						kind: 'identity',
						audience: new URL(request.url).searchParams.get('audience'),
						authorization: request.headers.get('authorization')
					});
					return HttpResponse.json({ value: 'signed-job-identity' });
				}),
				http.post(`${origin}/token`, async ({ request }) => {
					const form = new URLSearchParams(await request.text());
					calls.push({ kind: 'exchange', form: Object.fromEntries(form) });
					return HttpResponse.json({
						access_token: 'deployment-access',
						token_type: 'Bearer',
						expires_in: 900,
						issued_token_type: 'urn:ietf:params:oauth:token-type:access_token'
					});
				}),
				http.all(`${origin}/control/*`, ({ request }) => {
					const pathname = new URL(request.url).pathname;
					calls.push({
						kind: 'control',
						method: request.method,
						pathname,
						authorization: request.headers.get('authorization')
					});
					if (pathname === '/control/deployment/transitions') {
						return HttpResponse.json(complete);
					}
					if (pathname === '/control/local-step/wake') {
						const enqueued = pending;
						pending = 0;
						return HttpResponse.json({
							required: currentLocalStep,
							enqueued,
							pending: enqueued
						});
					}
					return HttpResponse.json(statusFor(currentLocalStep, pending));
				})
			);
			const program = new Command()
				.exitOverride()
				.configureOutput({ writeErr: vi.fn() });
			registerDeploymentCommands(program);
			vi.stubEnv(
				'ACTIONS_ID_TOKEN_REQUEST_URL',
				'https://actions.example.com/token'
			);
			vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'request-bearer');
			server.listen({ onUnhandledRequest: 'error' });
			try {
				await program.parseAsync(
					[
						'deployment',
						command,
						origin,
						...(githubOidc ? ['--github-oidc'] : []),
						...(audience === undefined ? [] : ['--audience', audience])
					],
					{ from: 'user' }
				);
			} finally {
				server.close();
				vi.unstubAllEnvs();
			}
			const actions = [
				'deployment:read',
				'local-step:read',
				...(command === 'resume' ? ['local-step:wake'] : [])
			];
			const controlCall = (pathname: string, method = 'GET') => ({
				kind: 'control',
				method,
				pathname,
				authorization: `Bearer ${githubOidc ? 'deployment-access' : cachedToken}`
			});
			expect(calls).toStrictEqual([
				...(githubOidc
					? [
							{
								kind: 'identity',
								audience: audience ?? origin,
								authorization: 'Bearer request-bearer'
							},
							{
								kind: 'exchange',
								form: {
									grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
									subject_token: 'signed-job-identity',
									subject_token_type:
										'urn:ietf:params:oauth:token-type:id_token',
									authorization_details: JSON.stringify([
										{ type: 'cupboard_control', actions }
									])
								}
							}
						]
					: []),
				...(command === 'status'
					? [
							controlCall('/control/deployment/transitions'),
							controlCall('/control/local-step')
						]
					: [
							controlCall('/control/local-step'),
							controlCall('/control/local-step/wake', 'POST'),
							controlCall('/control/local-step'),
							controlCall('/control/deployment/transitions')
						])
			]);
		}
	);
});
