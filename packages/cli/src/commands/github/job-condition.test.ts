import { expect, it } from 'vitest';

import { jobConditionOutcome } from './job-condition.ts';

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
