import { readFile } from 'node:fs/promises';

import { tenantDependencyReferences } from '@cupboard/nix';
import { type CachedClosureSource } from '@cupboard/nix/cache-metadata';
import { cacheUrl } from '@cupboard/nix-store/cache-url';
import {
	type CacheAccessMode,
	type CacheScope,
	type RootName,
	type StorePathHash,
	type StorePathString,
	type TtlSeconds
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { canonicalHref } from '@cupboard/nix-store/url';
import type { AccessKeySecret } from '@cupboard/protocol/access-keys';
import type {
	BuildInputsRecordEntry,
	BuildInputsRecordResult
} from '@cupboard/protocol/build-inputs';
import type { DependencyStatusEntry } from '@cupboard/protocol/dependency-status';
import type { AuthorizationDetails } from '@cupboard/protocol/grants';
import {
	type BuildInputsDocument,
	buildInputsDocumentVersion,
	type DependencyGraphDocument
} from '@cupboard/protocol/publish-plan';
import {
	dependencyPassResultKind,
	type DependencyPassSummary
} from '@cupboard/protocol/reports';
import type { UploadAttachRoot } from '@cupboard/protocol/upload';
import { formatCount, type Reporter } from '@cupboard/reporter';
import type { BasicCredential } from '@cupboard/shared/http';
import type { Command } from 'commander';

import { isAbortError } from '../abort.ts';
import {
	accessKeyFor,
	basicCredentialForAccessKey,
	parseAccessKey,
	sessionReplacingAccessKey
} from '../access-key-options.ts';
import { type Audience, audienceSchema, parseAudience } from '../audience.ts';
import {
	buildInputsRecordAuthorizationDetails,
	contentReadAuthorizationDetails,
	type ContentReadGrantIntent,
	pushAuthorizationDetails
} from '../auth/attenuate.ts';
import { authenticateForPush } from '../auth/auth.ts';
import { cacheTargetFromUrl, cacheTargetWithName } from '../cache-target.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import {
	type BuildInputsRecordClient,
	type DependencyStatusClient,
	dependencyStatuses,
	recordBuildInputs
} from '../client/build-inputs.ts';
import { CupboardClient } from '../client/client.ts';
import { type AccessCredential } from '../client/credentials.ts';
import { tenantRpc } from '../client/orpc.ts';
import { isRpcProcedureMissingError } from '../client/rpc-errors.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { parseTtl } from '../duration.ts';
import {
	CupboardHttpError,
	type PushCredential,
	PushIncompleteError
} from '../errors.ts';
import {
	type BuildInputsRecordOutcome,
	dependencyCopies,
	type DependencyNode,
	dependencyRecordPlan,
	dependencyWalk
} from '../plan/dependency-pass.ts';
import { parseDependencyGraphDocument } from '../plan/publish-plan-file.ts';
import { PublicationCollection } from '../push/publication.ts';
import { type PushClient, runPush } from '../push/push.ts';
import { pushClientFor } from '../push/push-client.ts';
import { parseReferenceManifest } from '../push/reference-manifest.ts';
import { referenceSourceReadIntents } from '../push/reference-source-read.ts';
import { parseRootName } from '../root-name.ts';
import { tenantUrlArgument } from '../url-argument.ts';

import { cacheAccessFetcher } from './github.ts';
import { rootRetentionChoice } from './retention-choice.ts';

/**
A path that the destination does not have, and the cache that its dependency
status names as able to supply it.
*/
export interface DependencyCopy {
	readonly storePath: StorePathString;
	readonly source: CacheScope;
}

/**
The cache operations of a dependency pass. The command implements them with
two tokens: one with the push grant for the destination, the run root and
the configured sources, and one with only `build-inputs:record`.
*/
export interface DependencyAttachResult {
	readonly attached: readonly StorePathString[];
	readonly missing: readonly StorePathString[];
}

export interface DependencyPassService {
	/**
	The state of each path in the destination, in request order. A server
	without the `dependency-status` procedure rejects the call with an error
	that `isRpcProcedureMissingError` recognises.
	*/
	statuses(
		storePathHashes: readonly StorePathHash[]
	): Promise<readonly DependencyStatusEntry[]>;
	/**
	Publishes paths by reference from the caches that their statuses name, with
	their build inputs, and attaches them to the run root. Returns the paths
	that the publication committed.
	*/
	copy(
		copies: readonly DependencyCopy[]
	): Promise<ReadonlySet<StorePathString>>;
	/**
	Adds build inputs to rows that the destination has. Rejects with
	`BuildInputsRecordRefusedError` when the token service refuses the grant.
	*/
	record(
		entries: readonly BuildInputsRecordEntry[]
	): Promise<readonly BuildInputsRecordResult[]>;
	/**
	Attaches paths that the destination has to the run root. It publishes them
	by reference with the destination as their source, which negotiates them as
	present and attaches them without uploading anything. Returns the paths
	attached and the paths that it could not attach, because the destination
	did not return their narinfo or the push could not confirm them.
	*/
	attach(paths: readonly StorePathString[]): Promise<DependencyAttachResult>;
}

export interface PlanDependenciesRunOptions {
	readonly document: DependencyGraphDocument;
	/**
	Whether the pass may request `build-inputs:record`. A run whose trust rule
	never grants it, such as a pull-request run, does not ask.
	*/
	readonly shouldRecord: boolean;
	readonly signal?: AbortSignal;
}

/**
The token service refused the `build-inputs:record` grant: the trust rule
does not grant it, or the server does not know the operation.
*/
export class BuildInputsRecordRefusedError extends Error {
	constructor(options?: ErrorOptions) {
		super('The token service refused the build-inputs:record grant', options);
		this.name = 'BuildInputsRecordRefusedError';
	}
}

/**
Whether a token exchange failed because the token service refused the
requested authorization details.
*/
export function isBuildInputsGrantRefusal(error: unknown): boolean {
	return (
		error instanceof CupboardHttpError &&
		error.oauthError?.error === 'invalid_authorization_details'
	);
}

/**
The authority of the token that asks for dependency statuses, copies paths
and attaches paths to the run root: the push operations on the destination,
`root:attach` for the run root, and read access to the reference source, so
that the statuses offer the sources that a copy may use.
*/
export function dependencyPassAuthorizationDetails(intent: {
	readonly cache: CacheScope;
	readonly runRoot: RootName;
	readonly sourceReads: readonly ContentReadGrantIntent[];
}): AuthorizationDetails {
	return [
		...pushAuthorizationDetails({
			cache: intent.cache,
			attest: false,
			runRoot: intent.runRoot
		}),
		...intent.sourceReads.flatMap((read) =>
			contentReadAuthorizationDetails(read)
		)
	];
}

/**
Keeps the build-time dependencies of a publication's targets in the
destination. It asks for the state of every path in the graph, copies the
absent paths that another cache can supply, records build inputs on the
present and copied paths in graph order, and attaches to the run root every
path that the cache has but that neither a target nor recorded build inputs
keep. A server without the `dependency-status` procedure gets no request
after that one, and the summary reports it as `unsupported`.
*/
export async function runPlanDependencies(
	options: PlanDependenciesRunOptions,
	reporter: Reporter,
	service: DependencyPassService
): Promise<DependencyPassSummary> {
	const nodes = options.document.paths;
	let entries: readonly DependencyStatusEntry[];

	try {
		entries = await reporter.phase('Checking dependency status', () =>
			service.statuses(nodes.map(({ storePath }) => StorePath.hash(storePath)))
		);
	} catch (error) {
		if (!isRpcProcedureMissingError(error)) {
			throw error;
		}

		return reportSummary(reporter, { status: 'unsupported' });
	}

	const statuses = new Map(
		entries.map((entry) => [entry.storePathHash, entry])
	);
	const copies = dependencyCopies(nodes, statuses).flatMap((storePath) => {
		const status = statuses.get(StorePath.hash(storePath));

		if (status?.state !== 'absent' || status.source === undefined) {
			return [];
		}

		return { storePath, source: status.source };
	});
	const copied =
		copies.length === 0
			? new Set<StorePathString>()
			: await reporter.phase('Copying dependencies from other caches', () =>
					service.copy(copies)
				);
	const plan = dependencyRecordPlan(
		nodes,
		statuses,
		copied,
		options.document.buildInputsVersion
	);
	const outcome = await recordOutcome(options, reporter, service, plan.records);
	const attach = await attachUnkept(
		nodes,
		{ statuses, copied, outcome },
		options.document.buildInputsVersion,
		reporter,
		service
	);
	const results = outcome.kind === 'recorded' ? outcome.results : [];

	if (attach.missing.size > 0) {
		reporter.warn(
			'cannot attach every dependency output',
			`The run root does not keep ${String(attach.missing.size)} path(s), because the cache did not return their narinfo or could not confirm them. The pass attached the present paths below them instead.`
		);
	}

	return reportSummary(reporter, {
		status: 'completed',
		record: outcome.kind,
		paths: nodes.length,
		copied: copied.size,
		recorded: results.filter(({ status }) => status === 'recorded').length,
		unchanged: results.filter(({ status }) => status === 'unchanged').length,
		blocked: plan.blocked.length,
		attached: attach.attached.size,
		unattached: attach.missing.size,
		attachRounds: attach.rounds
	});
}

interface DependencyWalkState {
	readonly statuses: ReadonlyMap<StorePathHash, DependencyStatusEntry>;
	readonly copied: ReadonlySet<StorePathString>;
	readonly outcome: BuildInputsRecordOutcome;
}

/**
Attaches the paths that the walk leaves unkept, and makes sure that the rows
which the walk relied on still keep what it counted on. The walk counts an
attached row, a listed row, and a row whose record result confirmed its build
inputs, as keeping those inputs. Nothing protected those rows while the pass
ran: a collection can delete one, and a push or a clear can leave it without
build inputs. The pass therefore reads their statuses again after each attach,
and after a walk that relied on a record result of this pass. It treats the
paths that it could not attach as absent, walks again, and attaches whatever
the new walk adds, until a walk after a recheck adds nothing. A walk that
relies only on statuses at the document's version needs no recheck, because
those rows were kept before the pass started. The attached and missing sets
only grow, so the loop ends.
*/
async function attachUnkept(
	nodes: readonly DependencyNode[],
	initial: DependencyWalkState,
	buildInputsVersion: number,
	reporter: Reporter,
	service: DependencyPassService
): Promise<{
	readonly attached: ReadonlySet<StorePathString>;
	readonly missing: ReadonlySet<StorePathString>;
	readonly rounds: number;
}> {
	// The copy pushed the copied paths with the run root, so they count as
	// attached from the start and the walk never attaches them again.
	const protectedRows = new Set<StorePathString>(initial.copied);
	const attached = new Set<StorePathString>();
	const missing = new Set<StorePathString>();
	let state = initial;
	let rounds = 0;
	let isRechecked = false;

	for (;;) {
		const walk = dependencyWalk(
			nodes,
			state.statuses,
			state.copied,
			state.outcome,
			buildInputsVersion
		);
		const pending = walk.attached.filter(
			(path) => !protectedRows.has(path) && !missing.has(path)
		);

		if (pending.length === 0 && (isRechecked || walk.confirmed.length === 0)) {
			return { attached, missing, rounds };
		}

		if (pending.length > 0) {
			rounds += 1;
			const result = await reporter.phase(
				'Attaching dependencies to the run root',
				() => service.attach(pending)
			);
			const confirmedAttached = new Set(result.attached);

			for (const path of pending) {
				if (!confirmedAttached.has(path)) {
					missing.add(path);
					continue;
				}

				attached.add(path);
				protectedRows.add(path);
			}
		}

		const relied = [
			...new Set([...protectedRows, ...walk.listed, ...walk.confirmed])
		];
		const rechecked =
			relied.length === 0
				? []
				: await service.statuses(relied.map((path) => StorePath.hash(path)));

		state = rewalkState(
			state,
			{ initialStatuses: initial.statuses, rechecked, missing },
			buildInputsVersion
		);
		isRechecked = true;
	}
}

// The walk state after a recheck. The rechecked statuses replace the earlier
// ones, and a path that the attach missed counts as absent. A rechecked path
// loses its copy, because its status now shows its row. It keeps a record
// confirmation while its row is recorded at the document's version. A record
// unions the given build inputs into the row and keeps the higher version, so
// a row at a higher version keeps its confirmation only while it shows the
// version that the first status read showed. A row at another higher version
// was created again by another client, and may not list the graph's inputs.
function rewalkState(
	state: DependencyWalkState,
	recheck: {
		readonly initialStatuses: ReadonlyMap<StorePathHash, DependencyStatusEntry>;
		readonly rechecked: readonly DependencyStatusEntry[];
		readonly missing: ReadonlySet<StorePathString>;
	},
	buildInputsVersion: number
): DependencyWalkState {
	const { initialStatuses, rechecked, missing } = recheck;
	const statuses = new Map(state.statuses);
	const changed = new Set<StorePathHash>();

	for (const entry of rechecked) {
		statuses.set(entry.storePathHash, entry);
		changed.add(entry.storePathHash);
	}

	for (const path of missing) {
		const storePathHash = StorePath.hash(path);

		statuses.set(storePathHash, { storePathHash, state: 'absent' });
		changed.add(storePathHash);
	}

	const isUnchanged = (path: StorePathString) =>
		!changed.has(StorePath.hash(path));
	const isStillRecorded = (path: StorePathString) => {
		const storePathHash = StorePath.hash(path);
		const status = statuses.get(storePathHash);

		if (status?.state !== 'recorded') {
			return false;
		}

		const initialStatus = initialStatuses.get(storePathHash);

		return (
			status.buildInputsVersion === buildInputsVersion ||
			(status.buildInputsVersion > buildInputsVersion &&
				initialStatus?.state === 'recorded' &&
				initialStatus.buildInputsVersion === status.buildInputsVersion)
		);
	};

	return {
		statuses,
		copied: new Set([...state.copied].filter((path) => isUnchanged(path))),
		outcome:
			state.outcome.kind === 'recorded'
				? {
						kind: 'recorded',
						results: state.outcome.results.filter(
							({ storePath }) =>
								isUnchanged(storePath) || isStillRecorded(storePath)
						)
					}
				: state.outcome
	};
}

async function recordOutcome(
	options: PlanDependenciesRunOptions,
	reporter: Reporter,
	service: DependencyPassService,
	records: readonly BuildInputsRecordEntry[]
): Promise<BuildInputsRecordOutcome> {
	if (!options.shouldRecord) {
		return { kind: 'not-requested' };
	}

	if (records.length === 0) {
		return { kind: 'recorded', results: [] };
	}

	try {
		const results = await reporter.phase('Recording build inputs', () =>
			service.record(records)
		);

		return { kind: 'recorded', results };
	} catch (error) {
		if (options.signal?.aborted === true) {
			throw error;
		}

		if (error instanceof BuildInputsRecordRefusedError) {
			reporter.info(
				'The trust rule does not grant build-inputs:record, so the run root keeps the paths whose build inputs are not recorded. Run `cupboard github check --fix` to add the grant.'
			);

			return { kind: 'refused' };
		}

		reporter.warn(
			'cannot record build inputs',
			`${error instanceof Error ? error.message : String(error)}. The run root keeps the paths whose build inputs are not recorded, and the next run records them.`
		);

		return { kind: 'failed' };
	}
}

function reportSummary(
	reporter: Reporter,
	summary: DependencyPassSummary
): DependencyPassSummary {
	reporter.result({
		kind: dependencyPassResultKind,
		title: 'Build dependencies',
		data: summary,
		rows:
			summary.status === 'unsupported'
				? [
						{
							label: 'Status',
							value: 'the cache does not report dependency status'
						}
					]
				: [
						{ label: 'Paths', value: formatCount(summary.paths) },
						{ label: 'Copied', value: formatCount(summary.copied) },
						{ label: 'Build inputs', value: summary.record },
						{ label: 'Recorded', value: formatCount(summary.recorded) },
						{ label: 'Unchanged', value: formatCount(summary.unchanged) },
						{ label: 'Blocked', value: formatCount(summary.blocked) },
						{
							label: 'Attached to the run root',
							value: formatCount(summary.attached)
						},
						{
							label: 'Not attached',
							value: formatCount(summary.unattached)
						},
						{
							label: 'Attach rounds',
							value: formatCount(summary.attachRounds)
						}
					]
	});

	return summary;
}

interface PlanDependenciesOptions {
	readonly graphFile: string;
	readonly runRoot: RootName;
	readonly runRootTtl?: TtlSeconds;
	readonly runRootPermanent?: boolean;
	readonly recordBuildInputs?: boolean;
	readonly referenceSource?: URL;
	readonly readCache: readonly URL[];
	readonly accessKey?: AccessKeySecret;
	readonly viewAccessKey?: AccessKeySecret;
	readonly githubOidc?: boolean;
	readonly audience?: Audience;
}

export interface DependencyPassServiceOptions {
	readonly tenantUrl: URL;
	readonly cache: CacheScope;
	readonly runRoot: UploadAttachRoot;
	/**
	The reuse view or cache to copy from, read with `sourceCredential`.
	*/
	readonly referenceSource?: URL;
	/**
	Other caches of the tenant to copy from. The run reads them with its read
	session, as Nix does.
	*/
	readonly readCaches: readonly URL[];
	readonly sourceCredential?: BasicCredential;
	readonly destinationCredential?: BasicCredential;
	readonly buildInputs: BuildInputsDocument;
	readonly credentialKind: PushCredential;
	readonly reporter: Reporter;
	readonly signal?: AbortSignal;
}

/**
The cache clients of a dependency pass. The command uses token exchanges,
oRPC clients and pushes against the tenant; a test replaces them.
*/
export interface DependencyPassServiceDependencies {
	readonly authenticate: (
		authorizationDetails: AuthorizationDetails
	) => Promise<AccessCredential>;
	readonly tenantClients: (credential: AccessCredential) => {
		readonly uploads: DependencyStatusClient;
		readonly buildInputs: BuildInputsRecordClient;
	};
	readonly pushClient: (
		credential: AccessCredential,
		buildInputs: BuildInputsDocument | undefined
	) => PushClient;
	readonly readReferences: typeof tenantDependencyReferences;
	readonly runPush: typeof runPush;
	readonly fetchAccess: (url: URL) => Promise<CacheAccessMode>;
}

function buildInputsDocumentOf(
	document: DependencyGraphDocument
): BuildInputsDocument {
	return {
		version: buildInputsDocumentVersion,
		buildInputsVersion: document.buildInputsVersion,
		paths: Object.fromEntries(
			document.paths.map(({ storePath, buildInputs }) => [
				storePath,
				buildInputs
			])
		)
	};
}

interface ReferenceLookup {
	readonly paths: StorePathString[];
	readonly source: CachedClosureSource;
}

/**
Builds the cache operations of a dependency pass. Token A, exchanged here,
has the push operations on the destination, `root:attach` for the run root,
and read access to the private reference source and read caches. The
server reports a source for an absent path only when token A may reuse from
it: a public cache, a cache that the token may read, or a member of a reuse
view that the token may read. A copy therefore reads each path from the
configured source for its cache, from the cache itself when it is public,
and otherwise through the reference source, which is the view that grants
the access.
*/
export async function dependencyPassService(
	options: DependencyPassServiceOptions,
	dependencies: DependencyPassServiceDependencies
): Promise<DependencyPassService> {
	const { tenantUrl, cache, reporter, signal } = options;
	const configured: readonly CachedClosureSource[] = [
		...(options.referenceSource === undefined
			? []
			: [
					{
						url: options.referenceSource,
						paths: [],
						...(options.sourceCredential !== undefined && {
							credential: options.sourceCredential
						})
					}
				]),
		...options.readCaches.map((url) => ({ url, paths: [] }))
	];
	const sourceReads = await referenceSourceReadIntents(
		configured.map(({ url }) => url),
		{ tenantUrl, cache },
		dependencies.fetchAccess
	);
	const credential = await dependencies.authenticate(
		dependencyPassAuthorizationDetails({
			cache,
			runRoot: options.runRoot.name,
			sourceReads: sourceReads.intents
		})
	);
	const clients = dependencies.tenantClients(credential);
	const resolved = new Map<string, Promise<CachedClosureSource | undefined>>();
	const resolveSource = async (
		url: URL
	): Promise<CachedClosureSource | undefined> => {
		const direct = configured.find(
			(source) => canonicalHref(source.url) === canonicalHref(url)
		);

		if (direct !== undefined) {
			return direct;
		}

		let access: CacheAccessMode;

		try {
			access = await dependencies.fetchAccess(url);
		} catch (error) {
			if (isAbortError(error)) {
				throw error;
			}

			// The pass resolves each source once, so the warning appears once.
			reporter.warn(
				'cannot read a dependency source',
				`${canonicalHref(url)} did not answer its access probe: ${error instanceof Error ? error.message : String(error)}. The pass does not copy the paths that it offers.`
			);

			return undefined;
		}

		return access === 'public' ? { url, paths: [] } : configured[0];
	};
	const sourceFor = (
		scope: CacheScope
	): Promise<CachedClosureSource | undefined> => {
		const url = cacheUrl(tenantUrl, scope);
		const key = canonicalHref(url);
		const cached = resolved.get(key);

		if (cached !== undefined) {
			return cached;
		}

		const source = resolveSource(url);
		resolved.set(key, source);

		return source;
	};
	const references = async (
		lookups: readonly ReferenceLookup[]
	): Promise<Awaited<ReturnType<typeof tenantDependencyReferences>>> => {
		const found = [];

		for (const lookup of lookups) {
			try {
				found.push(
					...(await dependencies.readReferences(lookup.paths, {
						tenantUrl,
						sources: [lookup.source],
						...(signal !== undefined && { signal })
					}))
				);
			} catch (error) {
				if (isAbortError(error)) {
					throw error;
				}

				// The caller treats the paths of a failed lookup as not found.
				reporter.warn(
					'cannot read dependency metadata',
					`${canonicalHref(lookup.source.url)}: ${error instanceof Error ? error.message : String(error)}. The pass leaves ${String(lookup.paths.length)} path(s) from this source as they are.`
				);
			}
		}

		return found;
	};
	const publish = async (
		found: Awaited<ReturnType<typeof tenantDependencyReferences>>,
		buildInputs: BuildInputsDocument | undefined
	): Promise<void> => {
		const manifest = JSON.stringify({ version: 1, paths: found });
		const publication = PublicationCollection.of({
			targets: [],
			references: parseReferenceManifest(manifest)
		});

		await dependencies.runPush(publication, reporter, {
			command: 'cupboard plan dependencies',
			credential: options.credentialKind,
			client: dependencies.pushClient(credential, buildInputs),
			retain: false,
			runRoot: options.runRoot,
			signal
		});
	};

	return {
		statuses: (storePathHashes) =>
			dependencyStatuses(clients.uploads, cache, storePathHashes, { signal }),
		copy: async (copies) => {
			const lookups = new Map<string, ReferenceLookup>();

			for (const { storePath, source: scope } of copies) {
				const source = await sourceFor(scope);

				if (source === undefined) {
					continue;
				}

				const key = canonicalHref(source.url);
				const lookup = lookups.get(key) ?? { paths: [], source };

				lookup.paths.push(storePath);
				lookups.set(key, lookup);
			}

			const found = await references(lookups.values().toArray());
			const unread = copies.length - found.length;

			if (unread > 0) {
				reporter.warn(
					'cannot read every dependency output to copy',
					`${String(unread)} path(s) that other caches should have could not be read from them, so the pass does not copy them. The pass does not record the paths above them, and attaches to the run root the present paths that no recorded build inputs keep.`
				);
			}

			if (found.length === 0) {
				return new Set();
			}

			const copied = new Set(found.map(({ storePath }) => storePath));

			try {
				await publish(found, options.buildInputs);
			} catch (error) {
				if (!(error instanceof PushIncompleteError)) {
					throw error;
				}

				// A push reports each failed path by its basename.
				const failed = new Set(error.failedPaths);

				for (const path of copied) {
					if (failed.has(StorePath.basename(path))) {
						copied.delete(path);
					}
				}

				reporter.warn(
					'cannot copy every dependency output',
					`${String(error.failedPaths.length)} path(s) could not be copied from other caches. The pass does not record the paths above them, and attaches to the run root the present paths that no recorded build inputs keep.`
				);
			}

			return copied;
		},
		record: async (entries) => {
			let recordCredential: AccessCredential;

			try {
				recordCredential = await dependencies.authenticate(
					buildInputsRecordAuthorizationDetails({ cache })
				);
			} catch (error) {
				if (isBuildInputsGrantRefusal(error)) {
					throw new BuildInputsRecordRefusedError({ cause: error });
				}

				throw error;
			}

			return recordBuildInputs(
				dependencies.tenantClients(recordCredential).buildInputs,
				cache,
				entries,
				{ signal }
			);
		},
		attach: async (paths) => {
			const found = await references([
				{
					paths: [...paths],
					source: {
						url: cacheUrl(tenantUrl, cache),
						paths: [],
						...(options.destinationCredential !== undefined && {
							credential: options.destinationCredential
						})
					}
				}
			]);

			const attached = new Set(found.map(({ storePath }) => storePath));

			if (found.length > 0) {
				try {
					await publish(found, undefined);
				} catch (error) {
					if (!(error instanceof PushIncompleteError)) {
						throw error;
					}

					// A push reports each failed path by its basename.
					const failed = new Set(error.failedPaths);

					for (const path of attached) {
						if (failed.has(StorePath.basename(path))) {
							attached.delete(path);
						}
					}
				}
			}

			return {
				attached: paths.filter((path) => attached.has(path)),
				missing: paths.filter((path) => !attached.has(path))
			};
		}
	};
}

export function registerPlanDependenciesCommand(
	plan: Command,
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	plan
		.command('dependencies')
		.description(
			'Automation helper for the flake publish workflow. Keep the build-time dependencies of the published targets in the cache: copy the ones that another cache of the tenant has, record the build inputs of the ones that the cache has, and attach the ones whose build inputs cannot be recorded to the run root.'
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('[cache]', 'cache name, if the URL is a tenant URL')
		.requiredOption(
			'--graph-file <path>',
			'JSON dependency graph document, version 1, as dependencyGraphDocumentSchema in @cupboard/protocol defines it'
		)
		.requiredOption(
			'--run-root <name>',
			'run root for the copied paths and for the paths whose build inputs cannot be recorded',
			parseRootName
		)
		.option(
			'--run-root-ttl <duration>',
			'expire the run root after this duration (e.g. 7d, 12h)',
			parseTtl
		)
		.option('--run-root-permanent', 'keep the run root permanently')
		.option(
			'--record-build-inputs',
			'record build inputs on the paths that the cache already has, which needs the build-inputs:record grant. Without this option, the run root keeps those paths.'
		)
		.option(
			'--reference-source <url>',
			'cache URL or reuse view URL to copy absent dependency outputs from, read with the view access key',
			parseWorkerUrl
		)
		.option(
			'--read-cache <url>',
			"another cache of the tenant to copy absent dependency outputs from, read with the run's read session (repeatable)",
			(value: string, previous: readonly URL[]) => [
				...previous,
				parseWorkerUrl(value)
			],
			[]
		)
		.option(
			'--access-key <key>',
			'access key for a private cache (default: $CUPBOARD_ACCESS_KEY)',
			parseAccessKey
		)
		.option(
			'--view-access-key <key>',
			'access key for a private reference source (default: $CUPBOARD_VIEW_ACCESS_KEY)',
			parseAccessKey
		)
		.option(
			'--github-oidc',
			"sign in with the job's GitHub Actions OIDC token instead of your saved `cupboard login` session"
		)
		.option(
			'--audience <audience>',
			'OIDC audience to request with --github-oidc (default: the tenant URL)',
			parseAudience
		)
		.action(
			async (
				url: URL,
				cacheName: string | undefined,
				options: PlanDependenciesOptions
			) => {
				const urlTarget = cacheTargetFromUrl(url);
				const target =
					cacheName === undefined
						? urlTarget
						: cacheTargetWithName(urlTarget, cacheName);
				const runRoot = {
					name: options.runRoot,
					retention: rootRetentionChoice(
						options.runRootTtl,
						options.runRootPermanent
					)
				};
				const document = parseDependencyGraphDocument(
					await readFile(options.graphFile, 'utf8')
				);
				const reporter = commandUi(program, programOptions).reporter();
				const accessKey = sessionReplacingAccessKey(options, reporter);
				const sourceAccessKey =
					options.referenceSource === undefined
						? undefined
						: accessKeyFor(options, 'view');

				const destinationCredential =
					accessKey === undefined
						? undefined
						: basicCredentialForAccessKey(accessKey);
				const sourceCredential =
					sourceAccessKey === undefined
						? undefined
						: basicCredentialForAccessKey(sourceAccessKey);
				const signal = programOptions.signal;
				const cache = target.cache;
				const audience =
					options.audience ?? audienceSchema.parse(target.tenantUrl);
				const service = await dependencyPassService(
					{
						tenantUrl: target.tenantUrl,
						cache,
						runRoot,
						...(options.referenceSource !== undefined && {
							referenceSource: options.referenceSource
						}),
						readCaches: options.readCache,
						...(sourceCredential !== undefined && { sourceCredential }),
						...(destinationCredential !== undefined && {
							destinationCredential
						}),
						buildInputs: buildInputsDocumentOf(document),
						credentialKind: dependencyCredentialKind(options, accessKey),
						reporter,
						...(signal !== undefined && { signal })
					},
					{
						authenticate: (authorizationDetails) =>
							accessKey === undefined
								? authenticateForPush(
										CupboardClient.fromUrl(target.tenantUrl, { cache, signal }),
										{
											githubOidc: options.githubOidc,
											audience,
											authorizationDetails
										}
									)
								: Promise.resolve(accessKey),
						tenantClients: (credential) =>
							tenantRpc(target.tenantUrl, { credential, signal }),
						pushClient: (credential, buildInputs) =>
							pushClientFor(target.tenantUrl, credential, {
								cache,
								signal,
								...(buildInputs !== undefined && { buildInputs })
							}),
						readReferences: tenantDependencyReferences,
						runPush,
						fetchAccess: cacheAccessFetcher({ signal })
					}
				);

				await runPlanDependencies(
					{
						document,
						shouldRecord: options.recordBuildInputs === true,
						...(programOptions.signal !== undefined && {
							signal: programOptions.signal
						})
					},
					reporter,
					service
				);
			}
		);
}

function dependencyCredentialKind(
	options: Pick<PlanDependenciesOptions, 'githubOidc'>,
	accessKey: AccessKeySecret | undefined
): PushCredential {
	if (accessKey !== undefined) {
		return 'access-key';
	}

	return options.githubOidc === true ? 'github-oidc' : 'cupboard-login';
}
