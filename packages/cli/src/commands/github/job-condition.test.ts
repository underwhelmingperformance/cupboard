import { expect, it } from 'vitest';

import {
	evaluateExpression,
	expressionInputs,
	type ExpressionRun,
	jobConditionOutcome,
	type JobDependencyGate,
	jobDependencyOutcome
} from './job-condition.ts';

const dotfilesPush = `\${{ inputs.push &&
    (
      github.event_name != 'pull_request' ||
      github.event.pull_request.head.repo.full_name == github.repository
    )
}}`;

const pushRun: ExpressionRun = {
	event: 'push',
	repository: { fullName: 'acme/app', id: 1234 },
	ref: 'refs/heads/main',
	inputs: { push: true, empty: '', label: 'Release' }
};

const pullRequestRun: ExpressionRun = {
	event: 'pull_request',
	repository: { fullName: 'acme/app', id: 1234 },
	inputs: { push: true }
};

it.each([
	{ source: '${{ true }}', run: pushRun, value: true },
	{ source: '${{ null }}', run: pushRun, value: undefined },
	{ source: "${{ null == '' }}", run: pushRun, value: true },
	{ source: '${{ 1.5 }}', run: pushRun, value: 1.5 },
	{ source: '${{ -2 }}', run: pushRun, value: -2 },
	{ source: "${{ 'it''s' }}", run: pushRun, value: "it's" },
	{ source: "${{ inputs.push && 'yes' }}", run: pushRun, value: 'yes' },
	{
		source: "${{ inputs.push && 'yes' }}",
		run: { ...pushRun, inputs: { push: false } },
		value: false
	},
	{
		source: "${{ inputs.empty || 'fallback' }}",
		run: pushRun,
		value: 'fallback'
	},
	{
		source: "${{ inputs.label || 'fallback' }}",
		run: pushRun,
		value: 'Release'
	},
	{ source: '${{ inputs.empty && inputs.label }}', run: pushRun, value: '' },
	{ source: '${{ !inputs.push }}', run: pushRun, value: false },
	{ source: '${{ !inputs.empty }}', run: pushRun, value: true },
	{ source: "${{ inputs.LABEL == 'release' }}", run: pushRun, value: true },
	{ source: "${{ github.event_name == 'PUSH' }}", run: pushRun, value: true },
	{ source: "${{ 1 == '1' }}", run: pushRun, value: true },
	...[
		{ number: "'0x10'", expected: '16' },
		{ number: "'0x0000000010'", expected: '16' },
		{ number: "'0x7FFFFFFF'", expected: '2147483647' },
		{ number: "'0x80000000'", expected: '-2147483648' },
		{ number: "'0xFFFFFFFF'", expected: '-1' },
		{ number: '0xFFFFFFFF', expected: '-1' },
		{ number: "'0o17777777777'", expected: '2147483647' },
		{ number: "'0o20000000000'", expected: '-2147483648' },
		{ number: "'0o37777777777'", expected: '-1' },
		{ number: "'Infinity'", expected: 'Infinity' },
		{ number: "'-Infinity'", expected: '-Infinity' }
	].map(({ number, expected }) => ({
		source: `\${{ ${number} == ${expected} }}`,
		run: pushRun,
		value: true
	})),
	// The runner reads a `0x` or `0o` integer beyond 32 bits as NaN, which is
	// not equal to any number.
	...["'0x100000000'", "'0o40000000000'"].map((number) => ({
		source: `\${{ ${number} == 4294967296 || ${number} == 0 }}`,
		run: pushRun,
		value: false
	})),
	{ source: "${{ '' == 0 }}", run: pushRun, value: true },
	{ source: "${{ 'abc' == 0 }}", run: pushRun, value: false },
	{ source: '${{ true == 1 }}', run: pushRun, value: true },
	{ source: "${{ true == 'true' }}", run: pushRun, value: false },
	{ source: '${{ null == 0 }}', run: pushRun, value: true },
	{
		source: "${{ github.ref != 'refs/heads/main' }}",
		run: pushRun,
		value: false
	},
	{
		source: '${{ github.event.pull_request.head.repo.full_name }}',
		run: pushRun,
		value: ''
	},
	{
		source:
			'${{ github.event.pull_request.head.repo.id == github.repository_id }}',
		run: pullRequestRun,
		value: true
	},
	{ source: dotfilesPush, run: pushRun, value: true },
	{ source: dotfilesPush, run: pullRequestRun, value: true },
	{
		source: dotfilesPush,
		run: { ...pullRequestRun, inputs: { push: false } },
		value: false
	}
])('evaluates $source', ({ source, run, value }) => {
	expect(evaluateExpression(source, run)).toStrictEqual({
		outcome: 'value',
		value
	});
});

it.each([
	{
		source: "${{ github.ref == 'refs/heads/main' }}",
		run: pullRequestRun,
		part: 'github.ref'
	},
	{ source: '${{ inputs.missing }}', run: pushRun, part: 'inputs.missing' },
	{
		source: '${{ inputs.constructor }}',
		run: pushRun,
		part: 'inputs.constructor'
	},
	{ source: '${{ inputs.__proto__ }}', run: pushRun, part: 'inputs.__proto__' },
	{
		source: "${{ contains(github.ref, 'main') }}",
		run: pushRun,
		part: 'contains()'
	},
	{
		source: "${{ false && contains(github.ref, 'main') }}",
		run: pushRun,
		part: 'contains()'
	},
	{ source: '${{ success() }}', run: pushRun, part: 'success()' },
	{ source: '${{ vars.PUBLISH }}', run: pushRun, part: 'vars.PUBLISH' },
	{ source: "${{ secrets.TOKEN != '' }}", run: pushRun, part: 'secrets.TOKEN' },
	{
		source: "${{ steps.plan.outputs.publish == 'true' }}",
		run: pushRun,
		part: 'steps.plan.outputs.publish'
	},
	{
		source: '${{ needs.plan.outputs.publish }}',
		run: pushRun,
		part: 'needs.plan.outputs.publish'
	},
	{ source: "${{ github.actor == 'me' }}", run: pushRun, part: 'github.actor' },
	{
		source: "${{ github.event.action == 'closed' }}",
		run: pullRequestRun,
		part: 'github.event.action'
	},
	{
		source: "${{ inputs['push'] }}",
		run: pushRun,
		part: 'inputs[...]'
	},
	{ source: '${{ 1 < 2 }}', run: pushRun, part: 'the < operator' },
	{ source: 'true', run: pushRun, part: "'true'" },
	{
		source: 'pr-${{ inputs.push }}',
		run: pushRun,
		part: "'pr-${{ inputs.push }}'"
	},
	{
		source: '${{ inputs.push && }}',
		run: pushRun,
		part: "the expression '${{ inputs.push && }}'"
	}
])('reports $part as unsupported in $source', ({ source, run, part }) => {
	expect(evaluateExpression(source, run)).toStrictEqual({
		outcome: 'unsupported',
		part
	});
});

it.each([
	{
		source: dotfilesPush,
		expected: { outcome: 'supported', inputs: ['push'] }
	},
	{
		source:
			"${{ inputs.Push && inputs.push && github.ref == 'refs/heads/main' }}",
		expected: { outcome: 'supported', inputs: ['push'] }
	},
	{
		source: "${{ inputs.push && format('{0}', github.ref) }}",
		expected: { outcome: 'unsupported', part: 'format()' }
	},
	{
		source: "${{ inputs.push && github.head_ref == 'main' }}",
		expected: { outcome: 'unsupported', part: 'github.head_ref' }
	}
])('lists the inputs of $source', ({ source, expected }) => {
	expect(expressionInputs(source)).toStrictEqual(expected);
});

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
