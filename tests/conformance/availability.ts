import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
	type StoreDirectory,
	storeDirectorySchema,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import { Nix } from '../../packages/nix/src/nix.ts';
import { offerAcceptance } from '../../packages/nix/src/offer-acceptance.ts';
import { defaultNixConfigEnvironment } from '../../packages/nix/src/store-config.ts';
import type { SubstitutableClosureVerdict } from '../../packages/nix/src/substitutable-closure.ts';
import { temporaryRoot } from '../support/filesystem.ts';
import { isolatedEnvironment } from '../support/nix.ts';

import { type OfferFields, oracleOffer } from './narinfo.ts';
import type { Oracle } from './oracle.ts';

/** The store directory the host store serves, which the fixture's paths sit in. */
const hostStoreDirectory: StoreDirectory =
	storeDirectorySchema.parse('/nix/store');

/**
 * A closure to ask both sides about, and a signed cache offering it.
 *
 * The paths are built in the host store, the only one that builds on every
 * platform. Both of them are needed: `built` is input-addressed, so a consumer
 * takes it only on a signature it trusts, where `dependency` is
 * content-addressed and Nix takes it whatever signs it.
 */
export interface AvailabilityFixture {
	readonly root: string;
	readonly environment: NodeJS.ProcessEnv;
	/** The cache offering the closure, as a substituter URI. */
	readonly cacheUri: string;
	/**
	 * A local store holding the same closure, named as a path. Nix reads a
	 * path-shaped substituter as the store rooted there, which serves what its
	 * database holds rather than documents.
	 */
	readonly storeSubstituter: string;
	/** An input-addressed path, referencing {@link dependencyPath}. */
	readonly builtPath: StorePathString;
	readonly dependencyPath: StorePathString;
	/** A derivation the host store holds, whose output nothing offers. */
	readonly derivationPath: StorePathString;
	/** A path nothing holds and nothing offers. */
	readonly absentPath: StorePathString;
	/** The key the cache's narinfos are signed with. */
	readonly trustedPublicKey: string;
	/** A key nothing in the cache is signed with. */
	readonly untrustedPublicKey: string;
}

export class FixtureCommandFailedError extends Error {
	constructor(
		public readonly command: string,
		public readonly status: number | null,
		public readonly stderr: string
	) {
		super(`preparing the availability fixture failed: ${command}`);
		this.name = 'FixtureCommandFailedError';
	}
}

// The expression the fixture's paths come from. `dependency` is written by
// evaluation alone, and the derivation's output references it, so building
// once yields an input-addressed path with a reference to a
// content-addressed one.
const fixtureExpression = [
	'let dependency = builtins.toFile "cupboard-conformance-dependency" ',
	'"cupboard conformance dependency";',
	'in derivation {',
	'  name = "cupboard-conformance-built";',
	'  system = builtins.currentSystem;',
	'  builder = "/bin/sh";',
	'  args = [ "-c" "printf %s \\"${dependency}\\" > \\"$out\\"" ];',
	'}'
].join('\n');

// A derivation whose output nothing offers and nothing holds, so realising it
// is work that has to be done here.
const unbuiltExpression = [
	'derivation {',
	'  name = "cupboard-conformance-unbuilt";',
	'  system = builtins.currentSystem;',
	'  builder = "/bin/sh";',
	String.raw`  args = [ "-c" "printf unbuilt > \"$out\"" ];`,
	'}'
].join('\n');

/**
 * A store path in the host store's directory that nothing has ever held. The
 * digest is written out rather than derived, since nothing is meant to produce
 * it.
 */
const absentPath: StorePathString = storePathSchema.parse(
	'/nix/store/00000000000000000000000000000000-cupboard-conformance-absent'
);

async function run(
	oracle: Oracle,
	tool: string,
	arguments_: readonly string[],
	environment: NodeJS.ProcessEnv
): Promise<string> {
	const result = await oracle.runTool(tool, arguments_, { env: environment });

	if (result.status !== 0) {
		throw new FixtureCommandFailedError(
			`${tool} ${arguments_.join(' ')}`,
			result.status,
			result.stderr
		);
	}

	return result.stdout.trim();
}

/** Builds the closure and signs a cache holding it. */
export async function createAvailabilityFixture(
	oracle: Oracle
): Promise<AvailabilityFixture> {
	const root = await mkdtemp(
		path.join(temporaryRoot, 'cupboard-conformance-availability-')
	);

	try {
		return await prepareFixture(oracle, root);
	} catch (error) {
		await rm(root, { force: true, recursive: true });

		throw error;
	}
}

export async function removeAvailabilityFixture(
	fixture: AvailabilityFixture
): Promise<void> {
	await rm(fixture.root, { force: true, recursive: true });
}

async function prepareFixture(
	oracle: Oracle,
	root: string
): Promise<AvailabilityFixture> {
	const environment = await isolatedEnvironment(root);
	const cacheDirectory = path.join(root, 'cache');
	const keyDirectory = path.join(root, 'keys');

	await mkdir(cacheDirectory, { recursive: true });
	await mkdir(keyDirectory, { recursive: true });

	const built = storePathSchema.parse(
		await run(
			oracle,
			'nix-build',
			[
				'--expr',
				fixtureExpression,
				'--no-out-link',
				'--option',
				'sandbox',
				'false',
				// Build here rather than risk a fetch from whatever cache the
				// machine is configured with.
				'--option',
				'substituters',
				''
			],
			environment
		)
	);
	const requisites = await run(
		oracle,
		'nix-store',
		['--query', '--requisites', built],
		environment
	);
	const dependency = storePathSchema.parse(
		requisiteNamed(requisites, 'cupboard-conformance-dependency')
	);
	const derivation = storePathSchema.parse(
		await run(
			oracle,
			'nix-instantiate',
			['--expr', unbuiltExpression],
			environment
		)
	);

	const secretKeyFile = path.join(keyDirectory, 'secret');
	const publicKeyFile = path.join(keyDirectory, 'public');

	await run(
		oracle,
		'nix-store',
		[
			'--generate-binary-cache-key',
			'cupboard-conformance-1',
			secretKeyFile,
			publicKeyFile
		],
		environment
	);
	await run(
		oracle,
		'nix',
		[
			'--extra-experimental-features',
			'nix-command',
			'copy',
			'--to',
			`file://${cacheDirectory}?secret-key=${secretKeyFile}`,
			built
		],
		environment
	);
	await inviteMassQuery(path.join(cacheDirectory, 'nix-cache-info'));

	const storeSubstituter = path.join(root, 'substituter-store');
	await run(
		oracle,
		'nix',
		[
			'--extra-experimental-features',
			'nix-command',
			'copy',
			'--to',
			`local?root=${storeSubstituter}`,
			'--no-check-sigs',
			built
		],
		environment
	);

	return {
		root,
		environment,
		cacheUri: `file://${cacheDirectory}`,
		storeSubstituter,
		builtPath: built,
		dependencyPath: dependency,
		derivationPath: derivation,
		absentPath,
		trustedPublicKey: await readPublicKey(publicKeyFile),
		untrustedPublicKey: await generateUntrustedPublicKey(
			oracle,
			root,
			environment
		)
	};
}

/**
 * Says the cache invites being asked about many paths at once, the way a
 * published cache says it. `nix copy` writes only the store directory, and a
 * cache that does not invite a batch is never given one, so without this the
 * comparison would be about the flag rather than about what the cache holds.
 */
async function inviteMassQuery(cacheInfoFile: string): Promise<void> {
	const published = await readFile(cacheInfoFile, 'utf8');

	if (/^WantMassQuery:/mu.test(published)) {
		return;
	}

	await writeFile(cacheInfoFile, `${published.trimEnd()}\nWantMassQuery: 1\n`);
}

function requisiteNamed(requisites: string, name: string): string {
	const found = requisites
		.split('\n')
		.map((line) => line.trim())
		.find((line) => line.endsWith(name));

	if (found === undefined) {
		throw new TypeError(`the built closure holds nothing named ${name}`);
	}

	return found;
}

async function readPublicKey(filePath: string): Promise<string> {
	const published = await readFile(filePath, 'utf8');

	return published.trim();
}

// This store's configuration is the environment the fixture builds and nothing
// else, so no file on the machine running the suite is read for it.
function noConfigFile(): string | undefined {
	return;
}

// A key nothing in the cache is signed with, for the case that asks what a
// consumer trusting only it would do.
async function generateUntrustedPublicKey(
	oracle: Oracle,
	root: string,
	environment: NodeJS.ProcessEnv
): Promise<string> {
	const directory = path.join(root, 'untrusted-key');

	await mkdir(directory, { recursive: true });
	await run(
		oracle,
		'nix-store',
		[
			'--generate-binary-cache-key',
			'cupboard-conformance-untrusted-1',
			path.join(directory, 'secret'),
			path.join(directory, 'public')
		],
		environment
	);

	return readPublicKey(path.join(directory, 'public'));
}

/**
 * A store of the fixture's own to realise into, rooted where nothing has been
 * fetched before. Its database is created up front so our client can read it
 * before Nix has opened the store itself.
 */
export async function createTargetStore(
	oracle: Oracle,
	fixture: AvailabilityFixture,
	name: string
): Promise<TargetStore> {
	const storeRoot = path.join(fixture.root, name);

	await mkdir(storeRoot, { recursive: true });
	await run(
		oracle,
		'nix-store',
		['--store', `local?root=${storeRoot}`, '--init'],
		fixture.environment
	);

	return {
		uri: `local?root=${storeRoot}`,
		stateDirectory: path.join(storeRoot, 'nix', 'var', 'nix')
	};
}

export interface TargetStore {
	/** The store as a URI, which the oracle is pointed at. */
	readonly uri: string;
	/** Where its database sits, which our client is pointed at. */
	readonly stateDirectory: string;
}

/** What a consumer's signing policy trusts, as both sides are told it. */
export interface SigningPolicy {
	readonly requireSignatures: boolean;
	readonly trustedPublicKeys: readonly string[];
}

function signingOptions(policy: SigningPolicy): readonly string[] {
	return [
		'--option',
		'require-sigs',
		policy.requireSignatures ? 'true' : 'false',
		'--option',
		'trusted-public-keys',
		policy.trustedPublicKeys.join(' ')
	];
}

/**
 * What both sides offer for the path through a substituter naming a local
 * store. Nix answers from the store's database, which publishes no narinfo, so
 * neither side states a transfer size.
 */
export async function offeredThroughStore(
	oracle: Oracle,
	fixture: AvailabilityFixture,
	store: TargetStore,
	storePath: StorePathString
): Promise<{
	readonly oracle: OfferFields | undefined;
	readonly client: OfferFields | undefined;
}> {
	const shown = await oracle.run(
		[
			'--extra-experimental-features',
			'nix-command',
			'path-info',
			'--store',
			fixture.storeSubstituter,
			'--json',
			'--json-format',
			'1',
			storePath
		],
		{ env: fixture.environment }
	);

	if (shown.status !== 0) {
		throw new UnreadablePathInfoError(shown.stderr);
	}

	const offers = await openClient(
		fixture,
		store.stateDirectory,
		fixture.storeSubstituter
	).querySubstitutablePathInfos([storePath]);
	const [offer] = offers;

	return {
		oracle: oracleOffer(shown.stdout, storePath),
		client:
			offer?.source === 'substituter'
				? {
						narHash: `sha256-${offer.narHash.digestBase64()}`,
						narSize: offer.narSize,
						downloadSize: offer.downloadSize,
						references: sorted(offer.references),
						deriver: offer.deriver,
						signatures: sorted(offer.signatures)
					}
				: undefined
	};
}

/** Opens our client over a store, with the named substituter behind it. */
function openClient(
	fixture: AvailabilityFixture,
	stateDirectory: string,
	substituter: string = fixture.cacheUri
): Nix {
	return Nix.openForAvailability({
		env: {
			NIX_STORE_DIR: hostStoreDirectory,
			NIX_STATE_DIR: stateDirectory,
			NIX_CONFIG: `substituters = ${substituter}`
		},
		readFile: noConfigFile,
		homeDirectory: noConfigFile,
		workingDirectory: defaultNixConfigEnvironment.workingDirectory,
		currentSystem: defaultNixConfigEnvironment.currentSystem,
		probes: {
			canReadWrite: () => false,
			fileExists: () => false,
			hasHardwareVirtualisation: () => false,
			isWsl1: () => false,
			microarchitectureLevels: () => []
		},
		canWriteStateDirectory: () => true,
		socketExists: () => false,
		directoryExists: () => true,
		isSuperuser: () => false,
		createDirectory: () => true,
		realpath: (value) => value
	});
}

function compareStrings(left: string, right: string): number {
	if (left === right) {
		return 0;
	}

	return left < right ? -1 : 1;
}

function sorted(values: readonly string[]): readonly string[] {
	return values.toSorted(compareStrings);
}

const pathInfoSchema = z.record(z.string(), z.unknown().nullable().optional());

export class UnreadablePathInfoError extends Error {
	constructor(public readonly output: string) {
		super('nix path-info did not print an entry per path');
		this.name = 'UnreadablePathInfoError';
	}
}

/**
 * Which of the paths the cache offers, according to each side. Nix answers a
 * path a cache does not hold with a null entry, so an absence is an answer.
 */
export async function offeredPaths(
	oracle: Oracle,
	fixture: AvailabilityFixture,
	store: TargetStore,
	storePaths: readonly StorePathString[]
): Promise<{ oracle: readonly string[]; client: readonly string[] }> {
	const shown = await oracle.run(
		[
			'--extra-experimental-features',
			'nix-command',
			'path-info',
			'--store',
			fixture.cacheUri,
			'--json',
			'--json-format',
			'1',
			...storePaths
		],
		{ env: fixture.environment }
	);

	if (shown.status !== 0) {
		throw new UnreadablePathInfoError(shown.stderr);
	}

	const parsed = pathInfoSchema.safeParse(JSON.parse(shown.stdout));

	if (!parsed.success) {
		throw new UnreadablePathInfoError(shown.stdout);
	}

	const offered = Object.entries(parsed.data)
		.filter(([, entry]) => entry !== undefined && entry !== null)
		.map(([storePath]) => storePath);
	const client = await openClient(
		fixture,
		store.stateDirectory
	).querySubstitutablePaths(storePaths);

	return { oracle: sorted(offered), client: sorted(client) };
}

/** What realising a set of targets would require, as each side partitions it. */
export interface RealisationPlan {
	readonly willBuild: readonly string[];
	readonly willFetch: readonly string[];
	readonly unknown: readonly string[];
}

/**
 * The headings `nix-store --realise --dry-run` prints, recognised by the words
 * that distinguish them. Nix writes each in a singular and a plural form and
 * carries the download and unpacked figures in the fetch heading, so the
 * patterns take either number and read none of the figures.
 */
const planHeadings: readonly {
	section: keyof RealisationPlan;
	pattern: RegExp;
}[] = [
	{ section: 'willBuild', pattern: /derivations? will be built/u },
	{ section: 'willFetch', pattern: /paths? will be fetched/u },
	{ section: 'unknown', pattern: /don't know how to build these paths/u }
];

/**
 * The plan a dry run reported, read from what it wrote to stderr.
 *
 * This is the suite's one dependency on the text of a Nix message. The dry run
 * has no structured output and no other interface answers what it answers, so
 * the parse is written to be tolerant: it finds a heading by the words that
 * distinguish it and takes the paths indented under it, which leaves it
 * unbothered by the figures a heading carries or by anything else Nix writes
 * around them.
 */
export function parseRealisationPlan(stderr: string): RealisationPlan {
	const sections: Record<keyof RealisationPlan, string[]> = {
		willBuild: [],
		willFetch: [],
		unknown: []
	};
	let section: keyof RealisationPlan | undefined;

	for (const line of stderr.split('\n')) {
		const heading = planHeadings.find(({ pattern }) => pattern.test(line));

		if (heading !== undefined) {
			section = heading.section;
			continue;
		}

		// A path sits indented under its heading; anything unindented is
		// something else Nix had to say, and ends the section.
		if (!/^\s+\S/u.test(line)) {
			section = undefined;
			continue;
		}

		if (section !== undefined) {
			sections[section].push(line.trim());
		}
	}

	return {
		willBuild: sorted(sections.willBuild),
		willFetch: sorted(sections.willFetch),
		unknown: sorted(sections.unknown)
	};
}

/** How each side partitions the work of realising the targets. */
export async function realisationPlans(
	oracle: Oracle,
	fixture: AvailabilityFixture,
	store: TargetStore,
	targets: readonly StorePathString[],
	policy: SigningPolicy
): Promise<{ oracle: RealisationPlan; client: RealisationPlan }> {
	const dryRun = await oracle.runTool(
		'nix-store',
		[
			'--store',
			store.uri,
			'--realise',
			'--dry-run',
			...targets,
			'--option',
			'substituters',
			fixture.cacheUri,
			...signingOptions(policy)
		],
		{ env: fixture.environment }
	);
	const partition = await openClient(
		fixture,
		store.stateDirectory
	).queryMissing(targets);

	return {
		oracle: parseRealisationPlan(dryRun.stderr),
		client: {
			willBuild: sorted(partition.willBuild),
			willFetch: sorted(partition.willSubstitute),
			unknown: sorted(partition.unknown)
		}
	};
}

/**
 * Whether a consumer under this policy would obtain the closure: whether Nix
 * realises it from the cache, and what our own walk makes of the same question.
 */
export async function closureOutcome(
	oracle: Oracle,
	fixture: AvailabilityFixture,
	holding: TargetStore,
	target: TargetStore,
	storePath: StorePathString,
	policy: SigningPolicy
): Promise<{ realised: boolean; verdict: SubstitutableClosureVerdict }> {
	const realise = await oracle.runTool(
		'nix-store',
		[
			'--store',
			target.uri,
			'--realise',
			storePath,
			'--option',
			'substituters',
			fixture.cacheUri,
			...signingOptions(policy)
		],
		{ env: fixture.environment }
	);
	const verdict = await openClient(
		fixture,
		holding.stateDirectory
	).resolveSubstitutableClosure(storePath, {
		accepts: offerAcceptance({ ...policy, secretKeyFiles: [] }, noConfigFile)
	});

	return { realised: realise.status === 0, verdict };
}

/** Fills a store with the fixture's closure, so a walk has one to compare. */
export async function fillFromCache(
	oracle: Oracle,
	fixture: AvailabilityFixture,
	store: TargetStore,
	storePath: StorePathString
): Promise<void> {
	await run(
		oracle,
		'nix-store',
		[
			'--store',
			store.uri,
			'--realise',
			storePath,
			'--option',
			'substituters',
			fixture.cacheUri,
			...signingOptions({
				requireSignatures: true,
				trustedPublicKeys: [fixture.trustedPublicKey]
			})
		],
		fixture.environment
	);
}
