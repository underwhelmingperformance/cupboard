import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process, { env } from 'node:process';

import { byCodeUnit, StorePath } from '@cupboard/nix-store/store-path';
import { canonicalHref } from '@cupboard/nix-store/url';
import {
	autoBuildStore,
	buildReceiptV3Schema,
	type ParsedBuildSubjectV3
} from '@cupboard/protocol/build';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { runAction } from '../../actions/src/program.ts';
import { parseAudience } from '../../packages/cli/src/audience.ts';
import { tenantRpc } from '../../packages/cli/src/client/orpc.ts';
import { createBuildPushDaemon } from '../../packages/cli/src/commands/build-push.ts';
import { githubBranchAddBody } from '../../packages/cli/src/commands/oidc-trust.ts';
import { discoverNixStoreConfig } from '../../packages/nix/src/index.ts';
import { Nix } from '../../packages/nix/src/nix.ts';
import { defaultNixConfigEnvironment } from '../../packages/nix/src/store-config.ts';
import { CupboardCommand } from '../support/cupboard-command.ts';
import { CupboardTestServer } from '../support/cupboard-server.ts';
import { temporaryRoot } from '../support/filesystem.ts';
import { isolatedEnvironment } from '../support/nix.ts';
import { runCommand } from '../support/process.ts';
import {
	type NixSshStoreFixture,
	startNixSshStore
} from '../support/remote-nix-store.ts';
import { StubRunnerTokenEndpoint } from '../support/runner-token.ts';

const isNixPresent =
	spawnSync('nix', ['--version'], { stdio: 'ignore' }).status === 0;

// The remote-store leg needs the container engine testcontainers drives. A
// machine without one runs the rest of the tier and skips that leg.
const isContainerEnginePresent =
	spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;

function isSet(value: string | undefined): boolean {
	return value !== undefined && value !== '' && value !== 'false';
}

// This tier is opt-in locally and always on in CI: `pnpm check` runs no part of
// it, and `pnpm e2e:pipeline` runs it when CI or CUPBOARD_PIPELINE_E2E is set.
const isTierEnabled = isSet(env.CI) || isSet(env.CUPBOARD_PIPELINE_E2E);

// The repository the runner's token asserts. The presets pin a repository by
// its immutable numeric ids and a branch by its `ref`, so the token carries all
// three alongside the subject a GitHub token would.
const consumerRepository = {
	repositoryId: 4241,
	repositoryOwnerId: 4242,
	fullName: 'cupboard-test/consumer'
};
const consumerBranch = 'main';
const consumerClaims = {
	sub: `repo:${consumerRepository.fullName}:ref:refs/heads/${consumerBranch}`,
	repository: consumerRepository.fullName,
	repository_id: String(consumerRepository.repositoryId),
	repository_owner_id: String(consumerRepository.repositoryOwnerId),
	ref: `refs/heads/${consumerBranch}`
};
const rootPrefix = `github:${consumerRepository.fullName}/${consumerBranch}`;
const rootGrantPrefix = 'github:cupboard-test/';

// The preset case publishes under roots of its own beneath the same prefix, and
// authenticates with an audience of its own so rule selection can never confuse
// its rule with the hand-written one above.
const presetRootPrefix = `${rootPrefix}/preset`;
const presetAudience = 'https://cupboard-test.example/preset';

// What Nix reads on the runner: no substituter to fetch from and no builder to
// delegate to, so every path a run publishes is this machine's own work.
const isolatedNixConfig = [
	'experimental-features = nix-command flakes',
	'substituters =',
	'builders =',
	'sandbox = false'
].join('\n');

interface Fixture {
	readonly workspace: string;
	readonly server: CupboardTestServer;
	readonly runner: StubRunnerTokenEndpoint;
	readonly cupboard: CupboardCommand;
	readonly system: string;
	/** Whether a local build streams; see {@link streamsThroughDaemon}. */
	readonly streams: boolean;
}

const state: { fixture?: Fixture; hostEnvironment?: NodeJS.ProcessEnv } = {};

function fixture(): Fixture {
	const prepared = state.fixture;

	if (prepared === undefined) {
		throw new Error('The publish pipeline fixture was not prepared');
	}

	return prepared;
}

function replaceProcessEnvironment(environment: NodeJS.ProcessEnv): void {
	for (const name of Object.keys(process.env)) {
		Reflect.deleteProperty(process.env, name);
	}

	Object.assign(process.env, environment);
}

function system(): string {
	const value = defaultNixConfigEnvironment.currentSystem();

	if (value === undefined) {
		throw new Error('Nix did not report a current system');
	}

	return value;
}

/**
 * Whether this machine's Nix daemon accepts the client that would stream a
 * build through it. A run that streams publishes each output as the build
 * completes it and records the attempt that produced it. A run without such a
 * daemon builds first and reconciles the store afterwards, so the store's own
 * report is the evidence its receipt carries. Both publish the same paths.
 */
async function streamsThroughDaemon(): Promise<boolean> {
	const config = discoverNixStoreConfig();

	if (!existsSync(config.daemonSocketPath)) {
		return false;
	}

	return (await createBuildPushDaemon(config, {}).daemonTrust()) === 'trusted';
}

/**
 * A consumer repository's flake: two packages published as one cohort, each
 * under its own retention root. `cupboardOutputs` is the target manifest the
 * publication workflow evaluates before it plans.
 */
function consumerFlake(options: {
	readonly directory: string;
	readonly system: string;
	readonly seed: string;
}): string {
	const target = (name: string): string => `
    ${name} = derivation {
      name = "cupboard-pipeline-${name}";
      system = "${options.system}";
      builder = "/bin/sh";
      args = [ "-c" "echo ${name}-${options.seed} > $out" ];
    };`;

	return `{
  outputs = { self }: rec {
    packages.${options.system} = {${target('alpha')}${target('beta')}
    };
    cupboardBuiltPaths = builtins.map
      (name: {
        storePath = packages.${options.system}.\${name}.outPath;
        derivation = packages.${options.system}.\${name}.drvPath;
      })
      [ "alpha" "beta" ];
    cupboardOutputs = builtins.map
      (name: {
        attr = "path:${options.directory}#packages.${options.system}.\${name}";
        rootDrvPath = packages.${options.system}.\${name}.drvPath;
        system = "${options.system}";
        os = "ubuntu-24.04";
        remote = ${String(options.system !== system())};
        rootSuffix = "${options.system}/\${name}";
        cohort = "pipeline";
      })
      [ "alpha" "beta" ];
  };
}
`;
}

// Fifty chained derivations, each carrying four hundred kibibytes of padding,
// so the cohort's derivation graph is well past the sixteen-mebibyte limit on
// a captured evaluation. The action must materialise that graph without
// reading it back through a pipe.
//
// The padding is spread over four attributes because a builder receives every
// attribute as an environment variable: Linux refuses a single variable longer
// than 128 KiB, and macOS refuses a whole environment above one mebibyte.
const paddedDerivationCount = 50;
const paddingAttributeCount = 4;
const paddingBytes = 100 * 1024;

function largeGraphFlake(options: {
	readonly directory: string;
	readonly system: string;
	readonly seed: string;
}): string {
	const padding = Array.from(
		{ length: paddingAttributeCount },
		(_ignored, index) => `\n      padding${String(index)} = big;`
	).join('');
	const layers = Array.from(
		{ length: paddedDerivationCount },
		(_ignored, index) => `
    d${String(index)} = derivation {
      name = "cupboard-pipeline-large-${String(index)}";
      system = "${options.system}";
      builder = "/bin/sh";
      args = [ "-c" "echo ${options.seed}-${String(index)} > $out" ];${padding}${index === 0 ? '' : `\n      previous = d${String(index - 1)};`}
    };`
	).join('');

	const chain = Array.from(
		{ length: paddedDerivationCount },
		(_ignored, index) => `d${String(index)}`
	).join(' ');

	return `{
  outputs = { self }: rec {
    big = "${'x'.repeat(paddingBytes)}";${layers}
    packages.${options.system}.default = d${String(paddedDerivationCount - 1)};
    cupboardBuiltPaths = builtins.map
      (d: { storePath = d.outPath; derivation = d.drvPath; })
      [ ${chain} ];
    cupboardOutputs = [
      {
        attr = "path:${options.directory}#packages.${options.system}.default";
        rootDrvPath = packages.${options.system}.default.drvPath;
        system = "${options.system}";
        os = "ubuntu-24.04";
        remote = false;
        rootSuffix = "${options.system}/large-graph";
      }
    ];
  };
}
`;
}

async function runNix(arguments_: readonly string[]): Promise<string> {
	const { stdout } = await runCommand('nix', arguments_);

	return stdout.trim();
}

const cohortEntrySchema = z.looseObject({ key: z.string() });
const matrixSchema = z.object({ include: z.array(cohortEntrySchema) });

/** One composite action step: its exit status and the outputs it recorded. */
interface StepResult {
	readonly status: number;
	readonly outputs: Readonly<Record<string, string>>;
}

/** One publication run: a runner temporary directory its steps share. */
interface PublishJob {
	readonly runnerTemporary: string;
	readonly runId: string;
}

function ignore(): void {
	return;
}

// The action installs handlers for the runner's cancellation signals. A test
// process is not a runner, so the steps register nothing on it.
const unhandledSignals = { once: ignore, removeListener: ignore };

/**
 * Runs one composite action step: the `cupboard-action` entrypoint with the
 * argv the composite builds, and the two runner-contract variables a step
 * reads.
 */
async function runStep(
	job: PublishJob,
	stepName: string,
	stepArguments: readonly string[]
): Promise<StepResult> {
	const outputFile = path.join(job.runnerTemporary, `${stepName}-output`);
	await writeFile(outputFile, '');
	const status = await runAction(
		['node', 'cupboard-action', ...stepArguments],
		{ RUNNER_TEMP: job.runnerTemporary, GITHUB_OUTPUT: outputFile },
		unhandledSignals
	);

	return { status, outputs: parseOutputs(await readFile(outputFile, 'utf8')) };
}

function parseOutputs(contents: string): Record<string, string> {
	const outputs: Record<string, string> = {};

	for (const line of contents.split('\n')) {
		const separator = line.indexOf('=');

		if (separator === -1) {
			continue;
		}

		outputs[line.slice(0, separator)] = line.slice(separator + 1);
	}

	return outputs;
}

async function startJob(name: string): Promise<PublishJob> {
	const runId = `${name}-${randomUUID()}`;
	const runnerTemporary = path.join(fixture().workspace, 'runs', runId);
	await mkdir(runnerTemporary, { recursive: true });

	return { runnerTemporary, runId };
}

/**
 * The argv `actions/plan` builds. Every input the composite declares is
 * passed, so an input the workflow left unset arrives as the empty string
 * rather than as an absent flag.
 */
function planArguments(options: {
	readonly targets: string;
	readonly url: string;
	readonly cupboardPath: string;
	readonly rootPrefix: string;
	readonly audience: string;
	readonly store: string;
	readonly requireProvenance: boolean;
}): readonly string[] {
	return [
		'plan',
		'--targets',
		options.targets,
		'--url',
		options.url,
		'--cupboard-path',
		options.cupboardPath,
		'--root-prefix',
		options.rootPrefix,
		'--cache',
		'',
		'--ttl',
		'',
		'--read-user',
		'',
		'--read-password',
		'',
		'--audience',
		options.audience,
		'--plan-file',
		'',
		'--optimise',
		'true',
		'--enable-packing',
		'false',
		'--store',
		options.store,
		'--require-provenance',
		String(options.requireProvenance)
	];
}

/** The argv `actions/build-cohort` builds for one cohort-matrix entry. */
function buildCohortArguments(options: {
	readonly cohortJson: string;
	readonly url: string;
	readonly cupboardPath: string;
	readonly audience: string;
	readonly store: string;
	readonly push: boolean;
	readonly requireProvenance: boolean;
	readonly runRoot: string;
}): readonly string[] {
	return [
		'build-cohort',
		'--cohort-json',
		options.cohortJson,
		'--url',
		options.url,
		'--cupboard-path',
		options.cupboardPath,
		'--cache',
		'',
		'--reuse-view',
		'',
		'--ttl',
		'',
		'--audience',
		options.audience,
		'--read-user',
		'',
		'--read-password',
		'',
		'--max-jobs',
		'',
		'--store',
		options.store,
		'--push',
		String(options.push),
		'--require-provenance',
		String(options.requireProvenance),
		'--best-effort',
		'false',
		'--gc-between-cohorts',
		'false',
		'--run-root',
		options.runRoot,
		'--run-root-ttl',
		'',
		'--receipt-file',
		'',
		'--target-paths-file',
		'',
		'--intermediate-paths-file',
		'',
		'--reference-paths-file',
		'',
		'--left-upstream-file',
		'',
		'--counts-file',
		''
	];
}

/**
 * The argv the subject step of `actions/attest` builds. Signing is the next
 * step in that composite and needs a GitHub identity, so a pipeline run stops
 * here, with the subjects the receipt records.
 */
function attestArguments(options: {
	readonly receiptFile: string;
	readonly url: string;
}): readonly string[] {
	return [
		'attest',
		'--receipt-file',
		options.receiptFile,
		'--checksums-file',
		'',
		'--url',
		options.url,
		'--cache',
		'',
		'--read-user',
		'',
		'--read-password',
		''
	];
}

interface AttestationOutcome {
	readonly subjectCount: string;
	readonly checksums: string;
}

/**
 * Which producer a receipt attributes its own builds to: a supervised attempt
 * on this machine, or the report of the store that holds them. `no-builds` and
 * `mixed` are values in their own right, so a receipt that matches neither
 * shape fails the case showing what it did record.
 */
type RecordedAttribution = Attribution | 'no-builds' | 'mixed';

interface RecordedReceipt {
	readonly attribution: RecordedAttribution;
	readonly receipt: unknown;
}

interface CohortOutcome {
	readonly status: number;
	readonly targetPaths: readonly string[];
	readonly attribution: RecordedAttribution | undefined;
	readonly receipt: unknown;
	readonly attestation: AttestationOutcome | undefined;
}

interface PublishOutcome {
	readonly planStatus: number;
	readonly retainedCount: string;
	readonly targetCount: string;
	readonly cohortCount: string;
	readonly cohorts: readonly CohortOutcome[];
}

interface PublishOptions {
	readonly flakeDirectory: string;
	readonly requireProvenance: boolean;
	readonly store: string;
	/** Every root this run writes nests under this prefix. */
	readonly rootPrefix?: string;
	/**
	 * The audience the run requests OIDC tokens with. An empty value defaults to
	 * the tenant URL.
	 */
	readonly audience?: string;
}

/**
 * One consumer publication run, step by step: evaluate the target manifest,
 * plan it against the destination, then build, publish and run the subject step
 * of attestation for every cohort the plan emitted.
 */
async function runPublication(
	name: string,
	options: PublishOptions
): Promise<PublishOutcome> {
	const prepared = fixture();
	const url = prepared.server.tenantUrl.href;
	const publishRootPrefix = options.rootPrefix ?? rootPrefix;
	const audience = options.audience ?? '';
	const job = await startJob(name);
	const targets = await runNix([
		'eval',
		'--json',
		`path:${options.flakeDirectory}#cupboardOutputs`
	]);
	const plan = await runStep(
		job,
		'plan',
		planArguments({
			targets,
			url,
			cupboardPath: prepared.cupboard.path,
			rootPrefix: publishRootPrefix,
			audience,
			store: options.store,
			requireProvenance: options.requireProvenance
		})
	);
	const cohorts: CohortOutcome[] = [];
	const matrix = matrixSchema.parse(
		JSON.parse(plan.outputs['cohort-matrix'] ?? '{"include":[]}')
	);

	for (const entry of matrix.include) {
		const cohort = await runStep(
			job,
			`build-cohort-${entry.key}`,
			buildCohortArguments({
				cohortJson: JSON.stringify(entry),
				url,
				cupboardPath: prepared.cupboard.path,
				audience,
				store: options.store,
				push: true,
				requireProvenance: options.requireProvenance,
				runRoot: `${publishRootPrefix}/_cupboard-run/${job.runId}`
			})
		);
		const receiptFile = cohort.outputs['receipt-file'] ?? '';
		const targetPathsFile = cohort.outputs['target-paths-file'] ?? '';
		const recorded =
			receiptFile === '' ? undefined : await recordedReceipt(receiptFile);

		cohorts.push({
			status: cohort.status,
			targetPaths:
				targetPathsFile === '' ? [] : await readPaths(targetPathsFile),
			attribution: recorded?.attribution,
			receipt: recorded?.receipt,
			attestation:
				receiptFile === ''
					? undefined
					: await runAttestation(job, entry.key, receiptFile, url)
		});
	}

	return {
		planStatus: plan.status,
		retainedCount: plan.outputs['retained-count'] ?? '',
		targetCount: plan.outputs['target-count'] ?? '',
		cohortCount: plan.outputs['cohort-count'] ?? '',
		cohorts
	};
}

async function runAttestation(
	job: PublishJob,
	key: string,
	receiptFile: string,
	url: string
): Promise<AttestationOutcome> {
	const attest = await runStep(
		job,
		`attest-${key}`,
		attestArguments({ receiptFile, url })
	);
	const checksumsFile = attest.outputs['checksums-file'] ?? '';

	return {
		subjectCount: attest.outputs['subject-count'] ?? '',
		checksums: checksumsFile === '' ? '' : await readFile(checksumsFile, 'utf8')
	};
}

async function readPaths(file: string): Promise<readonly string[]> {
	const contents = await readFile(file, 'utf8');

	return contents
		.split('\n')
		.filter((line) => line !== '')
		.toSorted(byCodeUnit);
}

/**
 * The receipt a cohort wrote, in a form successive runs can be compared
 * against: every path list in a stable order, and a label for each supervised
 * build attempt in place of the identifier the attempt generated for itself.
 */
async function recordedReceipt(receiptFile: string): Promise<RecordedReceipt> {
	const receipt = buildReceiptV3Schema.parse(
		JSON.parse(await readFile(receiptFile, 'utf8'))
	);
	const attempts = new Map<string, string>();
	const subjects = receipt.subjects
		.toSorted((left, right) => byCodeUnit(left.storePath, right.storePath))
		.map((subject) => {
			if (subject.origin !== 'built' || subject.attemptId === undefined) {
				return subject;
			}

			const { attemptId } = subject;
			const label =
				attempts.get(attemptId) ?? `attempt-${String(attempts.size)}`;
			attempts.set(attemptId, label);

			return { ...subject, attemptId: label };
		});

	return {
		attribution: recordedAttribution(receipt.subjects),
		receipt: {
			...receipt,
			subjects,
			paths: receipt.paths.toSorted(byCodeUnit),
			...(receipt.uploaded !== undefined && {
				uploaded: receipt.uploaded.toSorted(byCodeUnit)
			}),
			...(receipt.outcomes !== undefined && {
				outcomes: receipt.outcomes.toSorted((left, right) =>
					byCodeUnit(left.storePath, right.storePath)
				)
			})
		}
	};
}

/**
 * The producer the receipt attributed its own builds to, read back from the
 * subjects themselves. A leg asserts this against what the runner's daemon
 * state predicts, so a run that took the other path fails with the path named
 * and not with a difference somewhere in the receipt. A subject for a path the
 * run published without building it records no producer, so only the `built`
 * subjects are read here.
 */
function recordedAttribution(
	subjects: readonly ParsedBuildSubjectV3[]
): RecordedAttribution {
	const built = subjects.filter((subject) => subject.origin === 'built');

	if (built.length === 0) {
		return 'no-builds';
	}

	if (
		built.every(
			(subject) =>
				subject.verification === 'local' && subject.attemptId !== undefined
		)
	) {
		return 'supervised-attempt';
	}

	if (
		built.every(
			(subject) =>
				subject.verification === 'build-store' &&
				subject.attemptId === undefined
		)
	) {
		return 'store-report';
	}

	return 'mixed';
}

interface PublishedPath {
	readonly storePath: string;
	readonly narHash: string;
	readonly derivation: string;
}

const builtPathsSchema = z.array(
	z.object({ storePath: z.string().min(1), derivation: z.string().min(1) })
);

/**
 * Every path a run of this flake builds, with the NAR hash reported by the
 * store that holds it. A remote-store run leaves its results in that store and
 * never copies them to the runner, so the caller passes the store to query.
 */
async function builtPaths(
	flakeDirectory: string,
	store: Nix = Nix.open()
): Promise<readonly PublishedPath[]> {
	const entries = builtPathsSchema.parse(
		JSON.parse(
			await runNix([
				'eval',
				'--json',
				`path:${flakeDirectory}#cupboardBuiltPaths`
			])
		)
	);
	const published: PublishedPath[] = [];

	for (const entry of entries) {
		const info = await store.queryPathInfo(entry.storePath);

		published.push({ ...entry, narHash: info.narHash.digestHex() });
	}

	return published;
}

function byStorePath(left: PublishedPath, right: PublishedPath): number {
	return byCodeUnit(left.storePath, right.storePath);
}

/**
 * Who the receipt records as the producer of its subjects. A supervised
 * attempt is a streaming local build; a store report is what a reconciled
 * local build and a remote-store publication both carry, because neither
 * watched the build happen.
 */
type Attribution = 'supervised-attempt' | 'store-report';

function localAttribution(): Attribution {
	return fixture().streams ? 'supervised-attempt' : 'store-report';
}

interface PublicationPaths {
	/** Every path a build of the cohort produces. */
	readonly built: readonly PublishedPath[];
	/** The cohort's own targets, a subset of {@link built}. */
	readonly targets: readonly PublishedPath[];
	readonly attribution: Attribution;
}

/**
 * The paths a cohort publishes. A streaming run watches the build and
 * publishes each output it sees, so the intermediates travel with the targets;
 * a run that reconciles afterwards publishes what the build reported, which is
 * the targets alone.
 */
function claimedPaths(options: PublicationPaths): readonly PublishedPath[] {
	return options.attribution === 'supervised-attempt'
		? options.built
		: options.targets;
}

/** The receipt a cohort writes for the paths it published and claimed. */
function expectedReceipt(
	options: PublicationPaths & {
		/**
		 * The cohort's `store` input, empty for the runner's own store. It
		 * decides both how the run publishes and what its receipt can record;
		 * see {@link isBuildPushCohort}.
		 */
		readonly store: string;
		/**
		 * Whether the destination already served every path. Such a run uploads
		 * nothing, and each target's outcome records that the destination held
		 * it.
		 */
		readonly alreadyServed?: boolean;
	}
): unknown {
	const isSupervised = options.attribution === 'supervised-attempt';
	const claimed = claimedPaths(options);
	const paths = claimed.toSorted(byStorePath).map(({ storePath }) => storePath);
	const subjects = claimed.toSorted(byStorePath).map((entry) => ({
		origin: 'built',
		storePath: entry.storePath,
		narHash: entry.narHash,
		derivation: entry.derivation,
		...(isSupervised && { attempt: 1, attemptId: 'attempt-0' }),
		buildStore: isBuildPushCohort(options.store)
			? autoBuildStore
			: options.store,
		verification: isSupervised ? 'local' : 'build-store'
	}));

	// A streaming run reconciles the outputs it watched, so its receipt also
	// records each target's terminal outcome.
	return {
		version: 3,
		paths,
		subjects,
		uploaded: options.alreadyServed === true ? [] : paths,
		...(isSupervised && {
			outcomes: options.targets.toSorted(byStorePath).map(({ storePath }) => ({
				outcome:
					options.alreadyServed === true ? 'destination-served' : 'built',
				storePath
			})),
			failed: [],
			collected: []
		}),
		// Both local publication modes supervise the `nix build` that
		// `cupboard build-push` runs, and both record the status it exited
		// with: the streaming mode passes it to its reconciliation, and the
		// mode that reconciles afterwards adds it to the receipt its push
		// returned. A remote-store cohort runs `cupboard push` over results the
		// store already holds, so no child of its own reports a status.
		...(isBuildPushCohort(options.store) && { childExitStatus: 0 })
	};
}

/**
 * Whether a cohort publishes through `cupboard build-push`, which supervises
 * the build it publishes. `build-cohort` takes the remote-store path only for
 * a publishing cohort with a store of its own, so an empty `store` input is
 * what puts a run on the supervised path.
 */
function isBuildPushCohort(store: string): boolean {
	return store === '';
}

/** The checksums file the attest step writes for a receipt's subjects. */
function expectedChecksums(claimed: readonly PublishedPath[]): string {
	return claimed
		.toSorted(byStorePath)
		.map((entry) => `${entry.narHash}  ${path.basename(entry.storePath)}`)
		.join('\n')
		.concat('\n');
}

async function servedStatuses(
	published: readonly PublishedPath[]
): Promise<readonly number[]> {
	const prepared = fixture();

	return Promise.all(
		published.toSorted(byStorePath).map(async ({ storePath }) => {
			const response = await fetch(
				prepared.server.tenantPath(`/${StorePath.hash(storePath)}.narinfo`)
			);
			await response.body?.cancel();

			return response.status;
		})
	);
}

interface RetentionRoot {
	readonly name: string;
	readonly targets: readonly string[];
}

// The segment that precedes the run identifier in every run root's name.
const runRootMarker = '/_cupboard-run/';

/**
 * The roots the tenant holds whose names satisfy `isWanted`, with the paths
 * each one retains.
 */
async function retentionRoots(
	isWanted: (name: string) => boolean
): Promise<readonly RetentionRoot[]> {
	const prepared = fixture();
	const rpc = tenantRpc(prepared.server.tenantUrl, {
		credential: await prepared.server.ownerAdminToken()
	});
	const { roots } = await rpc.roots.list({ params: { cacheName: '_default' } });

	return Promise.all(
		roots
			.filter((root) => isWanted(root.name))
			.toSorted((left, right) => byCodeUnit(left.name, right.name))
			.map(async (root) => {
				const { targets } = await rpc.roots.targets({
					params: { cacheName: '_default', name: root.name },
					query: {}
				});

				return {
					name: root.name,
					targets: targets
						.map((target) => target.storePath)
						.toSorted(byCodeUnit)
				};
			})
	);
}

/**
 * The target roots the tenant holds, with the paths each one retains. The run
 * root every push attaches to is left out: its name carries the run
 * identifier, which changes with every job.
 */
function targetRoots(): Promise<readonly RetentionRoot[]> {
	return retentionRoots((name) => !name.includes(runRootMarker));
}

/**
 * The run roots beneath a prefix, with the run identifier in each name replaced
 * by `<run>` so a test can assert on the names deterministically.
 */
async function runRoots(prefix: string): Promise<readonly RetentionRoot[]> {
	const marker = `${prefix}${runRootMarker}`;
	const roots = await retentionRoots((name) => name.startsWith(marker));

	return roots.map((root) => ({ ...root, name: `${marker}<run>` }));
}

describe.skipIf(!isTierEnabled || !isNixPresent)(
	'a consumer repository publish run',
	() => {
		beforeAll(async () => {
			state.hostEnvironment = { ...process.env };
			const workspace = await mkdtemp(
				path.join(temporaryRoot, 'cupboard-publish-pipeline-')
			);
			const server = await CupboardTestServer.start(
				path.join(workspace, 'server')
			);
			const runner = await StubRunnerTokenEndpoint.start({
				issuer: server.issuer,
				claims: consumerClaims
			});
			const cupboard = await CupboardCommand.start({
				directory: path.join(workspace, 'bin'),
				stage: (key, bytes) => server.stageObject(key, bytes)
			});

			// The tenant trusts the runner's identity for what a publication job
			// does: the upload and attestation conversations, and roots beneath
			// the consumer's own prefix. These are the `push`, `attest`, `root`
			// and `attach` allowances a documented CI rule carries, plus
			// `root:list`, which the plan's pre-filter uses to read a root's
			// targets.
			await tenantRpc(server.tenantUrl, {
				credential: await server.ownerAdminToken()
			}).oidcTrust.add({
				issuer: server.issuer.issuer,
				audience: canonicalHref(server.tenantUrl),
				claims: { repository_owner_id: consumerClaims.repository_owner_id },
				permittedGrants: [
					{
						type: 'cupboard_cache',
						actions: [
							'upload:negotiate',
							'upload:status',
							'upload:commit',
							'upload:confirm',
							'attestation:negotiate',
							'attestation:attach',
							'root:set',
							'root:attach',
							'root:list'
						],
						resources: {
							cache: { exact: '_default', validate: 'cacheName' },
							root: { exact: rootGrantPrefix, validate: 'rootName' }
						}
					}
				]
			});

			replaceProcessEnvironment({
				...(await isolatedEnvironment(path.join(workspace, 'home'))),
				NIX_CONFIG: isolatedNixConfig,
				XDG_CONFIG_HOME: path.join(workspace, 'config'),
				...runner.environment
			});

			state.fixture = {
				workspace,
				server,
				runner,
				cupboard,
				system: system(),
				streams: await streamsThroughDaemon()
			};
		}, 600_000);

		afterAll(async () => {
			const hostEnvironment = state.hostEnvironment;

			if (hostEnvironment !== undefined) {
				replaceProcessEnvironment(hostEnvironment);
			}

			const prepared = state.fixture;

			if (prepared === undefined) {
				return;
			}

			await prepared.cupboard.stop();
			await prepared.runner.stop();
			await prepared.server.stop();
			await rm(prepared.workspace, { force: true, recursive: true });
		}, 120_000);

		it('publishes from the runner store, retains both targets on rerun, and rebuilds for provenance', async () => {
			const prepared = fixture();
			const flakeDirectory = path.join(prepared.workspace, 'local-consumer');
			await mkdir(flakeDirectory, { recursive: true });
			await writeFile(
				path.join(flakeDirectory, 'flake.nix'),
				consumerFlake({
					directory: flakeDirectory,
					system: prepared.system,
					seed: randomUUID()
				})
			);
			const options = { flakeDirectory, store: '' };

			const first = await runPublication('local-first', {
				...options,
				requireProvenance: false
			});
			// The destination now serves both targets, so the plan renews their
			// roots and the cohort job never starts.
			const rerun = await runPublication('local-rerun', {
				...options,
				requireProvenance: false
			});
			// Nothing has attached an attestation to either path, so a run with
			// require-provenance builds them both again.
			const provenanceRerun = await runPublication('local-provenance', {
				...options,
				requireProvenance: true
			});
			// Both packages are targets of the cohort, so a build produces
			// nothing besides them.
			const built = await builtPaths(flakeDirectory);
			const receiptOptions = {
				built,
				targets: built,
				store: '',
				attribution: localAttribution()
			};
			const paths = built
				.toSorted(byStorePath)
				.map(({ storePath }) => storePath);
			const attestation = {
				subjectCount: String(built.length),
				checksums: expectedChecksums(built)
			};

			expect({
				first,
				rerun,
				provenanceRerun,
				served: await servedStatuses(built),
				roots: await targetRoots(),
				audiences: [...new Set(prepared.runner.audiences)]
			}).toStrictEqual({
				first: {
					planStatus: 0,
					retainedCount: '0',
					targetCount: '2',
					cohortCount: '1',
					cohorts: [
						{
							status: 0,
							targetPaths: paths,
							attribution: localAttribution(),
							receipt: expectedReceipt(receiptOptions),
							attestation
						}
					]
				},
				rerun: {
					planStatus: 0,
					retainedCount: '2',
					targetCount: '0',
					cohortCount: '0',
					cohorts: []
				},
				provenanceRerun: {
					planStatus: 0,
					retainedCount: '0',
					targetCount: '2',
					cohortCount: '1',
					cohorts: [
						{
							status: 0,
							targetPaths: paths,
							attribution: localAttribution(),
							// The paths are the same, and the destination already
							// serves them, so this run rebuilt and claimed them
							// without republishing their bytes.
							receipt: expectedReceipt({
								...receiptOptions,
								alreadyServed: true
							}),
							attestation
						}
					]
				},
				served: [200, 200],
				roots: [
					{
						name: `${rootPrefix}/${prepared.system}/alpha`,
						targets: [built[0]?.storePath]
					},
					{
						name: `${rootPrefix}/${prepared.system}/beta`,
						targets: [built[1]?.storePath]
					}
				],
				audiences: [canonicalHref(prepared.server.tenantUrl)]
			});
		});

		// The rule an operator actually holds is the one a preset creates, and
		// the operations a publication needs have to be in it: `root:attach` for
		// the run root every push binds, and `root:list` for the reconciled
		// target list the plan's pre-filter reads before it prunes a cohort.
		it('publishes under the trust rule the GitHub branch preset creates', async () => {
			const prepared = fixture();
			const preset = githubBranchAddBody(
				prepared.server.tenantUrl,
				consumerRepository,
				{
					repo: consumerRepository.fullName,
					branch: consumerBranch,
					audience: parseAudience(presetAudience)
				}
			);
			// The preset pins GitHub's issuer, but the harness signs the tokens
			// this test uses, so replace the issuer with the harness's.
			await tenantRpc(prepared.server.tenantUrl, {
				credential: await prepared.server.ownerAdminToken()
			}).oidcTrust.add({ ...preset, issuer: prepared.server.issuer.issuer });

			const flakeDirectory = path.join(prepared.workspace, 'preset-consumer');
			await mkdir(flakeDirectory, { recursive: true });
			await writeFile(
				path.join(flakeDirectory, 'flake.nix'),
				consumerFlake({
					directory: flakeDirectory,
					system: prepared.system,
					seed: randomUUID()
				})
			);
			const options = {
				flakeDirectory,
				store: '',
				rootPrefix: presetRootPrefix,
				audience: presetAudience,
				requireProvenance: false
			};

			const first = await runPublication('preset-first', options);
			const rerun = await runPublication('preset-rerun', options);
			const built = await builtPaths(flakeDirectory);
			const paths = built
				.toSorted(byStorePath)
				.map(({ storePath }) => storePath);
			const tenantRoots = await targetRoots();
			const presetTargetRoots = tenantRoots.filter((root) =>
				root.name.startsWith(`${presetRootPrefix}/`)
			);

			expect({
				first,
				rerun,
				served: await servedStatuses(built),
				runRoots: await runRoots(presetRootPrefix),
				targetRoots: presetTargetRoots
			}).toStrictEqual({
				first: {
					planStatus: 0,
					retainedCount: '0',
					targetCount: '2',
					cohortCount: '1',
					cohorts: [
						{
							status: 0,
							targetPaths: paths,
							attribution: localAttribution(),
							receipt: expectedReceipt({
								built,
								targets: built,
								store: '',
								attribution: localAttribution()
							}),
							attestation: {
								subjectCount: String(built.length),
								checksums: expectedChecksums(built)
							}
						}
					]
				},
				// The pre-filter reads each root's reconciled list before it can
				// prune a cohort, so `targetCount` and `cohortCount` are `0` only
				// when the rule permits that read.
				rerun: {
					planStatus: 0,
					retainedCount: '2',
					targetCount: '0',
					cohortCount: '0',
					cohorts: []
				},
				served: [200, 200],
				// The first run's push bound this root and attached every path it
				// committed; the rerun published nothing and bound no run root.
				runRoots: [
					{ name: `${presetRootPrefix}/_cupboard-run/<run>`, targets: paths }
				],
				targetRoots: [
					{
						name: `${presetRootPrefix}/${prepared.system}/alpha`,
						targets: [built[0]?.storePath]
					},
					{
						name: `${presetRootPrefix}/${prepared.system}/beta`,
						targets: [built[1]?.storePath]
					}
				]
			});
		});

		it('publishes a cohort whose derivation graph exceeds the capture limit', async () => {
			const prepared = fixture();
			const flakeDirectory = path.join(prepared.workspace, 'large-consumer');
			await mkdir(flakeDirectory, { recursive: true });
			await writeFile(
				path.join(flakeDirectory, 'flake.nix'),
				largeGraphFlake({
					directory: flakeDirectory,
					system: prepared.system,
					seed: randomUUID()
				})
			);

			const outcome = await runPublication('large-graph', {
				flakeDirectory,
				store: '',
				requireProvenance: false
			});
			// The chain's last derivation is the cohort's only target. Building it
			// builds every link, and a streaming run publishes those links as
			// intermediates.
			const built = await builtPaths(flakeDirectory);
			const targets = built.slice(-1);
			const attribution = localAttribution();
			const claimed = claimedPaths({ built, targets, attribution });

			expect({
				outcome,
				served: await servedStatuses(claimed)
			}).toStrictEqual({
				outcome: {
					planStatus: 0,
					retainedCount: '0',
					targetCount: '1',
					cohortCount: '1',
					cohorts: [
						{
							status: 0,
							targetPaths: targets.map(({ storePath }) => storePath),
							attribution,
							receipt: expectedReceipt({
								built,
								targets,
								store: '',
								attribution
							}),
							attestation: {
								subjectCount: String(claimed.length),
								checksums: expectedChecksums(claimed)
							}
						}
					]
				},
				served: claimed.map(() => 200)
			});
		});

		describe.skipIf(!isContainerEnginePresent)(
			'against an ssh-ng remote store',
			() => {
				const remote: { store?: NixSshStoreFixture } = {};

				beforeAll(async () => {
					const store = await startNixSshStore();
					remote.store = store;
					// The transport `actions/prepare` configures for a job: the store
					// URI names the host alone, and the credentials travel in the
					// environment every Nix process inherits.
					process.env.NIX_SSHOPTS = store.environment.NIX_SSHOPTS;
				}, 600_000);

				afterAll(async () => {
					Reflect.deleteProperty(process.env, 'NIX_SSHOPTS');
					await remote.store?.close();
				}, 120_000);

				it('builds and publishes every target from the remote store', async () => {
					const store = remote.store;

					if (store === undefined) {
						throw new Error('The remote Nix store was not started');
					}

					const prepared = fixture();
					const remoteSystem = await store.exec([
						'nix',
						'eval',
						'--raw',
						'--impure',
						'--expr',
						'builtins.currentSystem'
					]);
					const flakeDirectory = path.join(
						prepared.workspace,
						'remote-consumer'
					);
					await mkdir(flakeDirectory, { recursive: true });
					await writeFile(
						path.join(flakeDirectory, 'flake.nix'),
						consumerFlake({
							directory: flakeDirectory,
							system: remoteSystem,
							seed: randomUUID()
						})
					);

					const outcome = await runPublication('remote', {
						flakeDirectory,
						store: store.transportConfiguredStoreUri,
						requireProvenance: false
					});
					const built = await builtPaths(
						flakeDirectory,
						Nix.openForAvailability(undefined, {
							storeUri: store.transportConfiguredStoreUri,
							overrides: { substituters: '' }
						})
					);

					expect({
						outcome,
						served: await servedStatuses(built)
					}).toStrictEqual({
						outcome: {
							planStatus: 0,
							retainedCount: '0',
							targetCount: '2',
							cohortCount: '1',
							cohorts: [
								{
									status: 0,
									targetPaths: built
										.toSorted(byStorePath)
										.map(({ storePath }) => storePath),
									attribution: 'store-report',
									receipt: expectedReceipt({
										built,
										targets: built,
										store: store.transportConfiguredStoreUri,
										attribution: 'store-report'
									}),
									attestation: {
										subjectCount: String(built.length),
										checksums: expectedChecksums(built)
									}
								}
							]
						},
						served: [200, 200]
					});
				});
			}
		);
	}
);
