import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	type StoreDirectory,
	storeDirectorySchema,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { afterEach, describe, expect, it } from 'vitest';

import { FakeDaemonTransport } from '../../../tests/support/fake-daemon-transport.ts';

import { Nix, type NixDependencies } from './nix.ts';
import {
	InvalidNixStoreDirectoryError,
	type NixDaemonOffer,
	NixDaemonUnavailableError,
	type NixStoreClient,
	type NixValidPathInfo,
	NotInNixStoreError,
	UnsupportedNixStoreOperationError
} from './nix-store.ts';
import type { NixMachineProbes } from './store-config.ts';
import type { QuerySubstitutablePathInfos } from './substitutable-closure.ts';

const bareMachine: NixMachineProbes = {
	canReadWrite: () => false,
	isFilePresent: () => false,
	hasHardwareVirtualisation: () => false,
	isWsl1: () => false,
	microarchitectureLevels: () => []
};

const storeDirectory = storeDirectorySchema.parse('/nix/store');
const divertedStoreDirectory = storeDirectorySchema.parse(
	'/home/u/.local/share/nix/root/store'
);
const appPath = storePathSchema.parse(
	'/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-app'
);
const libraryPath = storePathSchema.parse(
	'/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-lib'
);

function info(
	storePath: StorePathString,
	references: readonly StorePathString[] = []
): NixValidPathInfo {
	return {
		storePath,
		narHash: NixSha256Hash.fromDigest(new Uint8Array(32)),
		narSize: 1,
		references,
		signatures: [],
		ultimate: false
	};
}

interface RecordingStore extends NixStoreClient {
	readonly queried: string[];
	readonly validBatches: string[][];
	readonly substitutableBatches: string[][];
	readonly substitutableInfoBatches: string[][];
	readonly drvBatches: string[][];
	readonly missingBatches: string[][];
	readonly infoBatches: string[][];
	readonly narRequests: string[];
	readonly derivationRequests: string[];
	readonly buildBatches: string[][];
	readonly closures: string[][];
}

interface RecordingStoreOptions {
	readonly substitutableOffers?: ReadonlyMap<
		StorePathString,
		readonly StorePathString[]
	>;
	readonly localReferences?: ReadonlyMap<
		StorePathString,
		readonly StorePathString[]
	>;
	readonly narBytes?: Uint8Array;
	readonly derivationText?: string;
}

function recordingStore(options: RecordingStoreOptions = {}): RecordingStore {
	const substitutableOffers =
		options.substitutableOffers ??
		new Map<StorePathString, readonly StorePathString[]>();
	const localReferences =
		options.localReferences ??
		new Map<StorePathString, readonly StorePathString[]>();
	const narBytes = options.narBytes ?? Buffer.from('nar');
	const queried: string[] = [];
	const validBatches: string[][] = [];
	const substitutableBatches: string[][] = [];
	const substitutableInfoBatches: string[][] = [];
	const drvBatches: string[][] = [];
	const missingBatches: string[][] = [];
	const infoBatches: string[][] = [];
	const narRequests: string[] = [];
	const derivationRequests: string[] = [];
	const buildBatches: string[][] = [];
	const closures: string[][] = [];

	return {
		queried,
		validBatches,
		substitutableBatches,
		substitutableInfoBatches,
		drvBatches,
		missingBatches,
		infoBatches,
		narRequests,
		derivationRequests,
		buildBatches,
		closures,
		queryPathInfo: (storePath) => {
			queried.push(storePath);

			return Promise.resolve(info(storePath));
		},
		queryPathsInfo: (storePaths) => {
			infoBatches.push([...storePaths]);

			return Promise.resolve(storePaths.map((storePath) => info(storePath)));
		},
		queryValidPathsInfo: (storePaths) => {
			infoBatches.push([...storePaths]);

			return Promise.resolve(
				storePaths.map((storePath) =>
					info(storePath, localReferences.get(storePath) ?? [])
				)
			);
		},
		queryValidPaths: (storePaths) => {
			validBatches.push([...storePaths]);

			return Promise.resolve(storePaths);
		},
		querySubstitutablePaths: (storePaths) => {
			substitutableBatches.push([...storePaths]);

			return Promise.resolve([]);
		},
		querySubstitutablePathInfos: (storePaths) => {
			substitutableInfoBatches.push([...storePaths]);

			return Promise.resolve(
				storePaths.flatMap((storePath): NixDaemonOffer[] => {
					const references = substitutableOffers.get(storePath);

					return references === undefined
						? []
						: [
								{
									source: 'daemon',
									storePath,
									references,
									downloadSize: 1,
									narSize: 2
								}
							];
				})
			);
		},
		queryDerivationOutputPaths: (drvPaths) => {
			drvBatches.push([...drvPaths]);

			return Promise.resolve([]);
		},
		queryMissing: (targets) => {
			missingBatches.push([...targets]);

			return Promise.resolve({
				willBuild: [],
				willSubstitute: [],
				unknown: [],
				downloadSize: 0,
				narSize: 0
			});
		},
		readDerivation: (drvPath) => {
			derivationRequests.push(drvPath);

			return Promise.resolve(options.derivationText ?? '');
		},
		narFromPath: (storePath) => {
			narRequests.push(storePath);

			return byteChunks(narBytes);
		},
		buildPathsWithResults: (targets) => {
			buildBatches.push([...targets]);

			return Promise.resolve([]);
		},
		resolveClosure: (storePaths) => {
			closures.push([...storePaths]);

			return Promise.resolve(storePaths.map((storePath) => info(storePath)));
		}
	};
}

interface RecordingSubstituters {
	readonly batches: string[][];
	readonly querySubstitutablePathInfos: QuerySubstitutablePathInfos;
}

function recordingSubstituters(): RecordingSubstituters {
	const batches: string[][] = [];

	return {
		batches,
		querySubstitutablePathInfos: (storePaths) => {
			batches.push([...storePaths]);

			return Promise.resolve(
				storePaths.map((storePath) => ({
					source: 'substituter',
					storePath,
					references: [],
					narHash: NixSha256Hash.fromDigest(new Uint8Array(32)),
					signatures: [],
					fromTrustedSubstituter: false,
					downloadSize: 1,
					narSize: 2
				}))
			);
		}
	};
}

function byteChunks(
	...chunks: readonly Uint8Array[]
): AsyncIterable<Uint8Array> {
	return {
		[Symbol.asyncIterator]() {
			let index = 0;

			return {
				next: () => {
					const value = chunks[index];
					index += 1;

					return value === undefined
						? Promise.resolve({ done: true as const, value: undefined })
						: Promise.resolve({ done: false as const, value });
				}
			};
		}
	};
}

function nixOver(
	store: NixStoreClient,
	realpath: (path: string) => string = (path) => path,
	directory: StoreDirectory = storeDirectory
): Nix {
	return Nix.forStore(store, { storeDirectory: directory, realpath });
}

describe('Nix.toStorePath', () => {
	it.each([
		{ name: 'a canonical store path', input: appPath, expected: appPath },
		{
			name: 'a file inside a store path',
			input: `${appPath}/bin/app`,
			expected: appPath
		}
	])('returns the store path for $name', ({ input, expected }) => {
		expect(nixOver(recordingStore()).toStorePath(input)).toBe(expected);
	});

	it('returns the store path under a diverted store directory', () => {
		const divertedPath = `${divertedStoreDirectory}/cccccccccccccccccccccccccccccccc-app`;
		const nix = nixOver(
			recordingStore(),
			(path) => path,
			divertedStoreDirectory
		);

		expect(nix.toStorePath(`${divertedPath}/bin/app`)).toBe(divertedPath);
	});

	it('resolves a symlink before taking the store path', () => {
		const nix = nixOver(recordingStore(), (path) =>
			path === '/home/u/result' ? appPath : path
		);

		expect(nix.toStorePath('/home/u/result')).toBe(appPath);
	});

	it('preserves the identity of a store path which is itself a symlink', () => {
		const linkPath =
			'/nix/store/dddddddddddddddddddddddddddddddd-link' as const;
		const nix = nixOver(recordingStore(), (path) =>
			path === linkPath ? appPath : path
		);

		expect(nix.toStorePath(linkPath)).toBe(linkPath);
	});

	it('normalises parent components before selecting the store path', () => {
		const otherPath =
			'/nix/store/dddddddddddddddddddddddddddddddd-other' as const;
		const nix = nixOver(recordingStore());

		expect(nix.toStorePath(`${otherPath}/../${path.basename(appPath)}`)).toBe(
			appPath
		);
		expect(() => nix.toStorePath(`${otherPath}/..`)).toThrow(
			NotInNixStoreError
		);
	});

	it('falls back to the argument when it cannot be resolved', () => {
		const nix = nixOver(recordingStore(), () => {
			throw new Error('ENOENT');
		});

		expect(nix.toStorePath(`${appPath}/bin`)).toBe(appPath);
	});

	it.each([
		{ name: 'outside the store directory', resolved: '/etc/passwd' },
		{
			name: 'a loose file beside the store paths',
			resolved: '/nix/store/notes.txt'
		},
		{
			name: 'the store directory itself',
			resolved: '/nix/store/'
		}
	])('throws when the path resolves to $name', ({ resolved }) => {
		const nix = nixOver(recordingStore(), () => resolved);

		expect(() => nix.toStorePath(resolved)).toThrow(NotInNixStoreError);
	});
});

describe('Nix.open', () => {
	it('normalises paths with the store directory named by a local URI', () => {
		const storePath =
			'/named/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-app' as const;
		const nix = Nix.open(
			openDependencies({
				env: {
					NIX_REMOTE:
						'local?store=/named/store&state=/named/state&real=/named/real'
				}
			})
		);

		expect({
			storePath: nix.toStorePath(`${storePath}/bin/app`),
			storeDirectory: nix.storeDirectory,
			stateDirectory: nix.stateDirectory,
			pathOnDisk: nix.storePathOnDisk(storePath)
		}).toStrictEqual({
			storePath,
			storeDirectory: '/named/store',
			stateDirectory: '/named/state',
			pathOnDisk: '/named/real/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-app'
		});
	});

	it('rejects a configured store directory that is not absolute', () => {
		const noConfigurationFiles: Record<string, string> = {};

		expect(() =>
			Nix.open({
				env: { NIX_STORE_DIR: 'relative/store' },
				readFile: (filePath) => noConfigurationFiles[filePath],
				homeDirectory: () => '/home/u',
				workingDirectory: () => workingDirectory,
				currentSystem: () => 'x86_64-linux',
				directoryExists: () => true,
				isSuperuser: () => false,
				createDirectory: () => true,
				probes: bareMachine,
				canWriteStateDirectory: () => true,
				socketExists: () => false,
				realpath: (path) => path
			})
		).toThrow(InvalidNixStoreDirectoryError);
	});
});

const noFiles = new Map<string, string>();

const workingDirectory = '/work/dir';

function daemonDependencies(hasSocket: boolean): NixDependencies {
	return {
		env: {},
		readFile: (filePath) => noFiles.get(filePath),
		homeDirectory: () => noFiles.get('home'),
		workingDirectory: () => workingDirectory,
		currentSystem: () => 'x86_64-linux',
		directoryExists: () => true,
		isSuperuser: () => false,
		createDirectory: () => true,
		probes: bareMachine,
		canWriteStateDirectory: () => true,
		socketExists: () => hasSocket,
		realpath: (path) => path
	};
}

describe('Nix.openForAvailability', () => {
	const directories: string[] = [];

	afterEach(() => {
		for (const directory of directories) {
			rmSync(directory, { recursive: true, force: true });
		}

		directories.length = 0;
	});

	function cacheDirectory(files: Readonly<Record<string, string>>): string {
		const directory = mkdtempSync(path.join(tmpdir(), 'cupboard-nix-cache-'));
		directories.push(directory);

		for (const [name, contents] of Object.entries(files)) {
			writeFileSync(path.join(directory, name), contents);
		}

		return directory;
	}

	// Daemon queries omit the NAR hash and signatures needed to verify a
	// substitutable closure. Read that metadata from the substituter even when
	// other store operations use the daemon.
	it('reads substitutable-closure metadata directly from the substituter', async () => {
		const narHash = `sha256:${'11'.repeat(32)}`;
		const directory = cacheDirectory({
			'nix-cache-info':
				'StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 30\n',
			[`${'a'.repeat(32)}.narinfo`]: [
				`StorePath: ${appPath}`,
				'URL: nar/aaaa.nar.xz',
				'Compression: xz',
				`FileHash: sha256:${'22'.repeat(32)}`,
				'FileSize: 400',
				`NarHash: ${narHash}`,
				'NarSize: 1000',
				'References: ',
				''
			].join('\n')
		});
		const uri = pathToFileURL(directory).href;
		const transports: FakeDaemonTransport[] = [];
		const nix = Nix.openForAvailability(
			{
				...daemonDependencies(true),
				env: { NIX_CONFIG: `substituters = ${uri}` }
			},
			{
				connect: () => {
					const transport = new FakeDaemonTransport(
						{
							[appPath]: {
								hash: '11'.repeat(32),
								narSize: 1000,
								references: [],
								signatures: []
							}
						},
						{ expectedOverrides: { substituters: uri } }
					);
					transports.push(transport);

					return Promise.resolve(transport);
				}
			}
		);

		const verdict = await nix.resolveSubstitutableClosure(appPath);

		expect({
			verdict,
			daemonAsked: transports.flatMap(
				(transport) => transport.substitutablePathInfoRequests
			)
		}).toStrictEqual({
			verdict: {
				kind: 'served',
				pathCount: 1,
				downloadSize: 400,
				narSize: 1000
			},
			daemonAsked: []
		});
	});

	it('reads through the daemon even when the state directory is writable', async () => {
		const nix = Nix.openForAvailability(daemonDependencies(true), {
			connect: () =>
				Promise.resolve(
					new FakeDaemonTransport({
						[appPath]: {
							hash: '11'.repeat(32),
							narSize: 123,
							references: [],
							signatures: []
						}
					})
				)
		});

		const expectedHash = NixSha256Hash.fromDigest(
			Buffer.from('11'.repeat(32), 'hex')
		);

		await expect(
			nix.queryPathInfo(`${appPath}/bin/app`)
		).resolves.toStrictEqual({
			storePath: appPath,
			narHash: expectedHash,
			narSize: 123,
			references: [],
			deriver: undefined,
			ca: undefined,
			signatures: [],
			ultimate: false
		});
	});

	it('opens the store this process drives when no daemon is running', () => {
		expect(Nix.openForAvailability(daemonDependencies(false)).storeKind).toBe(
			'local-filesystem'
		);
	});

	// A daemon caches substituter queries and may reject option overrides from
	// an untrusted client. A directly opened local store does neither. An SSH
	// store preserves the remote daemon's option policy.
	it.each([
		{
			name: 'a daemon that trusts this client',
			hasSocket: true,
			trust: 1,
			expected: {
				cachesSubstituterQueries: true,
				preservesDaemonOptions: false,
				isHonoured: true
			}
		},
		{
			name: 'a daemon that does not trust this client',
			hasSocket: true,
			trust: 2,
			expected: {
				cachesSubstituterQueries: true,
				preservesDaemonOptions: false,
				isHonoured: false,
				reason: 'daemon-trust',
				trust: 'not-trusted'
			}
		},
		{
			name: 'a daemon that leaves the flag unset',
			hasSocket: true,
			trust: 0,
			expected: {
				cachesSubstituterQueries: true,
				preservesDaemonOptions: false,
				isHonoured: false,
				reason: 'daemon-trust',
				trust: 'unknown'
			}
		},
		{
			name: 'an SSH store that preserves its remote daemon policy',
			hasSocket: false,
			storeUri: 'ssh-ng://build@example.test',
			trust: 1,
			expected: {
				cachesSubstituterQueries: true,
				preservesDaemonOptions: true,
				isHonoured: false,
				reason: 'daemon-options-preserved',
				trust: 'unknown'
			}
		},
		{
			name: 'the store this process drives',
			hasSocket: false,
			trust: 0,
			expected: {
				cachesSubstituterQueries: false,
				preservesDaemonOptions: false,
				isHonoured: true
			}
		}
	])(
		'reports substituter-query and option-override behaviour for $name',
		async ({ hasSocket, storeUri, trust, expected }) => {
			const nix = Nix.openForAvailability(daemonDependencies(hasSocket), {
				...(storeUri !== undefined && { storeUri }),
				connect: () => Promise.resolve(new FakeDaemonTransport({}, { trust }))
			});

			expect({
				cachesSubstituterQueries: nix.cachesSubstituterQueries,
				preservesDaemonOptions: nix.preservesDaemonOptions,
				...(await nix.honoursSubstituterSettings())
			}).toStrictEqual(expected);
		}
	);

	it('rejects a store URI that requires a daemon when none is running', () => {
		let outcome:
			{ value: Nix } | { error: { name: string; socketPath: string } };
		try {
			const value = Nix.openForAvailability({
				...daemonDependencies(false),
				env: { NIX_REMOTE: 'daemon' }
			});
			outcome = { value };
		} catch (error_: unknown) {
			expect(error_).toBeInstanceOf(NixDaemonUnavailableError);

			if (!(error_ instanceof NixDaemonUnavailableError)) {
				throw error_;
			}

			outcome = {
				error: { name: error_.name, socketPath: error_.socketPath }
			};
		}

		expect(outcome).toStrictEqual({
			error: {
				name: 'NixDaemonUnavailableError',
				socketPath: '/nix/var/nix/daemon-socket/socket'
			}
		});
	});
});

function openDependencies(overrides: {
	readonly env?: Record<string, string>;
	readonly canWrite?: boolean;
	readonly socket?: boolean;
}): NixDependencies {
	return {
		env: overrides.env ?? {},
		readFile: (filePath) => noFiles.get(filePath),
		homeDirectory: () => noFiles.get('home'),
		workingDirectory: () => workingDirectory,
		currentSystem: () => 'x86_64-linux',
		directoryExists: () => true,
		isSuperuser: () => false,
		createDirectory: () => true,
		probes: bareMachine,
		canWriteStateDirectory: () => overrides.canWrite ?? true,
		socketExists: () => overrides.socket ?? false,
		realpath: (path) => path
	};
}

describe('Nix.storeKind', () => {
	it.each([
		{
			name: 'a writable local store as local-filesystem',
			dependencies: openDependencies({}),
			expected: 'local-filesystem'
		},
		{
			name: 'the daemon behind an unwritable state directory as daemon',
			dependencies: openDependencies({ canWrite: false, socket: true }),
			expected: 'daemon'
		},
		{
			name: 'an ssh-ng remote store as ssh-ng',
			dependencies: openDependencies({
				env: { NIX_REMOTE: 'ssh-ng://builder.example' }
			}),
			expected: 'ssh-ng'
		}
	])('opens $name', ({ dependencies, expected }) => {
		expect(Nix.open(dependencies).storeKind).toBe(expected);
	});

	it('reports the explicitly opened daemon store by its remote form', () => {
		expect({
			daemon: Nix.openForAvailability(daemonDependencies(true)).storeKind,
			sshNg: Nix.openForAvailability({
				...daemonDependencies(true),
				env: { NIX_REMOTE: 'ssh-ng://builder.example' }
			}).storeKind,
			selectedSshNg: Nix.openForAvailability(daemonDependencies(true), {
				storeUri: 'ssh-ng://builder.example'
			}).storeKind
		}).toStrictEqual({
			daemon: 'daemon',
			sshNg: 'ssh-ng',
			selectedSshNg: 'ssh-ng'
		});
	});
});

describe('Nix queries', () => {
	it('canonicalises before querying a single path', async () => {
		const store = recordingStore();

		await nixOver(store).queryPathInfo(`${appPath}/bin/app`);

		expect(store.queried).toStrictEqual([appPath]);
	});

	it('canonicalises every root before resolving a closure', async () => {
		const store = recordingStore();

		await nixOver(store).resolveClosure([`${appPath}/bin`, libraryPath]);

		expect(store.closures).toStrictEqual([[appPath, libraryPath]]);
	});

	it('canonicalises every valid-path candidate', async () => {
		const store = recordingStore();

		await nixOver(store).queryValidPaths([`${appPath}/bin`, libraryPath]);

		expect(store.validBatches).toStrictEqual([[appPath, libraryPath]]);
	});

	it('canonicalises every substitutable-path candidate', async () => {
		const store = recordingStore();

		await nixOver(store).querySubstitutablePaths([
			`${appPath}/bin`,
			libraryPath
		]);

		expect(store.substitutableBatches).toStrictEqual([[appPath, libraryPath]]);
	});

	// Closure availability must come from the configured substituters. Querying
	// the selected build store would confuse locally valid paths with paths the
	// destination can download.
	it('canonicalises the root and queries the configured substituters', async () => {
		const store = recordingStore({
			localReferences: new Map([[appPath, [libraryPath]]]),
			substitutableOffers: new Map([
				[appPath, [libraryPath]],
				[libraryPath, []]
			])
		});
		const substituters = recordingSubstituters();

		const verdict = await Nix.forStore(store, {
			storeDirectory,
			realpath: (path) => path,
			offers: substituters.querySubstitutablePathInfos
		}).resolveSubstitutableClosure(`${appPath}/bin`);

		expect({
			verdict,
			asked: substituters.batches,
			backendBatches: store.substitutableInfoBatches
		}).toStrictEqual({
			verdict: {
				kind: 'served',
				pathCount: 2,
				downloadSize: 2,
				narSize: 4
			},
			asked: [[appPath], [libraryPath]],
			backendBatches: []
		});
	});

	it('rejects a substitutable-closure query with no substituters', async () => {
		await expect(
			nixOver(recordingStore()).resolveSubstitutableClosure(appPath)
		).rejects.toBeInstanceOf(UnsupportedNixStoreOperationError);
	});

	it.each([
		{
			name: 'a derivation that withholds substitution',
			environment: '[("allowSubstitutes","")]',
			expected: false
		},
		{
			name: 'a derivation without an allowSubstitutes value',
			environment: '[("name","app")]',
			expected: true
		}
	])(
		'returns the substitution policy from $name',
		async ({ environment, expected }) => {
			const aterm = `Derive([],[],[],"system","builder",[],${environment})`;
			const store = recordingStore({ derivationText: aterm });

			const isAllowed = await nixOver(store).canSubstituteDerivation(
				`${appPath}/self.drv`
			);

			expect({
				allowed: isAllowed,
				derivationRequests: store.derivationRequests
			}).toStrictEqual({
				allowed: expected,
				derivationRequests: [appPath]
			});
		}
	);

	it("returns a derivation's system and required features", async () => {
		const aterm =
			'Derive([],[],[],"aarch64-linux","builder",[],' +
			'[("requiredSystemFeatures","big-parallel kvm")])';
		const store = recordingStore({ derivationText: aterm });

		const requirements = await nixOver(store).derivationBuildRequirements(
			`${appPath}/self.drv`
		);

		expect({
			requirements,
			derivationRequests: store.derivationRequests
		}).toStrictEqual({
			requirements: {
				system: 'aarch64-linux',
				requiredSystemFeatures: ['big-parallel', 'kvm']
			},
			derivationRequests: [appPath]
		});
	});

	it('canonicalises every derivation path in an output query', async () => {
		const store = recordingStore();

		await nixOver(store).queryDerivationOutputPaths([
			`${appPath}/bin`,
			libraryPath
		]);

		expect(store.drvBatches).toStrictEqual([[appPath, libraryPath]]);
	});

	it('canonicalises every path in a batched info query', async () => {
		const store = recordingStore();

		await Promise.all([
			nixOver(store).queryPathsInfo([`${appPath}/bin`, libraryPath]),
			nixOver(store).queryValidPathsInfo([`${appPath}/bin`, libraryPath])
		]);

		expect(store.infoBatches).toStrictEqual([
			[appPath, libraryPath],
			[appPath, libraryPath]
		]);
	});

	it('canonicalises the path of a NAR stream', async () => {
		const store = recordingStore();
		const chunks = await Array.fromAsync(
			nixOver(store).narFromPath(`${appPath}/bin`)
		);

		expect({ narRequests: store.narRequests, chunks }).toStrictEqual({
			narRequests: [appPath],
			chunks: [Buffer.from('nar')]
		});
	});

	it('passes realisation targets through unchanged', async () => {
		const store = recordingStore();

		await nixOver(store).queryMissing([`${appPath}^out`, libraryPath]);

		expect(store.missingBatches).toStrictEqual([
			[`${appPath}^out`, libraryPath]
		]);
	});

	it('passes build targets through unchanged', async () => {
		const store = recordingStore();

		await nixOver(store).buildPathsWithResults([`${appPath}^out`, libraryPath]);

		expect(store.buildBatches).toStrictEqual([[`${appPath}^out`, libraryPath]]);
	});

	it('reports unknown daemon trust for a backend with no daemon connection', async () => {
		const store = recordingStore();

		await expect(nixOver(store).daemonTrust()).resolves.toBe('unknown');
	});

	it("delegates to the backend's own daemon trust when it has one", async () => {
		const store: RecordingStore = {
			...recordingStore(),
			daemonTrust: () => Promise.resolve('trusted')
		};

		await expect(nixOver(store).daemonTrust()).resolves.toBe('trusted');
	});
});
