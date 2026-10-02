import { cacheNameSchema } from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import {
	attestAttachAuthorizationDetails,
	cacheCreateAuthorizationDetails,
	cacheLifecycleAuthorizationDetails,
	confirmAuthorizationDetails,
	pushAuthorizationDetails,
	rootEnsureAuthorizationDetails,
	rootListAuthorizationDetails
} from '../../auth/attenuate.ts';
import { parseRootName } from '../../root-name.ts';

import {
	type DiscoveredPublishingJob,
	type WorkflowTrigger
} from './discovery.ts';
import {
	BranchFilterCoverageFinding,
	CustomReuseViewFinding,
	JobConditionUndecidedFinding,
	ManualRunBranchFinding,
	modelPublishingJob,
	PathFilterNotModelledFinding,
	PresetPushFilterFinding,
	PresetTagPushFinding,
	PublicationUnmodelledFinding,
	PushCoverageFinding,
	ReferenceFilterExcludesFinding,
	ReferenceFilterUnsupportedFinding,
	TagPatternCoverageFinding,
	TagsIgnoreUnmodelledFinding,
	withMergedCloseCases
} from './publication.ts';
import { ReferencePattern } from './reference-pattern.ts';

const tenant = new URL('https://cupboard.supply/t/laney');
const identity = {
	repositoryId: 1234,
	repositoryOwnerId: 5678,
	fullName: 'iainlane/dotfiles',
	defaultBranch: 'main'
};
const workflowReference =
	'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v0.0.35';
const installableWorkflowReference =
	'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.35';

function triggers(...events: string[]): WorkflowTrigger[] {
	return events.map((event) => ({
		event,
		filters: {},
		hasPathFilter: false,
		...(event === 'pull_request' && {
			activityTypes: ['opened', 'synchronize', 'reopened', 'closed']
		})
	}));
}

const job: DiscoveredPublishingJob = {
	caller: '.github/workflows/cupboard.yml',
	job: 'publish',
	kind: 'flake',
	workflowRef: workflowReference,
	inputs: {
		url: tenant.href,
		preset: 'pull-request-and-branch'
	},
	triggers: triggers('push', 'pull_request')
};
const installableJob: DiscoveredPublishingJob = {
	...job,
	kind: 'installable',
	workflowRef: installableWorkflowReference,
	inputs: { url: tenant.href },
	triggers: triggers('push')
};
const repositoryClaims = {
	iss: 'https://token.actions.githubusercontent.com',
	aud: tenant.href,
	repository_id: '1234',
	repository_owner_id: '5678',
	repository: 'iainlane/dotfiles',
	repository_owner: 'iainlane'
};
const installableBranchClaims = {
	...repositoryClaims,
	sub: 'repo:iainlane/dotfiles:ref:refs/heads/main',
	event_name: 'push',
	ref: 'refs/heads/main',
	ref_type: 'branch',
	job_workflow_ref: installableWorkflowReference
};
const installableRequests = [
	pushAuthorizationDetails({ cache: { kind: 'default' }, attest: true }),
	attestAttachAuthorizationDetails({ cache: { kind: 'default' } })
];

describe('modelPublishingJob', () => {
	it.each<{ name: string; inputJob: DiscoveredPublishingJob }>([
		{
			name: 'installable workflow with publication disabled',
			inputJob: {
				...installableJob,
				inputs: { ...installableJob.inputs, publish: 'none' },
				triggers: triggers('schedule')
			}
		},
		{
			name: 'flake preset with publication disabled',
			inputJob: {
				...job,
				inputs: { ...job.inputs, publish: 'none' },
				triggers: triggers('pull_request')
			}
		},
		...(['outputs', 'closure'] as const).map((publish) => ({
			name: `flake push:false with publish:${publish}`,
			inputJob: {
				...job,
				inputs: { ...job.inputs, push: false, publish },
				triggers: triggers('pull_request')
			}
		}))
	])('models $name without write grants', ({ inputJob }) => {
		const result = modelPublishingJob(inputJob, identity, tenant, 'main');

		expect(result.cases.map(({ requests }) => requests)).toStrictEqual([[]]);
	});

	it.each(['true', '${{ inputs.manage }}', 1])(
		'rejects a non-literal lifecycle boolean %s',
		(value) => {
			expect(
				modelPublishingJob(
					{
						...installableJob,
						inputs: { ...installableJob.inputs, 'manage-pr-cache': value }
					},
					identity,
					tenant,
					'main'
				)
			).toStrictEqual({
				cases: [],
				findings: [
					{
						finding: new PublicationUnmodelledFinding(
							'manage-pr-cache must be a literal boolean'
						)
					}
				]
			});
		}
	);

	it('rejects management of the default cache before modelling publication', () => {
		expect(
			modelPublishingJob(
				{
					...installableJob,
					inputs: { ...installableJob.inputs, 'manage-pr-cache': true }
				},
				identity,
				tenant,
				'main'
			)
		).toStrictEqual({
			cases: [],
			findings: [
				{
					finding: new PublicationUnmodelledFinding(
						'manage-pr-cache requires a named cache'
					)
				}
			]
		});
	});

	it.each([
		{
			trigger: 'pull_request',
			enabled: true,
			publish: 'outputs',
			lifecycle: true
		},
		{
			trigger: 'pull_request',
			enabled: false,
			publish: 'outputs',
			lifecycle: false
		},
		{ trigger: 'push', enabled: true, publish: 'outputs', lifecycle: false },
		{
			trigger: 'pull_request',
			enabled: true,
			publish: 'none',
			lifecycle: false
		}
	])(
		'models lifecycle authority for $trigger with management $enabled and $publish publication',
		({ trigger, enabled, publish, lifecycle }) => {
			const cache = {
				kind: 'named' as const,
				name: cacheNameSchema.parse('pr-1')
			};
			const result = modelPublishingJob(
				{
					...installableJob,
					inputs: {
						...installableJob.inputs,
						cache: 'pr-1',
						'manage-pr-cache': enabled,
						publish
					},
					triggers: triggers(trigger)
				},
				identity,
				tenant,
				'main'
			);
			expect(result.cases.map(({ requests }) => requests)).toStrictEqual([
				publish === 'none'
					? []
					: [
							...(lifecycle
								? [
										cacheCreateAuthorizationDetails({ cache }),
										cacheLifecycleAuthorizationDetails({
											cache,
											action: 'close'
										}),
										cacheLifecycleAuthorizationDetails({
											cache,
											action: 'reopen'
										})
									]
								: []),
							pushAuthorizationDetails({ cache, attest: true }),
							attestAttachAuthorizationDetails({ cache })
						]
			]);
		}
	);

	it('does not apply the old flake push input to an installable workflow', () => {
		const result = modelPublishingJob(
			{
				...installableJob,
				inputs: { ...installableJob.inputs, push: false },
				triggers: triggers('schedule')
			},
			identity,
			tenant,
			'main'
		);

		expect(result.cases.map(({ requests }) => requests)).toStrictEqual([
			installableRequests
		]);
	});

	it.each([installableJob, job])(
		'rejects a string attestation mode for the $kind workflow',
		(inputJob) => {
			expect(
				modelPublishingJob(
					{ ...inputJob, inputs: { ...inputJob.inputs, attest: 'both' } },
					identity,
					tenant,
					'main'
				)
			).toStrictEqual({
				cases: [],
				findings: [
					{
						finding: new PublicationUnmodelledFinding(
							'attest must be a literal boolean'
						)
					}
				]
			});
		}
	);

	it('models the installable workflow with explicit attest: true', () => {
		const baseline = modelPublishingJob(
			{ ...installableJob, triggers: triggers('schedule') },
			identity,
			tenant,
			'main'
		);
		const result = modelPublishingJob(
			{
				...installableJob,
				inputs: { ...installableJob.inputs, attest: true },
				triggers: triggers('schedule')
			},
			identity,
			tenant,
			'main'
		);

		expect(result).toStrictEqual(baseline);
	});

	it('models both publications from the flake preset', () => {
		const result = modelPublishingJob(job, identity, tenant, 'main');
		const prCache = {
			kind: 'named' as const,
			name: cacheNameSchema.parse('gh-1234-pr-1')
		};
		const branchCache = { kind: 'default' as const };
		const prRoot = parseRootName('github:iainlane/dotfiles/pr-1/target');
		const prRunRoot = parseRootName(
			'github:iainlane/dotfiles/pr-1/_cupboard-run/1'
		);
		const branchRoot = parseRootName('github:iainlane/dotfiles/main/target');
		const branchRunRoot = parseRootName(
			'github:iainlane/dotfiles/main/_cupboard-run/1'
		);

		expect(result).toStrictEqual({
			cases: [
				{
					trigger: 'push',
					ref: { kind: 'branch', name: 'main' },
					claims: {
						...repositoryClaims,
						sub: 'repo:iainlane/dotfiles:ref:refs/heads/main',
						event_name: 'push',
						ref: 'refs/heads/main',
						ref_type: 'branch',
						job_workflow_ref: workflowReference
					},
					requests: [
						pushAuthorizationDetails({
							cache: branchCache,
							attest: true,
							root: branchRoot,
							runRoot: branchRunRoot
						}),
						rootListAuthorizationDetails({
							cache: branchCache,
							root: branchRoot
						}),
						rootEnsureAuthorizationDetails({
							cache: branchCache,
							root: branchRoot
						}),
						confirmAuthorizationDetails({ cache: branchCache })
					],
					reuseView: { name: 'pull-requests-1234', destination: tenant }
				},
				{
					trigger: 'pull_request',
					ref: { kind: 'pull-request' },
					claims: {
						...repositoryClaims,
						sub: 'repo:iainlane/dotfiles:pull_request',
						event_name: 'pull_request',
						ref: 'refs/pull/1/merge',
						ref_type: 'branch',
						job_workflow_ref: workflowReference
					},
					requests: [
						cacheCreateAuthorizationDetails({ cache: prCache }),
						cacheLifecycleAuthorizationDetails({
							cache: prCache,
							action: 'close'
						}),
						cacheLifecycleAuthorizationDetails({
							cache: prCache,
							action: 'reopen'
						}),
						pushAuthorizationDetails({
							cache: prCache,
							attest: true,
							root: prRoot,
							runRoot: prRunRoot
						}),
						rootListAuthorizationDetails({ cache: prCache, root: prRoot }),
						rootEnsureAuthorizationDetails({ cache: prCache, root: prRoot }),
						confirmAuthorizationDetails({ cache: prCache })
					]
				}
			],
			findings: [
				{ trigger: 'push', finding: new PresetPushFilterFinding('main') }
			]
		});
	});

	it('reports a scheduled run when the preset branch differs from the default branch', () => {
		const result = modelPublishingJob(
			{ ...job, triggers: triggers('schedule') },
			{ ...identity, defaultBranch: 'develop' },
			tenant,
			'main'
		);

		expect(result).toStrictEqual({
			cases: [],
			findings: [
				{
					trigger: 'schedule',
					finding: new PublicationUnmodelledFinding(
						'the branch input (main) differs from the repository default branch develop; set the branch input to develop'
					)
				}
			]
		});
	});

	it('checks other events when the preset branch differs from the default', () => {
		const selectedIdentity = { ...identity, defaultBranch: 'develop' };
		const modelled = modelPublishingJob(job, selectedIdentity, tenant, 'main');
		const result = modelPublishingJob(
			{ ...job, triggers: triggers('push', 'pull_request', 'schedule') },
			selectedIdentity,
			tenant,
			'main'
		);

		expect(result).toStrictEqual({
			cases: modelled.cases,
			findings: [
				{ trigger: 'push', finding: new PresetPushFilterFinding('main') },
				{
					trigger: 'schedule',
					finding: new PublicationUnmodelledFinding(
						'the branch input (main) differs from the repository default branch develop; set the branch input to develop'
					)
				}
			]
		});
	});

	it('checks the configured reuse view on a non-preset pull request', () => {
		const result = modelPublishingJob(
			{
				...job,
				inputs: {
					url: tenant.href,
					cache: 'packages',
					'root-prefix': 'github:iainlane/dotfiles/pr/',
					'reuse-view': 'shared'
				},
				triggers: triggers('pull_request')
			},
			identity,
			tenant,
			'main'
		);

		expect(result).toStrictEqual({
			cases: [
				{
					...result.cases[0],
					reuseView: {
						name: 'shared',
						destination: new URL(`${tenant.href}/cache/packages`)
					}
				}
			],
			findings: [
				{
					finding: new CustomReuseViewFinding('shared')
				}
			]
		});
	});

	it('does not check the reuse view that the preset disables for pull-request runs', () => {
		const pullRequestJob = { ...job, triggers: triggers('pull_request') };
		const expected = modelPublishingJob(
			pullRequestJob,
			identity,
			tenant,
			'main'
		);
		const result = modelPublishingJob(
			{
				...pullRequestJob,
				inputs: { ...job.inputs, 'reuse-view': 'shared' }
			},
			identity,
			tenant,
			'main'
		);

		expect(result).toStrictEqual({
			cases: expected.cases,
			findings: [
				{ finding: new CustomReuseViewFinding('shared') },
				...expected.findings
			]
		});
	});

	it('checks a schedule on the default branch from a pull-request branch', () => {
		const [branchCase] = modelPublishingJob(
			{ ...job, triggers: triggers('push') },
			identity,
			tenant,
			'main'
		).cases;

		expect(branchCase).toBeDefined();

		const result = modelPublishingJob(
			{ ...job, triggers: triggers('schedule') },
			identity,
			tenant,
			'feature/add-schedule'
		);

		expect(result).toStrictEqual({
			cases: [
				{
					...branchCase,
					trigger: 'schedule',
					claims: { ...branchCase?.claims, event_name: 'schedule' }
				}
			],
			findings: []
		});
	});

	it.each([
		{ events: ['push', 'schedule', 'pull_request'] },
		{ events: ['push', 'pull_request'] }
	])(
		'checks proposed preset runs for $events on the default branch',
		({ events }) => {
			const proposedJob = { ...job, triggers: triggers(...events) };
			const expected = modelPublishingJob(
				proposedJob,
				identity,
				tenant,
				'main'
			);

			expect(
				modelPublishingJob(proposedJob, identity, tenant, 'feature/proposal')
			).toStrictEqual(expected);
		}
	);

	it('checks an installable schedule from a PR branch', () => {
		const result = modelPublishingJob(
			{ ...installableJob, triggers: triggers('schedule') },
			identity,
			tenant,
			'feature/add-schedule'
		);

		expect(result).toStrictEqual({
			cases: [
				{
					trigger: 'schedule',
					ref: { kind: 'branch', name: 'main' },
					claims: { ...installableBranchClaims, event_name: 'schedule' },
					requests: installableRequests
				}
			],
			findings: []
		});
	});

	it.each(['workflow_dispatch', 'schedule'])(
		'models a preset %s run on the configured branch',
		(event) => {
			const [branchCase] = modelPublishingJob(
				{ ...job, triggers: triggers('push') },
				identity,
				tenant,
				'main'
			).cases;

			expect(branchCase).toBeDefined();

			const result = modelPublishingJob(
				{ ...job, triggers: triggers(event) },
				identity,
				tenant,
				'main'
			);

			expect(result).toStrictEqual({
				cases: [
					{
						...branchCase,
						trigger: event,
						claims: { ...branchCase?.claims, event_name: event }
					}
				],
				findings: []
			});
		}
	);

	it('reports a preset branch that differs from the selected and default branches', () => {
		const result = modelPublishingJob(
			{ ...job, triggers: triggers('push') },
			{ ...identity, defaultBranch: 'feature' },
			tenant,
			'develop'
		);

		expect(result).toStrictEqual({
			cases: [],
			findings: [
				{
					trigger: 'push',
					finding: new PublicationUnmodelledFinding(
						'the branch input (main) differs from the checked branch develop; set the branch input to develop or pass --branch main'
					)
				},
				{ trigger: 'push', finding: new PresetPushFilterFinding('main') }
			]
		});
	});

	it('models a manual run without the preset on the selected branch', () => {
		const result = modelPublishingJob(
			{ ...installableJob, triggers: triggers('workflow_dispatch') },
			identity,
			tenant,
			'main'
		);

		expect(result).toStrictEqual({
			cases: [
				{
					trigger: 'workflow_dispatch',
					ref: { kind: 'branch', name: 'main' },
					claims: {
						...installableBranchClaims,
						event_name: 'workflow_dispatch'
					},
					requests: installableRequests
				}
			],
			findings: [
				{
					trigger: 'workflow_dispatch',
					finding: new ManualRunBranchFinding('main')
				}
			]
		});
	});

	it('reports a job condition that the check cannot evaluate', () => {
		const result = modelPublishingJob(
			{
				...installableJob,
				triggers: [
					{
						event: 'push',
						filters: {},
						hasPathFilter: false,
						undecidedConditions: ["github.ref == 'refs/heads/main'"]
					}
				]
			},
			identity,
			tenant,
			'main'
		);

		expect(result).toStrictEqual({
			cases: [
				{
					trigger: 'push',
					ref: { kind: 'branch', name: 'main' },
					claims: installableBranchClaims,
					requests: installableRequests
				}
			],
			findings: [
				{
					trigger: 'push',
					finding: new JobConditionUndecidedFinding([
						"github.ref == 'refs/heads/main'"
					])
				},
				{ trigger: 'push', finding: new PushCoverageFinding('main') }
			]
		});
	});

	const namedCacheInputs: readonly Readonly<
		Record<string, string | boolean>
	>[] = [
		{ url: tenant.href, cache: 'packages', attest: false },
		{ url: `${tenant.href}/cache/packages`, attest: false }
	];

	it.each(namedCacheInputs)(
		'models the push authority for an installable job without signing from $url',
		(inputs) => {
			const result = modelPublishingJob(
				{ ...installableJob, inputs },
				identity,
				tenant,
				'main'
			);

			expect(result).toStrictEqual({
				cases: [
					{
						trigger: 'push',
						ref: { kind: 'branch', name: 'main' },
						claims: installableBranchClaims,
						requests: [
							pushAuthorizationDetails({
								cache: {
									kind: 'named',
									name: cacheNameSchema.parse('packages')
								},
								attest: true
							})
						]
					}
				],
				findings: [
					{ trigger: 'push', finding: new PushCoverageFinding('main') }
				]
			});
		}
	);

	const unresolvedCaches: readonly {
		readonly inputs: Readonly<Record<string, string>>;
		readonly reason: string;
	}[] = [
		{
			inputs: { url: `${tenant.href}/cache/packages`, 'root-prefix': 'x' },
			reason:
				'the flake workflow takes a tenant URL; use the cache input for a named cache'
		},
		{
			inputs: { url: tenant.href, cache: '${{ inputs.cache }}' },
			reason: 'cache must be a literal string'
		}
	];

	it.each(unresolvedCaches)(
		'reports a cache that the model cannot resolve: $reason',
		({ inputs, reason }) => {
			const result = modelPublishingJob(
				{ ...job, inputs },
				identity,
				tenant,
				'main'
			);

			expect(result).toStrictEqual({
				cases: [],
				findings: [{ finding: new PublicationUnmodelledFinding(reason) }]
			});
		}
	);
});

function filtered(
	event: string,
	filters: WorkflowTrigger['filters'],
	hasPathFilter = false
): DiscoveredPublishingJob {
	return { ...installableJob, triggers: [{ event, filters, hasPathFilter }] };
}

describe('modelPublishingJob inputs', () => {
	it.each<{ name: string; job: DiscoveredPublishingJob }>([
		{
			name: 'branch without the preset',
			job: {
				...job,
				inputs: {
					url: tenant.href,
					'root-prefix': 'github:iainlane/dotfiles/main',
					branch: '${{ github.ref_name }}'
				},
				triggers: triggers('schedule')
			}
		},
		{
			name: 'reuse-view on the installable workflow',
			job: {
				...installableJob,
				inputs: { url: tenant.href, 'reuse-view': '${{ vars.VIEW }}' },
				triggers: triggers('schedule')
			}
		}
	])('ignores a dynamic $name', ({ job: inputJob }) => {
		const model = modelPublishingJob(inputJob, identity, tenant, 'main');

		expect({
			findings: model.findings,
			triggers: model.cases.map((publication) => publication.trigger)
		}).toStrictEqual({ findings: [], triggers: ['schedule'] });
	});
});

describe('modelPublishingJob event filters', () => {
	const tagClaims = {
		...repositoryClaims,
		sub: 'repo:iainlane/dotfiles:ref:refs/tags/v1.2.3',
		event_name: 'push',
		ref: 'refs/tags/v1.2.3',
		ref_type: 'tag',
		job_workflow_ref: installableWorkflowReference
	};
	const tagCase = {
		trigger: 'push',
		ref: { kind: 'tag', pattern: ReferencePattern.parse('v1.2.3') },
		claims: tagClaims,
		requests: installableRequests
	};
	const branchCase = {
		trigger: 'push',
		ref: { kind: 'branch', name: 'main' },
		claims: installableBranchClaims,
		requests: installableRequests
	};

	it.each([
		{
			name: 'an exact tag-only push as a tag ref',
			job: filtered('push', { tags: ['v1.2.3'] }),
			expected: { cases: [tagCase], findings: [] }
		},
		{
			name: 'a wildcard tag-only push as unverified',
			job: filtered('push', { tags: ['v*'] }),
			expected: {
				cases: [],
				findings: [
					{ trigger: 'push', finding: new TagPatternCoverageFinding('v*') }
				]
			}
		},
		{
			name: 'branch and tag filters as both refs',
			job: filtered('push', { branches: ['main'], tags: ['v*'] }),
			expected: {
				cases: [branchCase],
				findings: [
					{ trigger: 'push', finding: new TagPatternCoverageFinding('v*') }
				]
			}
		},
		{
			name: 'a branch filter that includes the selected branch',
			job: filtered('push', { branches: ['ma*', 'release/**'] }),
			expected: {
				cases: [branchCase],
				findings: [
					{
						trigger: 'push',
						finding: new BranchFilterCoverageFinding(
							'branches',
							['ma*', 'release/**'],
							'main'
						)
					}
				]
			}
		},
		{
			name: 'a branch filter with another exact branch',
			job: filtered('push', { branches: ['main', 'develop'] }),
			expected: {
				cases: [branchCase],
				findings: [
					{
						trigger: 'push',
						finding: new BranchFilterCoverageFinding(
							'branches',
							['main', 'develop'],
							'main'
						)
					}
				]
			}
		},
		{
			name: 'an ignore filter that allows other branches',
			job: filtered('push', { 'branches-ignore': ['develop'] }),
			expected: {
				cases: [branchCase],
				findings: [
					{
						trigger: 'push',
						finding: new BranchFilterCoverageFinding(
							'branches-ignore',
							['develop'],
							'main'
						)
					}
				]
			}
		},
		{
			name: 'a branch filter that excludes the selected branch',
			job: filtered('push', { branches: ['release/**'] }),
			expected: {
				cases: [],
				findings: [
					{
						trigger: 'push',
						finding: new ReferenceFilterExcludesFinding(
							'branches',
							['release/**'],
							'main',
							'select-branch'
						)
					}
				]
			}
		},
		{
			name: 'an ignore filter that matches the selected branch',
			job: filtered('push', { 'branches-ignore': ['main'] }),
			expected: {
				cases: [],
				findings: [
					{
						trigger: 'push',
						finding: new ReferenceFilterExcludesFinding(
							'branches-ignore',
							['main'],
							'main',
							'select-branch'
						)
					}
				]
			}
		},
		{
			name: 'a pull-request filter that excludes the default branch',
			job: filtered('pull_request', { branches: ['develop'] }),
			expected: {
				cases: [],
				findings: [
					{
						trigger: 'pull_request',
						finding: new ReferenceFilterExcludesFinding(
							'branches',
							['develop'],
							'main',
							'none'
						)
					}
				]
			}
		},
		{
			name: 'a pattern that the check cannot evaluate',
			job: filtered('push', { tags: ['v[0-9]+'] }),
			expected: {
				cases: [],
				findings: [
					{
						trigger: 'push',
						finding: new ReferenceFilterUnsupportedFinding('tags', 'v[0-9]+')
					}
				]
			}
		},
		{
			name: 'a tags-ignore filter',
			job: filtered('push', { 'tags-ignore': ['nightly'] }),
			expected: {
				cases: [],
				findings: [
					{
						trigger: 'push',
						finding: new TagsIgnoreUnmodelledFinding(['nightly'])
					}
				]
			}
		},
		{
			name: 'a paths filter as a note',
			job: filtered('push', {}, true),
			expected: {
				cases: [branchCase],
				findings: [
					{ trigger: 'push', finding: new PathFilterNotModelledFinding() },
					{ trigger: 'push', finding: new PushCoverageFinding('main') }
				]
			}
		}
	])('models $name', ({ job: filteredJob, expected }) => {
		expect(
			modelPublishingJob(filteredJob, identity, tenant, 'main')
		).toStrictEqual(expected);
	});

	it('reports a preset tag push as failed', () => {
		const result = modelPublishingJob(
			{
				...job,
				triggers: [
					{ event: 'push', filters: { tags: ['v*'] }, hasPathFilter: false }
				]
			},
			identity,
			tenant,
			'main'
		);

		expect(result).toStrictEqual({
			cases: [],
			findings: [{ trigger: 'push', finding: new PresetTagPushFinding() }]
		});
	});
});

function presetPush(
	filters: WorkflowTrigger['filters']
): DiscoveredPublishingJob {
	return {
		...job,
		triggers: [{ event: 'push', filters, hasPathFilter: false }]
	};
}

describe('modelPublishingJob push coverage', () => {
	it.each([
		{
			name: 'an unfiltered push without the preset',
			job: installableJob,
			findings: [{ trigger: 'push', finding: new PushCoverageFinding('main') }]
		},
		{
			name: 'an unfiltered push with the preset',
			job: presetPush({}),
			findings: [
				{ trigger: 'push', finding: new PresetPushFilterFinding('main') }
			]
		},
		{
			name: 'a preset push filtered to its branch',
			job: presetPush({ branches: ['main'] }),
			findings: []
		},
		{
			name: 'a preset push whose filter excludes its branch',
			job: presetPush({ branches: ['release/**'] }),
			findings: [
				{
					trigger: 'push',
					finding: new ReferenceFilterExcludesFinding(
						'branches',
						['release/**'],
						'main',
						'change-filter'
					)
				}
			]
		}
	])('reports $name', ({ job: pushJob, findings }) => {
		expect(
			modelPublishingJob(pushJob, identity, tenant, 'main').findings
		).toStrictEqual(findings);
	});
});

it('models merged-close claims separately without publication or reads', () => {
	const model = modelPublishingJob(job, identity, tenant, 'main');
	const merged = withMergedCloseCases(model.cases, identity).filter(
		(entry) => entry.lifecycle === 'merged-close'
	);
	expect(merged).toStrictEqual([
		{
			trigger: 'pull_request',
			ref: { kind: 'pull-request' },
			lifecycle: 'merged-close',
			claims: {
				iss: 'https://token.actions.githubusercontent.com',
				aud: tenant.href,
				repository_id: '1234',
				repository_owner_id: '5678',
				repository: identity.fullName,
				repository_owner: 'iainlane',
				sub: `repo:${identity.fullName}:pull_request`,
				event_name: 'pull_request',
				ref: 'refs/heads/main',
				ref_type: 'branch',
				job_workflow_ref: workflowReference
			},
			requests: [
				cacheLifecycleAuthorizationDetails({
					cache: { kind: 'named', name: cacheNameSchema.parse('gh-1234-pr-1') },
					action: 'close'
				})
			]
		}
	]);
});

it.each([
	{
		name: 'missing closed activity',
		activityTypes: ['opened', 'reopened'],
		condition: undefined,
		close: false,
		reopen: true,
		merged: false
	},
	{
		name: 'closed condition blocked',
		activityTypes: ['closed', 'reopened'],
		condition: "github.event.action != 'closed'",
		close: false,
		reopen: true,
		merged: false
	},
	{
		name: 'merged condition blocked',
		activityTypes: ['closed', 'reopened'],
		condition: '!github.event.pull_request.merged',
		close: true,
		reopen: true,
		merged: false
	},
	{
		name: 'reopened condition blocked',
		activityTypes: ['closed', 'reopened'],
		condition: "github.event.action != 'reopened'",
		close: true,
		reopen: false,
		merged: true
	}
])(
	'omits lifecycle authority for $name',
	({ activityTypes, condition, close, reopen, merged }) => {
		const model = modelPublishingJob(
			{
				...job,
				triggers: [
					{
						event: 'pull_request',
						filters: {},
						hasPathFilter: false,
						activityTypes,
						...(condition !== undefined && { undecidedConditions: [condition] })
					}
				]
			},
			identity,
			tenant,
			'main'
		);
		expect({
			requests: model.cases.flatMap((publication) =>
				publication.requests.filter((request) =>
					request.some(
						(detail) =>
							detail.type === 'cupboard_cache' &&
							detail.actions.some(
								(action) =>
									action === 'cache:close' || action === 'cache:reopen'
							)
					)
				)
			),
			merged: withMergedCloseCases(model.cases, identity)
				.filter((publication) => publication.lifecycle === 'merged-close')
				.map((publication) => publication.requests)
		}).toStrictEqual({
			requests: [
				...(close
					? [
							cacheLifecycleAuthorizationDetails({
								cache: {
									kind: 'named',
									name: cacheNameSchema.parse('gh-1234-pr-1')
								},
								action: 'close'
							})
						]
					: []),
				...(reopen
					? [
							cacheLifecycleAuthorizationDetails({
								cache: {
									kind: 'named',
									name: cacheNameSchema.parse('gh-1234-pr-1')
								},
								action: 'reopen'
							})
						]
					: [])
			],
			merged: merged
				? [
						[
							cacheLifecycleAuthorizationDetails({
								cache: {
									kind: 'named',
									name: cacheNameSchema.parse('gh-1234-pr-1')
								},
								action: 'close'
							})
						]
					]
				: []
		});
	}
);
