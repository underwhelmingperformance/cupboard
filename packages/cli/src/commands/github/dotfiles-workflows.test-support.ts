import { readFile } from 'node:fs/promises';

import { parseDocument } from 'yaml';

export const dotfilesCaller = '.github/workflows/cupboard.yml';
export const dotfilesReusable = '.github/workflows/cupboard-publish.yml';

/**
`callerPush` replaces the `push` input that `cupboard.yml` passes to
`cupboard-publish.yml`, and `push` replaces the one that
`cupboard-publish.yml` passes to cupboard. `cupboardInputs` adds or
replaces other inputs that `cupboard-publish.yml` passes to cupboard.
`declaredPush` renames the `push` input that `cupboard-publish.yml`
declares.
*/
export interface DotfilesWorkflowOptions {
	readonly callerPush?: boolean | string;
	readonly push?: boolean | string;
	readonly cupboardInputs?: Readonly<Record<string, string>>;
	readonly declaredPush?: string;
}

/**
The workflow files of iainlane/dotfiles, keyed by path. `cupboard.yml`
calls `cupboard-publish.yml` without setting its `push` input, which
defaults to true. `cupboard-publish.yml` passes `push` to cupboard's trusted
flake workflow as an expression.
*/
export async function dotfilesWorkflows(
	options: DotfilesWorkflowOptions = {}
): Promise<Record<string, string>> {
	const directory = new URL(
		'../../../../../tests/fixtures/github-actions/dotfiles/',
		import.meta.url
	);
	const caller = parseDocument(
		await readFile(new URL('cupboard.yml', directory), 'utf8')
	);
	const reusable = parseDocument(
		await readFile(new URL('cupboard-publish.yml', directory), 'utf8')
	);

	if (options.callerPush !== undefined) {
		caller.setIn(['jobs', 'publish', 'with'], { push: options.callerPush });
	}

	if (options.push !== undefined) {
		reusable.setIn(['jobs', 'publish', 'with', 'push'], options.push);
	}

	const cupboardInputs = Object.entries(options.cupboardInputs ?? {});

	for (const [name, value] of cupboardInputs) {
		reusable.setIn(['jobs', 'publish', 'with', name], value);
	}

	if (options.declaredPush !== undefined) {
		const inputs = ['on', 'workflow_call', 'inputs'];
		const declaration: unknown = reusable.getIn([...inputs, 'push'], true);

		reusable.deleteIn([...inputs, 'push']);
		reusable.setIn([...inputs, options.declaredPush], declaration);
	}

	return {
		[dotfilesCaller]: caller.toString(),
		[dotfilesReusable]: reusable.toString()
	};
}

/**
The expression that `cupboard-publish.yml` passes to cupboard as `push`.
*/
export async function dotfilesPushExpression(): Promise<string> {
	const workflows = await dotfilesWorkflows();
	const push = parseDocument(workflows[dotfilesReusable] ?? '').getIn([
		'jobs',
		'publish',
		'with',
		'push'
	]);

	if (typeof push !== 'string') {
		throw new TypeError('the dotfiles fixture must pass push as a string');
	}

	return push;
}
