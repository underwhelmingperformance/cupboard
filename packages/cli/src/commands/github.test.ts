import { capturingReporter as reporter } from '@cupboard/cli-ui/testing';
import { CacheInfo } from '@cupboard/nix-store/cache-info';
import type {
	OidcTrustAddBody,
	OidcTrustSummary
} from '@cupboard/protocol/oidc';
import type { GracePolicyAddBody } from '@cupboard/protocol/retention';
import type { ReuseViewSelector } from '@cupboard/protocol/reuse-views';
import type { ResultRow } from '@cupboard/reporter';
import { Command } from 'commander';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

import {
	CacheInfoRateLimitedError,
	CacheInfoServerError,
	CacheInfoTimeoutError,
	CacheInfoUnavailableError,
	CliAbortError,
	GithubSetupDriftError,
	GraceTooShortError,
	ReadCredentialPairError,
	WorkflowReferenceMutableError,
	WorkflowReferenceNotFoundError,
	WorkflowReferenceRetirementConflictError
} from '../errors.ts';

import {
	cacheInfoFetcher,
	type GithubSetupClient,
	type GithubSetupOptions,
	registerGithubCommands,
	runGithubSetup
} from './github.ts';
import { githubBranchAddBody, githubPrAddBody } from './oidc-trust.ts';
import { type RepositoryIdentity } from './oidc-trust/github.ts';

const url = 'https://cupboard.example.workers.dev/t/acme';
const identity: RepositoryIdentity = {
	repositoryId: 1234,
	repositoryOwnerId: 5678,
	fullName: 'acme/app'
};

const pinnedWorkflowReference =
	'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v1.2.3';
const previousWorkflowReference =
	'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v1.2.2';
const retainedWorkflowReference =
	'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v1.2.1';

const options: GithubSetupOptions = {
	repo: 'acme/app',
	branch: 'main',
	grace: '24h',
	workflowRef: pinnedWorkflowReference
};

const prBody = githubPrAddBody(url, identity, {
	repo: options.repo,
	jobWorkflowRef: options.workflowRef
});
const branchBody = githubBranchAddBody(url, identity, {
	repo: options.repo,
	branch: options.branch,
	jobWorkflowRef: options.workflowRef
});
const previousPrBody = githubPrAddBody(url, identity, {
	repo: options.repo,
	jobWorkflowRef: previousWorkflowReference
});
const previousBranchBody = githubBranchAddBody(url, identity, {
	repo: options.repo,
	branch: options.branch,
	jobWorkflowRef: previousWorkflowReference
});

function storedRule(id: string, body: OidcTrustAddBody): OidcTrustSummary {
	return { id, ...body, disabled: false };
}

interface Recorded {
	readonly graceAdds: GracePolicyAddBody[];
	readonly viewSets: {
		name: string;
		selectors: readonly ReuseViewSelector[];
		priority?: number;
	}[];
	readonly ruleAdds: OidcTrustAddBody[];
	readonly ruleRemoves: string[];
}

interface Stored {
	readonly gracePolicies?: { cachePrefix: string; graceSeconds: number }[];
	readonly views?: {
		name: string;
		priority: number;
		selectors: readonly ReuseViewSelector[];
	}[];
	readonly rules?: OidcTrustSummary[];
}

function setupClient(stored: Stored): {
	client: GithubSetupClient;
	recorded: Recorded;
} {
	const recorded: Recorded = {
		graceAdds: [],
		viewSets: [],
		ruleAdds: [],
		ruleRemoves: []
	};
	const client: GithubSetupClient = {
		policies: {
			graceList: () =>
				Promise.resolve({
					policies: (stored.gracePolicies ?? []).map((policy, index) => ({
						id: `grace-${String(index)}`,
						createdAt: '2026-01-01T00:00:00.000Z',
						...policy
					}))
				}),
			graceAdd(input) {
				recorded.graceAdds.push(input);

				return Promise.resolve({
					id: 'grace-new',
					createdAt: '2026-01-01T00:00:00.000Z',
					cachePrefix: input.cachePrefix,
					graceSeconds: input.graceSeconds
				});
			}
		},
		reuseViews: {
			list: () =>
				Promise.resolve({
					views: (stored.views ?? []).map((view, index) => ({
						revision: index + 1,
						createdAt: '2026-01-01T00:00:00.000Z',
						updatedAt: '2026-01-01T00:00:00.000Z',
						...view,
						selectors: [...view.selectors]
					}))
				}),
			set(input) {
				recorded.viewSets.push(input);

				return Promise.resolve({
					name: input.name,
					revision: 1,
					priority: input.priority ?? 50,
					selectors: [...input.selectors],
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z'
				});
			}
		},
		oidcTrust: {
			list: () => Promise.resolve({ rules: stored.rules ?? [] }),
			add(input) {
				recorded.ruleAdds.push(input);

				return Promise.resolve(storedRule('rule-new', input));
			},
			remove({ id }) {
				recorded.ruleRemoves.push(id);

				return Promise.resolve({ id, removed: true });
			}
		}
	};

	return { client, recorded };
}

const dependencies = {
	lookupRepository: () => Promise.resolve(identity),
	fetchCacheInfo: () => Promise.resolve(new CacheInfo('/nix/store', true, 40)),
	verifyWorkflowReference: () => Promise.resolve()
};

function expectDriftError(
	error: unknown
): asserts error is GithubSetupDriftError {
	expect(error).toBeInstanceOf(GithubSetupDriftError);
}

describe('runGithubSetup', () => {
	it('cancels stalled workflow verification with the command signal', async () => {
		const controller = new AbortController();
		const reason = new CliAbortError();
		const { promise: started, resolve: markStarted } =
			Promise.withResolvers<true>();
		const { client, recorded } = setupClient({});
		const pending = runGithubSetup(url, options, reporter([]), client, {
			...dependencies,
			signal: controller.signal,
			verifyWorkflowReference: (_reference, lookupOptions) => {
				const signal = lookupOptions?.signal;

				if (signal === undefined) {
					return Promise.reject(new Error('missing command signal'));
				}

				markStarted(true);

				return new Promise<void>((_resolve, reject) => {
					signal.addEventListener(
						'abort',
						() => {
							reject(reason);
						},
						{ once: true }
					);
				});
			}
		});

		await started;
		controller.abort(reason);

		await expect(pending).rejects.toBe(reason);
		expect(recorded).toStrictEqual({
			graceAdds: [],
			viewSets: [],
			ruleAdds: [],
			ruleRemoves: []
		});
	});

	it('creates the whole configuration on a fresh tenant', async () => {
		const results: ResultRow[][] = [];
		const { client, recorded } = setupClient({});

		await runGithubSetup(url, options, reporter(results), client, dependencies);

		expect({ recorded, results }).toStrictEqual({
			recorded: {
				graceAdds: [{ cachePrefix: '', graceSeconds: 86_400 }],
				viewSets: [
					{
						name: 'pull-requests',
						selectors: [{ kind: 'prefix', pattern: 'pr-' }],
						priority: 50
					}
				],
				ruleAdds: [prBody, branchBody],
				ruleRemoves: []
			},
			results: [
				[
					{ label: 'grace policy', value: 'created' },
					{ label: 'reuse view', value: 'created' },
					{ label: 'pull-request trust rule', value: 'created' },
					{ label: 'main trust rule', value: 'created' }
				]
			]
		});
	});

	// The check command treats a sub-hour grace as failed, so setup must not
	// store one; the refusal lands before any tenant write.
	it('refuses a sub-hour grace before writing anything', async () => {
		const { client, recorded } = setupClient({});

		let failure: unknown;
		try {
			await runGithubSetup(
				url,
				{ ...options, grace: '30m' },
				reporter([]),
				client,
				dependencies
			);
		} catch (error) {
			failure = error;
		}

		expect({ failure, recorded }).toStrictEqual({
			failure: new GraceTooShortError(1800, 3600),
			recorded: {
				graceAdds: [],
				viewSets: [],
				ruleAdds: [],
				ruleRemoves: []
			}
		});
		expect(failure).toBeInstanceOf(GraceTooShortError);
	});

	it('refuses a mutable workflow ref before writing anything', async () => {
		const { client, recorded } = setupClient({});

		let failure: unknown;
		try {
			await runGithubSetup(
				url,
				{
					...options,
					workflowRef: 'acme/app/.github/workflows/publish.yml@refs/heads/main'
				},
				reporter([]),
				client,
				dependencies
			);
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(WorkflowReferenceMutableError);
		expect(recorded).toStrictEqual({
			graceAdds: [],
			viewSets: [],
			ruleAdds: [],
			ruleRemoves: []
		});
	});

	it('performs no writes against converged state', async () => {
		const results: ResultRow[][] = [];
		const { client, recorded } = setupClient({
			gracePolicies: [{ cachePrefix: '', graceSeconds: 86_400 }],
			views: [
				{
					name: 'pull-requests',
					priority: 50,
					selectors: [{ kind: 'prefix', pattern: 'pr-' }]
				}
			],
			rules: [storedRule('pr', prBody), storedRule('branch', branchBody)]
		});

		await runGithubSetup(url, options, reporter(results), client, dependencies);

		expect({ recorded, outcomes: results[0]?.slice(0, 4) }).toStrictEqual({
			recorded: {
				graceAdds: [],
				viewSets: [],
				ruleAdds: [],
				ruleRemoves: []
			},
			outcomes: [
				{ label: 'grace policy', value: 'unchanged' },
				{ label: 'reuse view', value: 'unchanged' },
				{ label: 'pull-request trust rule', value: 'unchanged' },
				{ label: 'main trust rule', value: 'unchanged' }
			]
		});
	});

	it('adds a new immutable workflow reference alongside the previous rules', async () => {
		const results: ResultRow[][] = [];
		const verifiedReferences: string[] = [];
		const { client, recorded } = setupClient({
			gracePolicies: [{ cachePrefix: '', graceSeconds: 86_400 }],
			views: [
				{
					name: 'pull-requests',
					priority: 50,
					selectors: [{ kind: 'prefix', pattern: 'pr-' }]
				}
			],
			rules: [
				storedRule('previous-pr', previousPrBody),
				storedRule('previous-branch', previousBranchBody)
			]
		});

		await runGithubSetup(url, options, reporter(results), client, {
			...dependencies,
			verifyWorkflowReference(reference) {
				verifiedReferences.push(reference);

				return Promise.resolve();
			}
		});

		expect({
			recorded,
			outcomes: results[0],
			verifiedReferences
		}).toStrictEqual({
			recorded: {
				graceAdds: [],
				viewSets: [],
				ruleAdds: [prBody, branchBody],
				ruleRemoves: []
			},
			outcomes: [
				{ label: 'grace policy', value: 'unchanged' },
				{ label: 'reuse view', value: 'unchanged' },
				{ label: 'pull-request trust rule', value: 'created' },
				{ label: 'main trust rule', value: 'created' }
			],
			verifiedReferences: [pinnedWorkflowReference, previousWorkflowReference]
		});
	});

	it('verifies a previous release before accepting it as an overlap', async () => {
		const { client, recorded } = setupClient({
			rules: [
				storedRule('previous-pr', previousPrBody),
				storedRule('previous-branch', previousBranchBody)
			]
		});

		await expect(
			runGithubSetup(url, options, reporter([]), client, {
				...dependencies,
				verifyWorkflowReference(reference) {
					return reference === previousWorkflowReference
						? Promise.reject(
								new WorkflowReferenceMutableError(reference, 'refs/tags/v1.2.2')
							)
						: Promise.resolve();
				}
			})
		).rejects.toBeInstanceOf(WorkflowReferenceMutableError);
		expect(recorded).toStrictEqual({
			graceAdds: [],
			viewSets: [],
			ruleAdds: [],
			ruleRemoves: []
		});
	});

	it('retires the exact previous rules only after the new rules are established', async () => {
		const results: ResultRow[][] = [];
		const { client, recorded } = setupClient({
			gracePolicies: [{ cachePrefix: '', graceSeconds: 86_400 }],
			views: [
				{
					name: 'pull-requests',
					priority: 50,
					selectors: [{ kind: 'prefix', pattern: 'pr-' }]
				}
			],
			rules: [
				storedRule('current-pr', prBody),
				storedRule('current-branch', branchBody),
				storedRule('previous-pr', previousPrBody),
				storedRule('previous-branch', previousBranchBody)
			]
		});

		await runGithubSetup(
			url,
			{ ...options, retireWorkflowRef: previousWorkflowReference },
			reporter(results),
			client,
			dependencies
		);

		expect({ recorded, outcomes: results[0] }).toStrictEqual({
			recorded: {
				graceAdds: [],
				viewSets: [],
				ruleAdds: [],
				ruleRemoves: ['previous-pr', 'previous-branch']
			},
			outcomes: [
				{ label: 'grace policy', value: 'unchanged' },
				{ label: 'reuse view', value: 'unchanged' },
				{ label: 'pull-request trust rule', value: 'unchanged' },
				{ label: 'main trust rule', value: 'unchanged' },
				{
					label: 'previous pull-request trust rule',
					value: 'removed: 1 rule'
				},
				{ label: 'previous main trust rule', value: 'removed: 1 rule' }
			]
		});
	});

	it('retires an unavailable previous reference while verifying retained siblings', async () => {
		const retainedPrBody = githubPrAddBody(url, identity, {
			repo: options.repo,
			jobWorkflowRef: retainedWorkflowReference
		});
		const retainedBranchBody = githubBranchAddBody(url, identity, {
			repo: options.repo,
			branch: options.branch,
			jobWorkflowRef: retainedWorkflowReference
		});
		const verifiedReferences: string[] = [];
		const { client, recorded } = setupClient({
			gracePolicies: [{ cachePrefix: '', graceSeconds: 86_400 }],
			views: [
				{
					name: 'pull-requests',
					priority: 50,
					selectors: [{ kind: 'prefix', pattern: 'pr-' }]
				}
			],
			rules: [
				storedRule('current-pr', prBody),
				storedRule('current-branch', branchBody),
				storedRule('previous-pr', previousPrBody),
				storedRule('previous-branch', previousBranchBody),
				storedRule('retained-pr', retainedPrBody),
				storedRule('retained-branch', retainedBranchBody)
			]
		});

		await runGithubSetup(
			url,
			{ ...options, retireWorkflowRef: previousWorkflowReference },
			reporter([]),
			client,
			{
				...dependencies,
				verifyWorkflowReference(reference) {
					verifiedReferences.push(reference);

					if (reference === previousWorkflowReference) {
						return Promise.reject(
							new WorkflowReferenceNotFoundError(reference)
						);
					}

					return Promise.resolve();
				}
			}
		);

		expect({ recorded, verifiedReferences }).toStrictEqual({
			recorded: {
				graceAdds: [],
				viewSets: [],
				ruleAdds: [],
				ruleRemoves: ['previous-pr', 'previous-branch']
			},
			verifiedReferences: [pinnedWorkflowReference, retainedWorkflowReference]
		});
	});

	it('does not retire either previous rule when one has drifted', async () => {
		const { client, recorded } = setupClient({
			gracePolicies: [{ cachePrefix: '', graceSeconds: 86_400 }],
			views: [
				{
					name: 'pull-requests',
					priority: 50,
					selectors: [{ kind: 'prefix', pattern: 'pr-' }]
				}
			],
			rules: [
				storedRule('current-pr', prBody),
				storedRule('current-branch', branchBody),
				storedRule('previous-pr', {
					...previousPrBody,
					permittedGrants: previousBranchBody.permittedGrants
				}),
				storedRule('previous-branch', previousBranchBody)
			]
		});

		await expect(
			runGithubSetup(
				url,
				{ ...options, retireWorkflowRef: previousWorkflowReference },
				reporter([]),
				client,
				dependencies
			)
		).rejects.toBeInstanceOf(GithubSetupDriftError);
		expect(recorded.ruleRemoves).toStrictEqual([]);
	});

	it('refuses to retire the workflow reference setup is establishing', async () => {
		const { client, recorded } = setupClient({});

		await expect(
			runGithubSetup(
				url,
				{ ...options, retireWorkflowRef: options.workflowRef },
				reporter([]),
				client,
				dependencies
			)
		).rejects.toBeInstanceOf(WorkflowReferenceRetirementConflictError);
		expect(recorded).toStrictEqual({
			graceAdds: [],
			viewSets: [],
			ruleAdds: [],
			ruleRemoves: []
		});
	});

	it('reports drift without replacing the stored state', async () => {
		const results: ResultRow[][] = [];
		const { client, recorded } = setupClient({
			gracePolicies: [{ cachePrefix: '', graceSeconds: 3600 }],
			views: [
				{
					name: 'pull-requests',
					priority: 40,
					selectors: [{ kind: 'prefix', pattern: 'pr-' }]
				}
			],
			rules: [
				storedRule('pr', {
					...prBody,
					claims: {
						...prBody.claims,
						job_workflow_ref: 'other@refs/heads/main'
					}
				}),
				storedRule('branch', branchBody)
			]
		});

		let failure: unknown;
		try {
			await runGithubSetup(
				url,
				options,
				reporter(results),
				client,
				dependencies
			);
		} catch (error) {
			failure = error;
		}

		expectDriftError(failure);
		expect({
			recorded,
			steps: failure.steps,
			trustRuleRow: results[0]?.[2]
		}).toStrictEqual({
			recorded: {
				graceAdds: [],
				viewSets: [],
				ruleAdds: [],
				ruleRemoves: []
			},
			steps: ['grace policy', 'reuse view', 'pull-request trust rule'],
			// The drift detail names the diverging fields and the remediation.
			trustRuleRow: {
				label: 'pull-request trust rule',
				value:
					'drift: rule pr covers the same trigger but differs on claims; remove it and re-run setup'
			}
		});
	});
	it('reports disallowed same-trigger drift alongside an exact rule', async () => {
		const results: ResultRow[][] = [];
		const { client, recorded } = setupClient({
			gracePolicies: [{ cachePrefix: '', graceSeconds: 86_400 }],
			views: [
				{
					name: 'pull-requests',
					priority: 50,
					selectors: [{ kind: 'prefix', pattern: 'pr-' }]
				}
			],
			rules: [
				storedRule('current-pr', prBody),
				storedRule('drifted-pr', {
					...prBody,
					permittedGrants: branchBody.permittedGrants
				}),
				storedRule('current-branch', branchBody)
			]
		});

		let failure: unknown;
		try {
			await runGithubSetup(
				url,
				options,
				reporter(results),
				client,
				dependencies
			);
		} catch (error) {
			failure = error;
		}

		expectDriftError(failure);
		expect({
			recorded,
			steps: failure.steps,
			trustRuleRow: results[0]?.[2]
		}).toStrictEqual({
			recorded: {
				graceAdds: [],
				viewSets: [],
				ruleAdds: [],
				ruleRemoves: []
			},
			steps: ['pull-request trust rule'],
			trustRuleRow: {
				label: 'pull-request trust rule',
				value:
					'drift: rule drifted-pr covers the same trigger but differs on grants; remove it and re-run setup'
			}
		});
	});
});

describe('registerGithubCommands', () => {
	it.each([['setup'], ['check']])(
		'refuses %s without --workflow-ref',
		async (subcommand) => {
			const stderr: string[] = [];
			const program = new Command();
			program.exitOverride();
			program.configureOutput({
				writeErr: (message) => {
					stderr.push(message);
				}
			});
			registerGithubCommands(program);

			await expect(
				program.parseAsync(['github', subcommand, url, '--repo', 'acme/app'], {
					from: 'user'
				})
			).rejects.toMatchObject({
				code: 'commander.missingMandatoryOptionValue'
			});
			expect(stderr).toHaveLength(1);
		}
	);
});

describe('cacheInfoFetcher', () => {
	const info = new CacheInfo('/nix/store', true, 40).render();

	it('sends the Basic credential and parses the answer', async () => {
		const requests: { url: string; authorization: string | undefined }[] = [];
		const fetch = cacheInfoFetcher(
			{ readUser: 'alice', readPassword: 's3cret' },
			{
				fetch: (input, init) => {
					requests.push({
						url:
							typeof input === 'string'
								? input
								: input instanceof URL
									? input.href
									: input.url,
						authorization:
							new Headers(init?.headers).get('authorization') ?? undefined
					});

					return Promise.resolve(new Response(info));
				}
			}
		);

		const fetched = await fetch('https://cupboard.example/t/acme/');

		expect({ priority: fetched.priority, requests }).toStrictEqual({
			priority: 40,
			requests: [
				{
					url: 'https://cupboard.example/t/acme/nix-cache-info',
					authorization: `Basic ${Buffer.from('alice:s3cret').toString('base64')}`
				}
			]
		});
	});

	it('sends no credential when none is supplied', async () => {
		const authorizations: (string | undefined)[] = [];
		const fetch = cacheInfoFetcher(
			{},
			{
				fetch: (_input, init) => {
					authorizations.push(
						new Headers(init?.headers).get('authorization') ?? undefined
					);

					return Promise.resolve(new Response(info));
				}
			}
		);

		await fetch('https://cupboard.example/t/acme');

		expect(authorizations).toStrictEqual([undefined]);
	});

	it('surfaces a refused read with the response status', async () => {
		const fetch = cacheInfoFetcher(
			{},
			{
				fetch: () =>
					Promise.resolve(
						new Response(undefined, { status: StatusCodes.UNAUTHORIZED })
					)
			}
		);

		let failure: unknown;
		try {
			await fetch('https://cupboard.example/t/acme');
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(CacheInfoUnavailableError);
	});

	it.each([
		{
			status: StatusCodes.TOO_MANY_REQUESTS,
			error: CacheInfoRateLimitedError
		},
		{ status: StatusCodes.BAD_GATEWAY, error: CacheInfoServerError }
	])(
		'classifies an HTTP $status cache-info response',
		async ({ status, error }) => {
			const fetch = cacheInfoFetcher(
				{},
				{
					fetch: () =>
						Promise.resolve(
							new Response(undefined, {
								status,
								headers: { 'retry-after': '0.001' }
							})
						)
				}
			);

			await expect(
				fetch('https://cupboard.example/t/acme')
			).rejects.toBeInstanceOf(error);
		}
	);

	it('rejects half a credential pair before any request', () => {
		expect(() => cacheInfoFetcher({ readUser: 'alice' })).toThrow(
			ReadCredentialPairError
		);
	});

	it('retries a transient response before parsing the answer', async () => {
		let attempts = 0;
		const fetch = cacheInfoFetcher(
			{},
			{
				fetch: () => {
					attempts += 1;

					return Promise.resolve(
						attempts === 1
							? new Response(undefined, {
									status: StatusCodes.SERVICE_UNAVAILABLE,
									headers: { 'retry-after': '0.001' }
								})
							: new Response(info)
					);
				}
			}
		);

		const fetched = await fetch('https://cupboard.example/t/acme');

		expect({ attempts, priority: fetched.priority }).toStrictEqual({
			attempts: 2,
			priority: 40
		});
	});

	it('bounds a cache-info probe with a deadline', async () => {
		const fetch = cacheInfoFetcher(
			{},
			{
				fetch: (_input, init) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener(
							'abort',
							() => {
								reject(new Error('request aborted'));
							},
							{ once: true }
						);
					}),
				timeoutMs: 1
			}
		);

		await expect(
			fetch('https://cupboard.example/t/acme')
		).rejects.toBeInstanceOf(CacheInfoTimeoutError);
	});

	it('translates a stalled cache-info body into a timeout', async () => {
		const signals: AbortSignal[] = [];
		const fetch = cacheInfoFetcher(
			{},
			{
				fetch: (_input, init) => {
					const signal = init?.signal;

					if (signal === undefined || signal === null) {
						throw new Error('expected an abort signal');
					}

					signals.push(signal);
					const body = new ReadableStream({
						start(controller) {
							signal.addEventListener(
								'abort',
								() => {
									controller.error(new Error('response body aborted'));
								},
								{ once: true }
							);
						}
					});

					return Promise.resolve(new Response(body));
				},
				timeoutMs: 1
			}
		);

		await expect(
			fetch('https://cupboard.example/t/acme')
		).rejects.toBeInstanceOf(CacheInfoTimeoutError);
		expect(signals.map(({ aborted }) => aborted)).toStrictEqual([true]);
	});

	it('propagates the command abort reason to the request', async () => {
		const controller = new AbortController();
		const reason = new CliAbortError();
		const fetch = cacheInfoFetcher(
			{ signal: controller.signal },
			{
				fetch: (_input, init) => {
					controller.abort(reason);
					expect(init?.signal?.reason).toBe(reason);

					return Promise.reject(reason);
				}
			}
		);

		await expect(fetch('https://cupboard.example/t/acme')).rejects.toBe(reason);
	});
});
