import { describe, expect, it } from 'vitest';

import {
	type CommandStream,
	isGithubActions,
	workflowCommands
} from './github-actions.ts';

function captureStream(): { stream: CommandStream; lines: string[] } {
	const lines: string[] = [];

	return {
		stream: {
			write: (chunk: string) => {
				lines.push(chunk);
				return true;
			}
		},
		lines
	};
}

function commandsUnder(environment: Record<string, string | undefined>): {
	commands: ReturnType<typeof workflowCommands>;
	out: string[];
	err: string[];
} {
	const out = captureStream();
	const error = captureStream();

	return {
		commands: workflowCommands({
			stdout: out.stream,
			stderr: error.stream,
			environment
		}),
		out: out.lines,
		err: error.lines
	};
}

describe('workflowCommands', () => {
	it('writes workflow commands to the out stream under GitHub Actions', () => {
		const { commands, out, err } = commandsUnder({ GITHUB_ACTIONS: 'true' });

		commands.notice('built');
		commands.warning('no key');
		commands.error('it failed');

		expect({ out, err }).toStrictEqual({
			out: ['::notice::built\n', '::warning::no key\n', '::error::it failed\n'],
			err: []
		});
	});

	it('escapes the characters the command syntax reserves', () => {
		const { commands, out } = commandsUnder({ GITHUB_ACTIONS: 'true' });

		commands.error('100% broken\nsecond line');

		expect(out).toStrictEqual(['::error::100%25 broken%0Asecond line\n']);
	});

	it('prints plain text off GitHub Actions, errors on the err stream', () => {
		const { commands, out, err } = commandsUnder({});

		commands.notice('built');
		commands.error('it failed');

		expect({ out, err }).toStrictEqual({
			out: ['built\n'],
			err: ['it failed\n']
		});
	});

	it('opens and closes collapsible groups under GitHub Actions', () => {
		const { commands, out } = commandsUnder({ GITHUB_ACTIONS: 'true' });

		commands.group('Installing 100%');
		commands.endGroup();

		expect(out).toStrictEqual([
			'::group::Installing 100%25\n',
			'::endgroup::\n'
		]);
	});

	it('prints the group title plainly off GitHub Actions', () => {
		const { commands, out } = commandsUnder({});

		commands.group('Installing');
		commands.endGroup();

		expect(out).toStrictEqual(['Installing\n']);
	});

	it('reports where it runs from the environment contract', () => {
		expect({
			on: isGithubActions({ GITHUB_ACTIONS: 'true' }),
			off: isGithubActions({}),
			other: isGithubActions({ GITHUB_ACTIONS: '1' })
		}).toStrictEqual({ on: true, off: false, other: false });
	});
});
