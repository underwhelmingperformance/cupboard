import { storePathSchema } from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import {
	builderFailures,
	copySources,
	firstBuildFailure
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
