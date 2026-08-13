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

/** A machine offering nothing a build can ask for beyond the portable names. */
const bareMachine: NixMachineProbes = {
	canReadWrite: () => false,
	fileExists: () => false,
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
	/** What the substituters offer, as a store path to its references. */
	readonly substitutableOffers?: ReadonlyMap<
		StorePathString,
		readonly StorePathString[]
	>;
	/** The references this store records, which a closure walk follows. */
	readonly localReferences?: ReadonlyMap<
		StorePathString,
		readonly StorePathString[]
	>;
	/** The bytes `narFromPath` streams for every path. */
	readonly narBytes?: Uint8Array;
	/** The text `readDerivation` answers for every derivation. */
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
	/** Each batch of paths the substituters were asked about. */
	readonly batches: string[][];
	readonly querySubstitutablePathInfos: QuerySubstitutablePathInfos;
}

// The substituters a client asks, each of them offering every path it is asked
// about under the NAR hash this store holds.
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

	// The store directory comes from the running configuration, so a store the
	// system diverted elsewhere resolves the same way the default one does.
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
	it('refuses a configured store directory that could hold no store path', () => {
		const noConfigurationFiles: Record<string, string> = {};

		expect(() =>
			Nix.open({
				env: { NIX_STORE_DIR: 'relative/store' },
				readFile: (filePath) => noConfigurationFiles[filePath],
				homeDirectory: () => '/home/u',
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

function daemonDependencies(hasSocket: boolean): NixDependencies {
	return {
		env: {},
		readFile: (filePath) => noFiles.get(filePath),
		homeDirectory: () => noFiles.get('home'),
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

	// A binary cache held in a directory, which answers a narinfo read without
	// anything having to be reachable over the network.
	function cacheDirectory(files: Readonly<Record<string, string>>): string {
		const directory = mkdtempSync(path.join(tmpdir(), 'cupboard-nix-cache-'));
		directories.push(directory);

		for (const [name, contents] of Object.entries(files)) {
			writeFileSync(path.join(directory, name), contents);
		}

		return directory;
	}

	// The daemon's batched answer names no NAR hash and no signature, so the
	// walk that proves a closure is held upstream reads each path's narinfo
	// from the substituter itself, whatever backend serves every other query.
	it('asks the substituters itself while the daemon answers for this store', async () => {
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

	// A daemonless install answers for itself, so the questions are asked of
	// the store this process drives.
	it('opens the store this process drives when no daemon is running', () => {
		expect(Nix.openForAvailability(daemonDependencies(false)).storeKind).toBe(
			'local-filesystem'
		);
	});

	// The two facts a plan reads off the opened store. A daemon keeps a
	// narinfo cache and applies an untrusted client's settings selectively; a
	// store this process drives has neither, holding its settings itself and
	// asking the substituters as the question is put.
	it.each([
		{
			name: 'a daemon that trusts this client',
			hasSocket: true,
			trust: 1,
			expected: { cachesSubstituterAnswers: true, isHonoured: true }
		},
		{
			name: 'a daemon that does not trust this client',
			hasSocket: true,
			trust: 2,
			expected: {
				cachesSubstituterAnswers: true,
				isHonoured: false,
				trust: 'not-trusted'
			}
		},
		{
			name: 'a daemon that leaves the flag unset',
			hasSocket: true,
			trust: 0,
			expected: {
				cachesSubstituterAnswers: true,
				isHonoured: false,
				trust: 'unknown'
			}
		},
		{
			name: 'the store this process drives',
			hasSocket: false,
			trust: 0,
			expected: { cachesSubstituterAnswers: false, isHonoured: true }
		}
	])(
		'reports what it can answer for over $name',
		async ({ hasSocket, trust, expected }) => {
			const nix = Nix.openForAvailability(daemonDependencies(hasSocket), {
				connect: () => Promise.resolve(new FakeDaemonTransport({}, { trust }))
			});

			expect({
				cachesSubstituterAnswers: nix.cachesSubstituterAnswers,
				...(await nix.honoursSubstituterSettings())
			}).toStrictEqual(expected);
		}
	);

	// A store URI naming the daemon asked for that daemon, so a missing socket
	// answers the caller's question.
	it('refuses a store URI naming a daemon that is not running', () => {
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

	// The walk reads each path's narinfo from the substituters themselves, so
	// the backend serving every other query is never asked what is available
	// elsewhere, however much it would answer.
	it('canonicalises the root of a substitutable-closure walk and asks the substituters', async () => {
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

	// A client built over a bare backend was given no substituters, so it has
	// nobody to put the question to.
	it('refuses a substitutable-closure walk with no substituters to ask', async () => {
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
			name: 'a derivation that says nothing about substitution',
			environment: '[("name","app")]',
			expected: true
		}
	])(
		'reads the substitution option out of $name in the store',
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

	it('reads what a derivation in the store asks of its machine', async () => {
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

	it('reports unknown daemon trust for a backend with no connection to ask', async () => {
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
