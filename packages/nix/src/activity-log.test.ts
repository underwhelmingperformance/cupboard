import { storePathSchema } from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import {
	builderFailures,
	buildFailureStatuses,
	copySources,
	firstBuildFailure,
	isReadActivityLogLine,
	unreachableBuilders
} from './activity-log.ts';

const appPath = storePathSchema.parse(
	'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
);
const libraryPath = storePathSchema.parse(
	'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib'
);

function copyLine(storePath: string, source: string): string {
	return JSON.stringify({
		action: 'start',
		id: 2,
		level: 3,
		parent: 0,
		text: `copying path '${storePath}' from '${source}' to 'local'`,
		type: 100,
		fields: [storePath, source, 'local']
	});
}

describe('copySources', () => {
	it.each([
		{
			name: 'one source per copied path',
			logs: [
				[
					copyLine(appPath, 'https://cache.nixos.org'),
					copyLine(libraryPath, 'ssh://builder-1')
				].join('\n')
			],
			expected: new Map([
				[appPath, ['https://cache.nixos.org']],
				[libraryPath, ['ssh://builder-1']]
			])
		},
		{
			name: 'each source of a path copied more than once, in the logged order',
			logs: [
				[
					copyLine(appPath, 'https://first.example'),
					copyLine(appPath, 'https://second.example'),
					copyLine(appPath, 'https://first.example')
				].join('\n')
			],
			expected: new Map([
				[appPath, ['https://first.example', 'https://second.example']]
			])
		},
		{
			name: 'the sources from the logs of every attempt in one run',
			logs: [
				copyLine(appPath, 'https://first.example'),
				copyLine(appPath, 'https://second.example')
			],
			expected: new Map([
				[appPath, ['https://first.example', 'https://second.example']]
			])
		},
		{
			name: 'no sources from records of other shapes',
			logs: [
				[
					'not json at all',
					JSON.stringify({ action: 'stop', id: 2 }),
					JSON.stringify({
						action: 'start',
						type: 108,
						fields: [appPath, 'https://cache.nixos.org']
					}),
					JSON.stringify({
						action: 'start',
						type: 100,
						fields: ['plain', 'https://cache.nixos.org', 'local']
					}),
					JSON.stringify({
						action: 'start',
						type: 100,
						fields: [appPath, '', 'local']
					}),
					''
				].join('\n')
			],
			expected: new Map()
		},
		{
			name: 'no sources for a run without logs',
			logs: [],
			expected: new Map()
		}
	])('extracts $name', ({ logs, expected }) => {
		expect(copySources(logs)).toStrictEqual(expected);
	});
});

function colour(text: string): string {
	return `\u{1B}[35;1m${text}\u{1B}[0m`;
}

// Nix 2.34.8 logs an error from a local build with `msg`, which has the
// `error: ` prefix and indents the lines after the first, and with `raw_msg`,
// which has neither. A build through the daemon logs only `msg`.
function localError(text: string): string {
	return JSON.stringify({
		action: 'msg',
		level: 0,
		msg: `\u{1B}[31;1merror:\u{1B}[0m ${text.replaceAll('\n', '\n       ')}`,
		raw_msg: text
	});
}

function daemonError(text: string): string {
	return JSON.stringify({
		action: 'msg',
		level: 0,
		msg: `\u{1B}[31;1merror:\u{1B}[0m ${text.replaceAll('\n', '\n       ')}`
	});
}

const errorForms = [
	{ form: 'a local build', error: localError },
	{ form: 'a build through the daemon', error: daemonError }
];

const requiredFeatures = '{kvm}';
const availableFeatures = '{benchmark}';
const appDerivation = `${appPath}.drv`;
const libraryDerivation = `${libraryPath}.drv`;

describe('buildFailureStatuses', () => {
	describe.each(errorForms)('in the log of $form', ({ error }) => {
		it.each([
			{
				name: 'a non-deterministic build',
				text: `derivation '${colour(appDerivation)}' may not be deterministic: output ${colour(`"${appPath}"`)} differs`,
				expected: [{ kind: 'not-deterministic', derivation: appDerivation }]
			},
			{
				name: 'missing system features',
				text: `Cannot build '${colour(appDerivation)}'.\nReason: \u{1B}[31;1mmissing system features\u{1B}[0m\nRequired features: ${requiredFeatures}\nAvailable features: ${availableFeatures}`,
				expected: [{ kind: 'input-rejected', derivation: appDerivation }]
			},
			{
				name: 'a platform mismatch',
				text: `Cannot build '${colour(appDerivation)}'.\nReason: \u{1B}[31;1mplatform mismatch\u{1B}[0m\nRequired system: '${colour('riscv64-linux')}'\nCurrent system: '${colour('aarch64-darwin')}'`,
				expected: [{ kind: 'input-rejected', derivation: appDerivation }]
			},
			{
				name: 'disabled local builds',
				text: `Cannot build '${colour(appDerivation)}'.\nReason: \u{1B}[31;1mlocal builds are disabled\u{1B}[0m (max-jobs = 0)`,
				expected: [{ kind: 'input-rejected', derivation: appDerivation }]
			},
			{
				name: 'a failed dependency',
				text: `Cannot build '${colour(appDerivation)}'.\nReason: \u{1B}[31;1m2 dependencies failed\u{1B}[0m.\nOutput paths:\n  ${colour(appPath)}`,
				expected: [{ kind: 'dependency-failed', derivation: appDerivation }]
			},
			{
				name: 'a timeout, which has no derivation',
				text: 'timed out after 3600 seconds',
				expected: [{ kind: 'timed-out' }]
			},
			{
				name: 'a timeout that the build hook reports for a remote machine',
				text: `build of '${colour(appDerivation)}' on '${colour('ssh-ng://builder.example')}' failed: timed out after 3600 seconds`,
				expected: [{ kind: 'timed-out', derivation: appDerivation }]
			},
			{
				name: 'a builder that wrote too much log output',
				text: `building derivation '${colour(appDerivation)}' killed after writing more than 67108864 bytes of log output`,
				expected: [{ kind: 'log-limit-exceeded', derivation: appDerivation }]
			},
			{
				name: 'a hash mismatch in a fixed-output derivation',
				text: `hash mismatch in fixed-output derivation '${colour(appDerivation)}':\n  specified: ${colour('sha256-AAAA')}\n     got:    ${colour('sha256-BBBB')}`,
				expected: [{ kind: 'output-rejected', derivation: appDerivation }]
			},
			{
				name: 'a hash mismatch that the build hook reports for a remote machine',
				text: `build of '${colour(appDerivation)}' on '${colour('ssh-ng://builder.example')}' failed: hash mismatch in fixed-output derivation '${colour(appDerivation)}':\n  specified: ${colour('sha256-AAAA')}\n     got:    ${colour('sha256-BBBB')}`,
				expected: [{ kind: 'output-rejected', derivation: appDerivation }]
			},
			{
				name: 'a builder that produced no output',
				text: `builder for '${colour(appDerivation)}' failed to produce output path for output '${colour('out')}' at ${colour(`"${appPath}"`)}`,
				expected: [{ kind: 'output-rejected', derivation: appDerivation }]
			},
			{
				name: 'an output with a reference that it may not have',
				text: `output '${colour(appPath)}' is not allowed to refer to the following paths:\n  ${colour(libraryPath)}`,
				expected: [{ kind: 'output-rejected' }]
			},
			{
				name: 'a failed builder, which has no status of its own',
				text: `Cannot build '${colour(appDerivation)}'.\nReason: \u{1B}[31;1mbuilder failed with exit code 1\u{1B}[0m.\nOutput paths:\n  ${colour(appPath)}`,
				expected: []
			},
			{
				name: 'a failed builder whose log tail quotes a timeout and a mismatch',
				text: `Cannot build '${colour(appDerivation)}'.\nReason: \u{1B}[31;1mbuilder failed with exit code 1\u{1B}[0m.\nOutput paths:\n  ${colour(appPath)}\nLast 2 log lines:\n> timed out after 30 seconds\n> derivation '${libraryDerivation}' may not be deterministic: output "${libraryPath}" differs`,
				expected: []
			}
		])('reads $name', ({ text, expected }) => {
			expect(buildFailureStatuses(error(text))).toStrictEqual(expected);
		});
	});

	it('lists the statuses in log order and ignores other records', () => {
		expect(
			buildFailureStatuses(
				[
					'malformed',
					JSON.stringify({
						action: 'msg',
						level: 3,
						msg: 'timed out after 1 seconds'
					}),
					daemonError(
						`Cannot build '${libraryDerivation}'.\nReason: 1 dependency failed.`
					),
					daemonError('timed out after 1 seconds')
				].join('\n')
			)
		).toStrictEqual([
			{ kind: 'dependency-failed', derivation: libraryDerivation },
			{ kind: 'timed-out' }
		]);
	});
});

describe('unreachableBuilders', () => {
	it.each([
		{
			name: 'a remote builder that the hook failed to use',
			lines: [
				daemonError(
					`cannot build on '${colour('ssh-ng://builder.example')}': failed to start SSH connection`
				)
			],
			expected: ['ssh-ng://builder.example']
		},
		{
			name: 'each remote builder in log order',
			lines: [
				localError("cannot build on 'ssh://first.example': connection refused"),
				localError("cannot build on 'ssh://second.example': connection refused")
			],
			expected: ['ssh://first.example', 'ssh://second.example']
		},
		{
			name: 'a log with only the hook warning that no machine matches',
			lines: [
				JSON.stringify({
					action: 'msg',
					level: 1,
					msg: 'Failed to find a machine for remote build!\nderivation: app.drv'
				})
			],
			expected: []
		},
		{
			name: 'a builder log tail that quotes the message',
			lines: [
				daemonError(
					`Cannot build '${appDerivation}'.\nReason: builder failed with exit code 1.\nLast 1 log lines:\n> cannot build on 'ssh://quoted.example': refused`
				)
			],
			expected: []
		}
	])('reads $name', ({ lines, expected }) => {
		expect(unreachableBuilders(lines.join('\n'))).toStrictEqual(expected);
	});
});

describe('isReadActivityLogLine', () => {
	it.each([
		{
			name: 'the start of a build',
			line: JSON.stringify({
				action: 'start',
				type: 105,
				fields: [appDerivation, '', 1, 1]
			}),
			expected: true
		},
		{
			name: 'the start of a copy',
			line: copyLine(appPath, 'https://cache.nixos.org'),
			expected: true
		},
		{
			name: 'an error message',
			line: daemonError('timed out after 1 seconds'),
			expected: true
		},
		{
			name: 'a progress result of a build',
			line: JSON.stringify({
				action: 'result',
				fields: [0, 0, 0, 0],
				id: 1,
				type: 105
			}),
			expected: false
		},
		{
			name: 'the start of a download',
			line: JSON.stringify({
				action: 'start',
				type: 101,
				fields: ['https://cache.nixos.org/a.narinfo']
			}),
			expected: false
		},
		{
			name: 'the end of an activity',
			line: JSON.stringify({ action: 'stop', id: 1 }),
			expected: false
		},
		{
			name: 'a message below the error level',
			line: JSON.stringify({ action: 'msg', level: 3, msg: 'building' }),
			expected: false
		},
		{
			name: 'a line that is not JSON',
			line: '{"action":"msg"',
			expected: false
		},
		{ name: 'an empty line', line: '', expected: false }
	])('returns $expected for $name', ({ line, expected }) => {
		expect(isReadActivityLogLine(line)).toBe(expected);
	});
});

describe('firstBuildFailure', () => {
	it.each([
		{
			message: `Cannot build '${appPath}.drv'.\nReason: builder failed with exit code 1.`,
			expected: `${appPath}.drv`
		},
		{
			message: `error: builder for '${appPath}.drv' failed with exit code 1`,
			expected: `${appPath}.drv`
		},
		{
			message: `Cannot build '${appPath}.drv'.\nReason: 1 dependency failed.`,
			expected: undefined
		}
	])('reads the failing builder from $message', ({ message, expected }) => {
		expect(
			firstBuildFailure([
				`malformed\n${JSON.stringify({ action: 'msg', level: 0, msg: message })}\n${JSON.stringify({ action: 'msg', level: 0, msg: `builder for '${libraryPath}.drv' failed with exit code 1` })}`
			])
		).toBe(expected ?? `${libraryPath}.drv`);
	});
});

function failure(message: string): string {
	return JSON.stringify({ action: 'msg', level: 0, msg: `error: ${message}` });
}

const nestedFailure = String.raw`{"action":"msg","column":null,"file":null,"level":0,"line":null,"msg":"\u001b[31;1merror:\u001b[0m \u001b[35;1m\u001b[0mCannot build '\u001b[35;1m/nix/store/q6n8n8fpziy6m9fkrw1fxpgwd82f7pr1-cupboard-nested-1793527259.drv\u001b[0m'.\n       Reason: \u001b[31;1mbuilder failed with exit code 1\u001b[0m.\n       Output paths:\n         \u001b[35;1m/nix/store/c7b3g6z3dv3jr3arglf1nmjpvn31dr7z-cupboard-nested-1793527259\u001b[0m\n       Last 1 log lines:\n       > error: builder for '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-inner.drv' failed with exit code 2\n       For full logs, run:\n         \u001b[1mnix log /nix/store/q6n8n8fpziy6m9fkrw1fxpgwd82f7pr1-cupboard-nested-1793527259.drv\u001b[0m\u001b[0m","raw_msg":"\u001b[35;1m\u001b[0mCannot build '\u001b[35;1m/nix/store/q6n8n8fpziy6m9fkrw1fxpgwd82f7pr1-cupboard-nested-1793527259.drv\u001b[0m'.\nReason: \u001b[31;1mbuilder failed with exit code 1\u001b[0m.\nOutput paths:\n  \u001b[35;1m/nix/store/c7b3g6z3dv3jr3arglf1nmjpvn31dr7z-cupboard-nested-1793527259\u001b[0m\nLast 1 log lines:\n> error: builder for '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-inner.drv' failed with exit code 2\nFor full logs, run:\n  \u001b[1mnix log /nix/store/q6n8n8fpziy6m9fkrw1fxpgwd82f7pr1-cupboard-nested-1793527259.drv\u001b[0m\u001b[0m"}`;

describe('builderFailures', () => {
	it.each([
		{
			name: 'the outer builder when its log tail quotes another failure',
			lines: [nestedFailure],
			expected: [
				{
					derivation:
						'/nix/store/q6n8n8fpziy6m9fkrw1fxpgwd82f7pr1-cupboard-nested-1793527259.drv',
					isDiskFull: false
				}
			]
		},
		{
			name: 'every failed builder in log order',
			lines: [
				'malformed',
				failure(
					`Cannot build '${libraryPath}.drv'.\nReason: builder failed with exit code 2.`
				),
				failure(`builder for '${appPath}.drv' failed with exit code 1`)
			],
			expected: [
				{ derivation: `${libraryPath}.drv`, isDiskFull: false },
				{ derivation: `${appPath}.drv`, isDiskFull: false }
			]
		},
		{
			name: 'a builder that Nix suspects ran out of disk space',
			lines: [
				failure(
					`Cannot build '${appPath}.drv'.\nReason: builder failed with exit code 1.\nLast 1 log lines:\n> lack of free disk space\nnote: build failure may have been caused by lack of free disk space`
				)
			],
			expected: [{ derivation: `${appPath}.drv`, isDiskFull: true }]
		},
		{
			name: 'a builder whose log tail quotes the disk-space note',
			lines: [
				failure(
					`Cannot build '${appPath}.drv'.\nReason: builder failed with exit code 1.\nLast 1 log lines:\n> note: build failure may have been caused by lack of free disk space\nFor full logs, run:\n  nix log ${appPath}.drv`
				)
			],
			expected: [{ derivation: `${appPath}.drv`, isDiskFull: false }]
		},
		{
			name: 'no builder for a failed dependency',
			lines: [
				failure(`Cannot build '${appPath}.drv'.\nReason: 1 dependency failed.`)
			],
			expected: []
		}
	])('reads $name', ({ lines, expected }) => {
		expect(builderFailures(lines.join('\n'))).toStrictEqual(expected);
	});
});
