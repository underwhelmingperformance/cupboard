import { describe, expect, it } from 'vitest';

import {
	builderDescription,
	cohortBuildLocation,
	cohortJobName
} from './build-location.ts';

describe('cohortBuildLocation', () => {
	it.each([
		{
			name: 'a local cohort',
			cohort: { system: 'x86_64-linux', os: 'ubuntu-latest', remote: false },
			settings: { store: '', builders: '' },
			rootSuffixes: ['x86_64-linux/hello'],
			expected: {
				location: { kind: 'runner', runner: 'ubuntu-latest' },
				job: 'x86_64-linux/hello on ubuntu-latest',
				builder: 'local'
			}
		},
		{
			name: 'a local cohort when remote builders are configured',
			cohort: { system: 'aarch64-darwin', os: 'macos-latest', remote: false },
			settings: {
				store: '',
				builders: 'ssh://ci@eu.nixbuild.net x86_64-linux'
			},
			rootSuffixes: ['aarch64-darwin/t1', 'aarch64-darwin/t2'],
			expected: {
				location: { kind: 'runner', runner: 'macos-latest' },
				job: 'aarch64-darwin on macos-latest (2 targets)',
				builder: 'local'
			}
		},
		{
			name: 'a remote cohort, without the builder credentials and query',
			cohort: { system: 'x86_64-linux', os: 'ubuntu-latest', remote: true },
			settings: {
				store: '',
				builders:
					'ssh-ng://ci:secret@eu.nixbuild.net:2222?compress=true x86_64-linux - 8 1 big-parallel'
			},
			rootSuffixes: [
				'x86_64-linux/t1',
				'x86_64-linux/t2',
				'x86_64-linux/t3',
				'x86_64-linux/t4',
				'x86_64-linux/t5',
				'x86_64-linux/t6',
				'x86_64-linux/t7',
				'x86_64-linux/t8'
			],
			expected: {
				location: { kind: 'builders', hosts: ['eu.nixbuild.net'] },
				job: 'x86_64-linux on eu.nixbuild.net (8 targets)',
				builder: 'eu.nixbuild.net'
			}
		},
		{
			name: 'a remote cohort whose builder has no URI scheme',
			cohort: { system: 'aarch64-darwin', os: 'ubuntu-latest', remote: true },
			settings: { store: '', builders: 'ci@mac.example.test aarch64-darwin' },
			rootSuffixes: ['aarch64-darwin/tool'],
			expected: {
				location: { kind: 'builders', hosts: ['mac.example.test'] },
				job: 'aarch64-darwin/tool on mac.example.test',
				builder: 'mac.example.test'
			}
		},
		{
			name: 'a remote cohort with several builders for its system',
			cohort: { system: 'x86_64-linux', os: 'ubuntu-latest', remote: true },
			settings: {
				store: '',
				builders:
					'ssh://a.example.test x86_64-linux; ssh://arm.example.test aarch64-linux; ssh://b.example.test - ; ssh://a.example.test x86_64-linux,i686-linux'
			},
			rootSuffixes: ['x86_64-linux/t1', 'x86_64-linux/t2', 'x86_64-linux/t3'],
			expected: {
				location: {
					kind: 'builders',
					hosts: ['a.example.test', 'b.example.test']
				},
				job: 'x86_64-linux on a.example.test and 1 more (3 targets)',
				builder: 'a.example.test and 1 more'
			}
		},
		{
			name: 'a remote cohort with no builder for its system',
			cohort: { system: 'riscv64-linux', os: 'ubuntu-latest', remote: true },
			settings: {
				store: '',
				builders: 'ssh://arm.example.test aarch64-linux'
			},
			rootSuffixes: ['riscv64-linux/probe'],
			expected: {
				location: { kind: 'builders', hosts: ['arm.example.test'] },
				job: 'riscv64-linux/probe on arm.example.test',
				builder: 'arm.example.test'
			}
		},
		{
			name: 'a remote cohort without builders',
			cohort: { system: 'x86_64-linux', os: 'ubuntu-latest', remote: true },
			settings: { store: '', builders: '' },
			rootSuffixes: ['x86_64-linux/app'],
			expected: {
				location: { kind: 'builders', hosts: [] },
				job: 'x86_64-linux/app on remote builders',
				builder: 'remote builders'
			}
		},
		{
			name: 'any cohort with a remote store',
			cohort: { system: 'x86_64-linux', os: 'ubuntu-latest', remote: false },
			settings: {
				store:
					'ssh-ng://nix@store.example.test:2222/?base64-ssh-public-host-key=c3NoLWVkMjU1MTk',
				builders: ''
			},
			rootSuffixes: [
				'x86_64-linux/t1',
				'x86_64-linux/t2',
				'x86_64-linux/t3',
				'x86_64-linux/t4'
			],
			expected: {
				location: { kind: 'store', host: 'store.example.test' },
				job: 'x86_64-linux on store.example.test (4 targets)',
				builder: 'store.example.test'
			}
		}
	])('describes $name', ({ cohort, settings, rootSuffixes, expected }) => {
		const location = cohortBuildLocation(cohort, settings);

		expect({
			location,
			job: cohortJobName(
				{
					system: cohort.system,
					targets: rootSuffixes.map((rootSuffix) => ({ rootSuffix }))
				},
				location
			),
			builder: builderDescription(location)
		}).toStrictEqual(expected);
	});
});
