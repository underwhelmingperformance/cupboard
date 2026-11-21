import type { NixValidPathInfo, PublicObjectAccess } from '@cupboard/nix';
import { bytesToBase64 } from '@cupboard/nix-store/encoding';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	type StoreDirectory,
	storeDirectorySchema,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import {
	type FlakeInputSkipReason,
	type FlakeInputSourceDependencies,
	selectFlakeInputSources,
	type SourcePathCollision
} from './flake-input-sources.ts';

const storeDirectory: StoreDirectory = storeDirectorySchema.parse('/nix/store');

// `nix store add --mode nar` of one directory, as `source` and as
// `nixpkgs-src`, with Nix 2.35.3. A locked input's source path is this path
// for its `narHash`.
const narHash = 'sha256-m/i4zIJHKRtapNnPwNUoFromRkwfucNCdbqZ1oxSjWo=';
const sourcePath = storePathSchema.parse(
	'/nix/store/bgb79jccl8x3lxrwr6skmhb2sz10qizp-source'
);
const namedSourcePath = storePathSchema.parse(
	'/nix/store/jz3635ighvfvprb8mdwbybnkp4j2l6yl-nixpkgs-src'
);

const rev = '0123456789abcdef0123456789abcdef01234567';
const archive = `https://github.com/NixOS/nixpkgs/archive/${rev}.tar.gz`;
const githubTarball = `https://codeload.github.com/NixOS/nixpkgs/tar.gz/${rev}`;

interface LocalPath {
	readonly storePath: StorePathString;
	readonly signatures: readonly string[];
}

interface Case {
	readonly name: string;
	readonly locked: unknown;
	readonly local: readonly LocalPath[];
	readonly origins: Readonly<Record<string, PublicObjectAccess>>;
	readonly expected: {
		readonly paths: readonly StorePathString[];
		readonly skipped: readonly { input: string; reason: string }[];
		readonly probes: readonly string[];
	};
}

const github = {
	type: 'github',
	owner: 'NixOS',
	repo: 'nixpkgs',
	rev,
	narHash,
	lastModified: 1
};

function lockWith(locked: unknown) {
	return {
		version: 7,
		root: 'root',
		nodes: {
			root: { inputs: { input: 'input' } },
			input: { locked, original: {} }
		}
	};
}

const fetched = (storePath: StorePathString): LocalPath => ({
	storePath,
	signatures: []
});

function pathInfo(path: LocalPath): NixValidPathInfo {
	return {
		storePath: path.storePath,
		narHash: NixSha256Hash.fromDigest(new Uint8Array(32)),
		narSize: 1,
		references: [],
		signatures: path.signatures,
		ultimate: false
	};
}

function allValid(
	paths: readonly string[]
): Promise<readonly NixValidPathInfo[]> {
	return Promise.resolve(
		paths.map((path) => pathInfo(fetched(storePathSchema.parse(path))))
	);
}

describe('selectFlakeInputSources', () => {
	it.each<Case>([
		{
			name: 'a public github input that this job fetched',
			locked: github,
			local: [fetched(sourcePath)],
			origins: { [archive]: 'public' },
			expected: { paths: [sourcePath], skipped: [], probes: [archive] }
		},
		{
			name: 'a github input with a name',
			locked: { ...github, name: 'nixpkgs-src' },
			local: [fetched(namedSourcePath)],
			origins: { [archive]: 'public' },
			expected: { paths: [namedSourcePath], skipped: [], probes: [archive] }
		},
		{
			name: 'a github input on another host',
			locked: { ...github, host: 'git.example.com' },
			local: [fetched(sourcePath)],
			origins: {},
			expected: {
				paths: [],
				skipped: [{ input: 'input', reason: 'origin' }],
				probes: []
			}
		},
		{
			name: 'a private github input',
			locked: github,
			local: [fetched(sourcePath)],
			origins: { [archive]: 'private' },
			expected: {
				paths: [],
				skipped: [{ input: 'input', reason: 'private' }],
				probes: [archive]
			}
		},
		{
			name: 'a github input whose origin does not answer definitively',
			locked: github,
			local: [fetched(sourcePath)],
			origins: { [archive]: 'unavailable' },
			expected: {
				paths: [],
				skipped: [{ input: 'input', reason: 'unavailable' }],
				probes: [archive]
			}
		},
		{
			name: 'a public tarball input on GitHub',
			locked: { type: 'tarball', url: githubTarball, narHash },
			local: [fetched(sourcePath)],
			origins: { [githubTarball]: 'public' },
			expected: { paths: [sourcePath], skipped: [], probes: [githubTarball] }
		},
		{
			name: 'a public file input on GitHub',
			locked: {
				type: 'file',
				url: 'https://github.com/NixOS/nixpkgs/raw/main/README.md',
				narHash
			},
			local: [fetched(sourcePath)],
			origins: {
				'https://github.com/NixOS/nixpkgs/raw/main/README.md': 'public'
			},
			expected: {
				paths: [sourcePath],
				skipped: [],
				probes: ['https://github.com/NixOS/nixpkgs/raw/main/README.md']
			}
		},
		{
			name: 'a tarball input on another host',
			locked: {
				type: 'tarball',
				url: 'https://example.com/source.tar.gz',
				narHash
			},
			local: [fetched(sourcePath)],
			origins: { 'https://example.com/source.tar.gz': 'public' },
			expected: {
				paths: [],
				skipped: [{ input: 'input', reason: 'origin' }],
				probes: []
			}
		},
		{
			name: 'a tarball input on GitHub over plain HTTP',
			locked: {
				type: 'tarball',
				url: `http://codeload.github.com/NixOS/nixpkgs/tar.gz/${rev}`,
				narHash
			},
			local: [fetched(sourcePath)],
			origins: {},
			expected: {
				paths: [],
				skipped: [{ input: 'input', reason: 'origin' }],
				probes: []
			}
		},
		{
			name: 'a tarball input on GitHub with a query string',
			locked: {
				type: 'tarball',
				url: `${githubTarball}?token=AAAA`,
				narHash
			},
			local: [fetched(sourcePath)],
			origins: { [`${githubTarball}?token=AAAA`]: 'public' },
			expected: {
				paths: [],
				skipped: [{ input: 'input', reason: 'origin' }],
				probes: []
			}
		},
		{
			name: 'a git input over SSH',
			locked: {
				type: 'git',
				url: 'ssh://git@github.com/acme/secrets',
				rev,
				narHash
			},
			local: [fetched(sourcePath)],
			origins: {},
			expected: {
				paths: [],
				skipped: [{ input: 'input', reason: 'type' }],
				probes: []
			}
		},
		{
			name: 'a relative path input',
			locked: { type: 'path', path: './sub' },
			local: [],
			origins: {},
			expected: {
				paths: [],
				skipped: [{ input: 'input', reason: 'type' }],
				probes: []
			}
		},
		{
			name: 'an input without a NAR hash',
			locked: { type: 'tarball', url: githubTarball },
			local: [],
			origins: { [githubTarball]: 'public' },
			expected: {
				paths: [],
				skipped: [{ input: 'input', reason: 'unlocked' }],
				probes: []
			}
		},
		{
			name: 'a lock entry with a field of the wrong type',
			locked: { ...github, owner: 5 },
			local: [fetched(sourcePath)],
			origins: { [archive]: 'public' },
			expected: {
				paths: [],
				skipped: [{ input: 'input', reason: 'malformed' }],
				probes: []
			}
		},
		{
			name: 'a name that no store path can have',
			locked: { ...github, name: 'nixpkgs/src' },
			local: [],
			origins: { [archive]: 'public' },
			expected: {
				paths: [],
				skipped: [{ input: 'input', reason: 'malformed' }],
				probes: []
			}
		},
		{
			name: 'an input that the evaluation did not use',
			locked: github,
			local: [],
			origins: { [archive]: 'public' },
			expected: {
				paths: [],
				skipped: [{ input: 'input', reason: 'unused' }],
				probes: []
			}
		},
		{
			name: 'an input substituted from a signed cache',
			locked: github,
			local: [
				{
					storePath: sourcePath,
					signatures: ['cache.nixos.org-1:c2lnbmF0dXJl']
				}
			],
			origins: { [archive]: 'public' },
			expected: {
				paths: [],
				skipped: [{ input: 'input', reason: 'substituted' }],
				probes: []
			}
		}
	])('selects $name', async ({ locked, local, origins, expected }) => {
		const probes: string[] = [];
		const dependencies: FlakeInputSourceDependencies = {
			nix: {
				storeDirectory,
				queryValidPathsInfo: (paths) =>
					Promise.resolve(
						local
							.filter((path) => paths.includes(path.storePath))
							.map((path) => pathInfo(path))
					)
			},
			probeOrigin: (url) => {
				probes.push(url.href);

				return Promise.resolve(origins[url.href] ?? 'private');
			}
		};

		const selection = await selectFlakeInputSources(
			lockWith(locked),
			dependencies
		);

		expect({ ...selection, probes }).toStrictEqual(expected);
	});

	it('skips only the lock entry that does not parse', async () => {
		const lock = {
			version: 7,
			root: 'root',
			nodes: {
				root: { inputs: { broken: 'broken', nixpkgs: 'nixpkgs' } },
				broken: 'not a lock node',
				nixpkgs: { locked: github, original: {} }
			}
		};

		const selection = await selectFlakeInputSources(lock, {
			nix: { storeDirectory, queryValidPathsInfo: allValid },
			probeOrigin: () => Promise.resolve('public')
		});

		expect(selection).toStrictEqual({
			paths: [sourcePath],
			skipped: [{ input: 'broken', reason: 'malformed' }]
		});
	});

	// A `git` input is stored at the same kind of path, so a github.com input
	// that claims a private input's `narHash` would otherwise prove that path
	// public with its own, unrelated archive.
	// The warning shows only the scheme, host and path of the colliding entry's
	// URL, because user information or a query string can contain a token.
	it.each<{
		name: string;
		locked: Readonly<Record<string, string>>;
		reason: FlakeInputSkipReason;
		collidesWith: SourcePathCollision;
	}>([
		{
			name: 'a git input',
			locked: { type: 'git', url: 'ssh://git@github.com/acme/secrets', rev },
			reason: 'type',
			collidesWith: { input: 'secret', origin: 'ssh://github.com/acme/secrets' }
		},
		{
			name: 'a tarball with a token in its URL',
			locked: {
				type: 'tarball',
				url: 'https://ci:hunter2@git.example.com/acme/secrets.tar.gz?token=abc#top'
			},
			reason: 'origin',
			collidesWith: {
				input: 'secret',
				origin: 'https://git.example.com/acme/secrets.tar.gz'
			}
		},
		{
			name: 'a git input with an scp-like URL',
			locked: { type: 'git', url: 'git@github.com:acme/secrets.git', rev },
			reason: 'type',
			collidesWith: { input: 'secret' }
		}
	])(
		'skips a source whose path $name also locks',
		async ({ locked, reason, collidesWith }) => {
			const probes: string[] = [];
			const lock = {
				version: 7,
				root: 'root',
				nodes: {
					root: { inputs: { secret: 'secret', nixpkgs: 'nixpkgs' } },
					secret: { locked: { ...locked, narHash }, original: {} },
					nixpkgs: { locked: github, original: {} }
				}
			};

			const selection = await selectFlakeInputSources(lock, {
				nix: { storeDirectory, queryValidPathsInfo: allValid },
				probeOrigin: (url) => {
					probes.push(url.href);

					return Promise.resolve('public');
				}
			});

			expect({ ...selection, probes }).toStrictEqual({
				paths: [],
				skipped: [
					{ input: 'secret', reason },
					{ input: 'nixpkgs', reason: 'shared', collidesWith }
				],
				probes: []
			});
		}
	);

	// A private github.com input passes every condition but the probe, so a
	// public github.com entry with its `narHash` must not prove the path public
	// on its own, whichever entry comes first.
	const secretArchive = `https://github.com/acme/secret/archive/${rev}.tar.gz`;
	const secret = { ...github, owner: 'acme', repo: 'secret' };

	// The skip identifies the entry whose origin decided the path, and probing
	// stops at the first refusal.
	it.each<{
		name: string;
		names: readonly string[];
		answers: Readonly<Record<string, PublicObjectAccess>>;
		skipped: readonly { input: string; reason: string }[];
		probes: readonly string[];
	}>([
		{
			name: 'a refusal from the first entry',
			names: ['secret', 'nixpkgs'],
			answers: { [secretArchive]: 'private', [archive]: 'public' },
			skipped: [{ input: 'secret', reason: 'private' }],
			probes: [secretArchive]
		},
		{
			name: 'a refusal from the second entry',
			names: ['nixpkgs', 'secret'],
			answers: { [secretArchive]: 'private', [archive]: 'public' },
			skipped: [{ input: 'secret', reason: 'private' }],
			probes: [archive, secretArchive]
		},
		{
			name: 'no definite answer from the second entry',
			names: ['nixpkgs', 'secret'],
			answers: { [secretArchive]: 'unavailable', [archive]: 'public' },
			skipped: [{ input: 'secret', reason: 'unavailable' }],
			probes: [archive, secretArchive]
		},
		{
			name: 'no definite answer from either entry',
			names: ['nixpkgs', 'secret'],
			answers: { [secretArchive]: 'unavailable', [archive]: 'unavailable' },
			skipped: [
				{ input: 'nixpkgs', reason: 'unavailable' },
				{ input: 'secret', reason: 'unavailable' }
			],
			probes: [archive, secretArchive]
		}
	])(
		'decides a shared source path from $name',
		async ({ names, answers, skipped, probes: expectedProbes }) => {
			const probes: string[] = [];
			const locks: Record<string, unknown> = {
				secret: { locked: secret, original: {} },
				nixpkgs: { locked: github, original: {} }
			};
			const lock = {
				version: 7,
				root: 'root',
				nodes: {
					root: {},
					...Object.fromEntries(names.map((name) => [name, locks[name]]))
				}
			};

			const selection = await selectFlakeInputSources(lock, {
				nix: { storeDirectory, queryValidPathsInfo: allValid },
				probeOrigin: (url) => {
					probes.push(url.href);

					return Promise.resolve(answers[url.href] ?? 'private');
				}
			});

			expect({ ...selection, probes }).toStrictEqual({
				paths: [],
				skipped,
				probes: expectedProbes
			});
		}
	);

	it('selects a source once when two inputs lock it', async () => {
		const probes: string[] = [];
		const lock = {
			version: 7,
			root: 'root',
			nodes: {
				root: { inputs: { first: 'first', second: 'second' } },
				first: { locked: github, original: {} },
				second: { locked: github, original: {} }
			}
		};

		const selection = await selectFlakeInputSources(lock, {
			nix: { storeDirectory, queryValidPathsInfo: allValid },
			probeOrigin: (url) => {
				probes.push(url.href);

				return Promise.resolve('public');
			}
		});

		expect({ ...selection, probes }).toStrictEqual({
			paths: [sourcePath],
			skipped: [],
			probes: [archive]
		});
	});

	it('sends at most eight origin requests at once', async () => {
		const inputs = Object.fromEntries(
			Array.from({ length: 20 }, (_, index) => [
				`input-${String(index)}`,
				{
					locked: {
						...github,
						narHash: `sha256-${bytesToBase64(new Uint8Array(32).fill(index))}`
					},
					original: {}
				}
			])
		);
		let inFlight = 0;
		let peak = 0;

		const selection = await selectFlakeInputSources(
			{ version: 7, root: 'root', nodes: { root: {}, ...inputs } },
			{
				nix: { storeDirectory, queryValidPathsInfo: allValid },
				probeOrigin: async () => {
					inFlight += 1;
					peak = Math.max(peak, inFlight);
					await Promise.resolve();
					inFlight -= 1;

					return 'public';
				}
			}
		);

		expect({ peak, selected: selection.paths.length }).toStrictEqual({
			peak: 8,
			selected: 20
		});
	});
});
