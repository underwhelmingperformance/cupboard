import type { NixValidPathInfo } from '@cupboard/nix';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import {
	type BuildAttempt,
	parseBuildActivities,
	receiptSubjects
} from './attribution.ts';

const appPath = storePathSchema.parse(
	'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
);
const libraryPath = storePathSchema.parse(
	'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib'
);
const appDrv = '/nix/store/8123456789abcdfghijklmnpqrsvwxyz-app.drv';
const libraryDrv = '/nix/store/9123456789abcdfghijklmnpqrsvwxyz-lib.drv';
const narHash = NixSha256Hash.fromDigest(Buffer.alloc(32, 0xaa));

function startLine(derivation: string, machine: string): string {
	return JSON.stringify({
		action: 'start',
		id: 1,
		level: 3,
		parent: 0,
		text: `building '${derivation}'`,
		type: 105,
		fields: [derivation, machine]
	});
}

function info(
	storePath: StorePathString,
	deriver: string | undefined
): NixValidPathInfo {
	return {
		storePath,
		narHash,
		narSize: 4,
		references: [],
		signatures: [],
		ultimate: true,
		...(deriver !== undefined && { deriver })
	};
}

function attempt(
	ordinal: number,
	activities: readonly {
		derivation: string;
		machine: string;
	}[]
): BuildAttempt {
	return {
		attempt: ordinal,
		attemptId: `attempt-${String(ordinal)}`,
		activities: activities.map((activity) => ({
			derivation: activity.derivation,
			machine: activity.machine
		}))
	};
}

describe('parseBuildActivities', () => {
	it.each([
		{
			name: 'returns local and remote build starts in derivation order',
			log: [
				startLine(libraryDrv, 'ssh://builder-1'),
				startLine(appDrv, '')
			].join('\n'),
			expected: [
				{ derivation: appDrv, machine: '' },
				{ derivation: libraryDrv, machine: 'ssh://builder-1' }
			]
		},
		{
			name: 'preserves remote dispatch when nested logs report a local build',
			log: [startLine(appDrv, 'ssh://builder-1'), startLine(appDrv, '')].join(
				'\n'
			),
			expected: [{ derivation: appDrv, machine: 'ssh://builder-1' }]
		},
		{
			name: 'skips non-build records and malformed lines',
			log: [
				'not json at all',
				JSON.stringify({ action: 'stop', id: 1 }),
				JSON.stringify({ action: 'start', type: 104, fields: [appDrv, ''] }),
				JSON.stringify({ action: 'start', type: 105, fields: [7, ''] }),
				JSON.stringify({ action: 'start', type: 105, fields: ['plain', ''] }),
				''
			].join('\n'),
			expected: []
		},
		{
			name: 'returns no activities for an empty log',
			log: '',
			expected: []
		}
	])('$name', ({ log, expected }) => {
		expect(parseBuildActivities(log)).toStrictEqual(expected);
	});
});

describe('receiptSubjects', () => {
	it('does not reinterpret a check with a different final hash as an original build', () => {
		const attempts: readonly BuildAttempt[] = [
			{
				...attempt(1, [{ derivation: appDrv, machine: '' }]),
				verifiedOutputs: [
					{ storePath: appPath, narHash: 'bb'.repeat(32), derivation: appDrv }
				]
			}
		];

		expect(
			receiptSubjects(attempts, [info(appPath, appDrv)], new Set(), 'auto')
		).toStrictEqual([]);
	});

	it.each([
		{
			name: 'a successful local check',
			machine: '',
			outputPath: appPath,
			outputHash: narHash.digestHex(),
			outputDrv: appDrv,
			expected: true
		},
		{
			name: 'remote activity',
			machine: 'ssh-ng://builder',
			outputPath: appPath,
			outputHash: narHash.digestHex(),
			outputDrv: appDrv,
			expected: false
		},
		{
			name: 'another output path',
			machine: '',
			outputPath: libraryPath,
			outputHash: narHash.digestHex(),
			outputDrv: appDrv,
			expected: false
		},
		{
			name: 'another NAR hash',
			machine: '',
			outputPath: appPath,
			outputHash: 'bb'.repeat(32),
			outputDrv: appDrv,
			expected: false
		},
		{
			name: 'another derivation',
			machine: '',
			outputPath: appPath,
			outputHash: narHash.digestHex(),
			outputDrv: libraryDrv,
			expected: false
		}
	])(
		'attributes reproduction only from matching check evidence: $name',
		({ machine, outputPath, outputHash, outputDrv, expected }) => {
			const attempts: readonly BuildAttempt[] = [
				attempt(1, [{ derivation: appDrv, machine: '' }]),
				{
					...attempt(2, [{ derivation: appDrv, machine }]),
					verifiedOutputs: [
						{
							storePath: outputPath,
							narHash: outputHash,
							derivation: outputDrv
						}
					]
				}
			];

			expect(
				receiptSubjects(
					attempts,
					[info(appPath, appDrv)],
					new Set([appPath]),
					'auto'
				)
			).toStrictEqual(
				expected
					? [
							{
								origin: 'built',
								storePath: appPath,
								narHash: narHash.digestHex(),
								derivation: appDrv,
								attempt: 2,
								attemptId: 'attempt-2',
								buildStore: 'auto',
								verification: 'local',
								reproduced: true
							}
						]
					: []
			);
		}
	);

	it.each([
		{
			name: 'uses the earliest attempt for multi-attempt attribution',
			attempts: [
				attempt(1, [{ derivation: libraryDrv, machine: '' }]),
				attempt(2, [
					{ derivation: appDrv, machine: '' },
					{ derivation: libraryDrv, machine: '' }
				])
			],
			infos: [info(appPath, appDrv), info(libraryPath, libraryDrv)],
			preExisting: new Set<string>(),
			expected: [
				{
					origin: 'built',
					storePath: appPath,
					narHash: narHash.digestHex(),
					derivation: appDrv,
					attempt: 2,
					attemptId: 'attempt-2',
					buildStore: 'auto',
					verification: 'local'
				},
				{
					origin: 'built',
					storePath: libraryPath,
					narHash: narHash.digestHex(),
					derivation: libraryDrv,
					attempt: 1,
					attemptId: 'attempt-1',
					buildStore: 'auto',
					verification: 'local'
				}
			]
		},
		{
			name: 'does not infer execution from a delegated build request',
			attempts: [attempt(1, [{ derivation: appDrv, machine: 'ssh://b1' }])],
			infos: [info(appPath, appDrv)],
			preExisting: new Set<string>(),
			expected: []
		},
		{
			name: 'excludes a pre-existing path',
			attempts: [attempt(1, [{ derivation: appDrv, machine: '' }])],
			infos: [info(appPath, appDrv)],
			preExisting: new Set<string>([appPath]),
			expected: []
		},
		{
			name: 'excludes a path without a deriver',
			attempts: [attempt(1, [{ derivation: appDrv, machine: '' }])],
			infos: [info(appPath, undefined)],
			preExisting: new Set<string>(),
			expected: []
		},
		{
			name: 'excludes a path whose deriver has no observed build',
			attempts: [attempt(1, [{ derivation: libraryDrv, machine: '' }])],
			infos: [info(appPath, appDrv)],
			preExisting: new Set<string>(),
			expected: []
		}
	])('$name', ({ attempts, infos, preExisting, expected }) => {
		expect(receiptSubjects(attempts, infos, preExisting, 'auto')).toStrictEqual(
			expected
		);
	});

	it('records the selected build store in each subject', () => {
		expect(
			receiptSubjects(
				[attempt(1, [{ derivation: appDrv, machine: '' }])],
				[info(appPath, appDrv)],
				new Set<string>(),
				'ssh-ng://builder.example'
			)
		).toStrictEqual([
			{
				origin: 'built',
				storePath: appPath,
				narHash: narHash.digestHex(),
				derivation: appDrv,
				attempt: 1,
				attemptId: 'attempt-1',
				buildStore: 'ssh-ng://builder.example',
				verification: 'local'
			}
		]);
	});
});
