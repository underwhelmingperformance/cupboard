import type { NixValidPathInfo } from '@cupboard/nix';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import {
	type BuildAttempt,
	derivationsRequiringVerification,
	parseBuildActivities,
	receiptSubjects,
	verifiedAttribution
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
		ultimate: false,
		...(deriver !== undefined && { deriver })
	};
}

function attempt(
	ordinal: number,
	activities: readonly {
		derivation: string;
		machine: string;
		verified?: boolean;
	}[]
): BuildAttempt {
	return {
		attempt: ordinal,
		attemptId: `attempt-${String(ordinal)}`,
		activities: activities.map((activity) => ({
			derivation: activity.derivation,
			machine: activity.machine,
			verified: activity.verified ?? false
		}))
	};
}

describe('parseBuildActivities', () => {
	it.each([
		{
			name: 'local and remote build starts, sorted by derivation',
			log: [
				startLine(libraryDrv, 'ssh://builder-1'),
				startLine(appDrv, '')
			].join('\n'),
			expected: [
				{ derivation: appDrv, machine: '', verified: false },
				{
					derivation: libraryDrv,
					machine: 'ssh://builder-1',
					verified: false
				}
			]
		},
		{
			name: 'a repeated derivation, the later record winning',
			log: [startLine(appDrv, 'ssh://builder-1'), startLine(appDrv, '')].join(
				'\n'
			),
			expected: [{ derivation: appDrv, machine: '', verified: false }]
		},
		{
			name: 'lines of every other shape, skipped',
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
			name: 'an empty log',
			log: '',
			expected: []
		}
	])('parses $name', ({ log, expected }) => {
		expect(parseBuildActivities(log)).toStrictEqual(expected);
	});
});

describe('derivationsRequiringVerification', () => {
	it.each([
		{
			name: 'a remote build in the successful attempt',
			attempts: [attempt(1, [{ derivation: appDrv, machine: 'ssh://b1' }])],
			successfulAttempt: 1,
			infos: [info(appPath, appDrv)],
			expected: [appDrv]
		},
		{
			name: 'a local build in an earlier attempt',
			attempts: [
				attempt(1, [{ derivation: libraryDrv, machine: '' }]),
				attempt(2, [{ derivation: appDrv, machine: '' }])
			],
			successfulAttempt: 2,
			infos: [info(appPath, appDrv), info(libraryPath, libraryDrv)],
			expected: [libraryDrv]
		},
		{
			name: 'a local build in the successful attempt, needing nothing',
			attempts: [attempt(1, [{ derivation: appDrv, machine: '' }])],
			successfulAttempt: 1,
			infos: [info(appPath, appDrv)],
			expected: []
		},
		{
			name: 'an activity whose derivation no final path names',
			attempts: [attempt(1, [{ derivation: libraryDrv, machine: 'ssh://b1' }])],
			successfulAttempt: 1,
			infos: [info(appPath, appDrv)],
			expected: []
		}
	])('selects $name', ({ attempts, successfulAttempt, infos, expected }) => {
		expect(
			derivationsRequiringVerification(attempts, successfulAttempt, infos)
		).toStrictEqual(expected);
	});
});

describe('verifiedAttribution', () => {
	it('marks the verified derivations, keeping the machine that built them', () => {
		const verified = verifiedAttribution(
			attempt(2, [
				{ derivation: appDrv, machine: 'ssh://b1' },
				{ derivation: libraryDrv, machine: '' }
			]),
			[appDrv]
		);

		expect(verified).toStrictEqual({
			attempt: 2,
			attemptId: 'attempt-2',
			activities: [
				{ derivation: appDrv, machine: 'ssh://b1', verified: true },
				{ derivation: libraryDrv, machine: '', verified: false }
			]
		});
	});

	it('records a derivation this attempt did not run with no machine', () => {
		const verified = verifiedAttribution(attempt(2, []), [libraryDrv]);

		expect(verified).toStrictEqual({
			attempt: 2,
			attemptId: 'attempt-2',
			activities: [{ derivation: libraryDrv, machine: '', verified: true }]
		});
	});
});

describe('receiptSubjects', () => {
	it.each([
		{
			name: 'multi-attempt attribution, the earliest attempt winning',
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
					storePath: appPath,
					narHash: narHash.digestHex(),
					derivation: appDrv,
					attempt: 2,
					attemptId: 'attempt-2',
					buildStore: 'auto',
					verification: 'local'
				},
				{
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
			name: 'an unreproduced remote build, named by its machine',
			attempts: [attempt(1, [{ derivation: appDrv, machine: 'ssh://b1' }])],
			infos: [info(appPath, appDrv)],
			preExisting: new Set<string>(),
			expected: [
				{
					storePath: appPath,
					narHash: narHash.digestHex(),
					derivation: appDrv,
					attempt: 1,
					attemptId: 'attempt-1',
					buildStore: 'auto',
					machine: 'ssh://b1',
					verification: 'unverified'
				}
			]
		},
		{
			name: 'a remote build a local rebuild reproduced',
			attempts: [
				attempt(1, [
					{ derivation: appDrv, machine: 'ssh://b1', verified: true }
				])
			],
			infos: [info(appPath, appDrv)],
			preExisting: new Set<string>(),
			expected: [
				{
					storePath: appPath,
					narHash: narHash.digestHex(),
					derivation: appDrv,
					attempt: 1,
					attemptId: 'attempt-1',
					buildStore: 'auto',
					machine: 'ssh://b1',
					verification: 'verified-rebuild'
				}
			]
		},
		{
			name: 'a pre-existing path, excluded',
			attempts: [attempt(1, [{ derivation: appDrv, machine: '' }])],
			infos: [info(appPath, appDrv)],
			preExisting: new Set<string>([appPath]),
			expected: []
		},
		{
			name: 'a path with no deriver, excluded',
			attempts: [attempt(1, [{ derivation: appDrv, machine: '' }])],
			infos: [info(appPath, undefined)],
			preExisting: new Set<string>(),
			expected: []
		},
		{
			name: 'a path whose deriver no attempt built, excluded',
			attempts: [attempt(1, [{ derivation: libraryDrv, machine: '' }])],
			infos: [info(appPath, appDrv)],
			preExisting: new Set<string>(),
			expected: []
		}
	])('attributes $name', ({ attempts, infos, preExisting, expected }) => {
		expect(receiptSubjects(attempts, infos, preExisting, 'auto')).toStrictEqual(
			expected
		);
	});

	it('attributes the subjects to the store the run selected', () => {
		expect(
			receiptSubjects(
				[attempt(1, [{ derivation: appDrv, machine: '' }])],
				[info(appPath, appDrv)],
				new Set<string>(),
				'ssh-ng://builder.example'
			)
		).toStrictEqual([
			{
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
