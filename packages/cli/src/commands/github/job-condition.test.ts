import { expect, it } from 'vitest';

import {
	jobConditionOutcome,
	type JobDependencyGate,
	jobDependencyOutcome
} from './job-condition.ts';

it.each(
	[
		{ condition: "github.event.action == 'closed'", expected: false },
		{
			condition: "success() && github.event.action == 'closed'",
			expected: false
		},
		{
			condition: "always() && github.event.action == 'closed'",
			expected: true
		},
		{
			condition: "!cancelled() && github.event.action == 'closed'",
			expected: true
		}
	].flatMap((scenario) =>
		['always()', '!cancelled()'].map((middleCondition) => ({
			...scenario,
			middleCondition
		}))
	)
)(
	'preserves skipped ancestors through $middleCondition for $condition',
	({ condition, middleCondition, expected }) => {
		const gate: JobDependencyGate = {
			condition,
			dependencies: [
				{
					condition: middleCondition,
					dependencies: [
						{ condition: "github.event.action != 'closed'", dependencies: [] }
					]
				}
			]
		};
		expect(
			jobDependencyOutcome(gate, {
				action: 'closed',
				merged: false,
				isCancelled: false
			})
		).toBe(expected);
	}
);

it.each(['always()', '!cancelled()'])(
	'does not verify %s with an unresolved dependency graph',
	(status) => {
		expect(
			jobDependencyOutcome(
				{
					condition: `${status} && github.event.action == 'closed'`,
					dependencies: 'unknown'
				},
				{ action: 'closed', merged: false, isCancelled: false }
			)
		).toBeUndefined();
	}
);

it.each(
	[
		{
			condition: "!cancelled() && github.event.action == 'closed'",
			expected: true
		},
		{ condition: 'cancelled()', expected: false }
	].flatMap((scenario) => [
		{ ...scenario, isCancelled: false },
		{
			condition: scenario.condition,
			expected: !scenario.expected,
			isCancelled: true
		}
	])
)(
	'evaluates $condition in a lifecycle run with cancellation $isCancelled',
	({ condition, expected, isCancelled }) => {
		expect(
			jobDependencyOutcome(
				{ condition, dependencies: [{ condition: false, dependencies: [] }] },
				{ action: 'closed', merged: false, isCancelled }
			)
		).toBe(expected);
		expect(jobConditionOutcome(condition, 'pull_request')).toBeUndefined();
	}
);

it.each(['always()', '!cancelled()'])(
	'allows %s to bypass an unknown condition on a verified dependency graph',
	(condition) => {
		expect(
			jobDependencyOutcome(
				{
					condition,
					dependencies: [
						{ condition: "inputs.publish == 'true'", dependencies: [] }
					]
				},
				{ action: 'closed', merged: false, isCancelled: false }
			)
		).toBe(true);
	}
);

it.each([
	{
		condition: "github.event.action != 'closed'",
		closed: false,
		merged: false,
		reopened: true
	},
	{
		condition: 'github.event.pull_request.merged == false',
		closed: true,
		merged: false,
		reopened: true
	},
	{
		condition: '!github.event.pull_request.merged',
		closed: true,
		merged: false,
		reopened: true
	},
	{
		condition:
			"github.event.action == 'closed' && github.event.pull_request.merged",
		closed: false,
		merged: true,
		reopened: false
	},
	{
		condition: "github.ref == 'refs/heads/main'",
		closed: undefined,
		merged: true,
		reopened: undefined
	},
	{
		condition:
			"github.event.action != 'closed' && needs.build.result == 'success'",
		closed: false,
		merged: false,
		reopened: undefined
	}
])(
	'evaluates lifecycle condition $condition',
	({ condition, closed, merged, reopened }) => {
		expect({
			closed: jobConditionOutcome(condition, 'pull_request', 'repository', {
				action: 'closed',
				merged: false
			}),
			merged: jobConditionOutcome(condition, 'pull_request', 'repository', {
				action: 'closed',
				merged: true,
				ref: 'refs/heads/main'
			}),
			reopened: jobConditionOutcome(condition, 'pull_request', 'repository', {
				action: 'reopened',
				merged: false
			})
		}).toStrictEqual({ closed, merged, reopened });
		expect(jobConditionOutcome(condition, 'pull_request')).toBeUndefined();
	}
);

it.each([
	{ condition: "github.event_name == 'push'", push: true, pullRequest: false },
	{ condition: "github.event_name != 'push'", push: false, pullRequest: true },
	{
		condition: "${{ github.event_name == 'PULL_REQUEST' }}",
		push: false,
		pullRequest: true
	},
	{
		condition: "'push' == github.event_name && github.ref == 'refs/heads/main'",
		push: undefined,
		pullRequest: false
	},
	{
		condition:
			"github.event_name == 'pull_request' || github.event_name == 'push'",
		push: true,
		pullRequest: true
	},
	{
		condition:
			"github.event_name == 'pull_request' || contains(github.ref, 'release')",
		push: undefined,
		pullRequest: true
	},
	{
		condition: "!(github.event_name == 'push')",
		push: false,
		pullRequest: true
	},
	{
		condition: "github.event.inputs['publish'] == 'true'",
		push: undefined,
		pullRequest: undefined
	},
	{
		condition: "!github.event_name == 'push'",
		push: undefined,
		pullRequest: undefined
	},
	{
		condition: "!github.event_name != 'push'",
		push: undefined,
		pullRequest: undefined
	},
	{ condition: 'always()', push: true, pullRequest: true },
	{
		condition: "success() && github.event_name == 'push'",
		push: true,
		pullRequest: false
	},
	{
		condition:
			"${{ github.event_name != 'pull_request' ||\ngithub.event.pull_request.head.repo.id == github.repository_id }}",
		push: true,
		pullRequest: true
	},
	{
		condition:
			'github.repository == github.event.pull_request.head.repo.full_name',
		push: false,
		pullRequest: true
	},
	{ condition: '!cancelled()', push: undefined, pullRequest: undefined },
	{
		condition: "github.event_name == 'push",
		push: undefined,
		pullRequest: undefined
	},
	{ condition: false, push: false, pullRequest: false }
])('evaluates $condition', ({ condition, push, pullRequest }) => {
	expect({
		push: jobConditionOutcome(condition, 'push'),
		pullRequest: jobConditionOutcome(condition, 'pull_request')
	}).toStrictEqual({ push, pullRequest });
});

it.each([
	{
		condition: 'github.event.pull_request.head.repo.id == github.repository_id',
		repository: true,
		fork: false
	},
	{
		condition:
			"github.event_name == 'pull_request' || github.event.pull_request.head.repo.id == github.repository_id",
		repository: true,
		fork: true
	},
	{
		condition:
			'!cancelled() && github.event.pull_request.head.repo.full_name == github.repository',
		repository: undefined,
		fork: false
	}
])(
	'evaluates $condition for pull requests from the repository and from forks',
	({ condition, repository, fork }) => {
		expect({
			repository: jobConditionOutcome(condition, 'pull_request', 'repository'),
			fork: jobConditionOutcome(condition, 'pull_request', 'fork')
		}).toStrictEqual({ repository, fork });
	}
);

it.each([
	{ ref: 'refs/heads/main', expected: true },
	{ ref: 'refs/heads/release', expected: false },
	{ ref: undefined, expected: undefined }
])('evaluates a push condition with verified ref $ref', ({ ref, expected }) => {
	expect(
		jobConditionOutcome(
			"github.event_name == 'push' && github.ref == 'refs/heads/main'",
			'push',
			'repository',
			{ ref }
		)
	).toBe(expected);
});
