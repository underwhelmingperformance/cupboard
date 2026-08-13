import { open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MismatchedNarInfoPathError } from '@cupboard/nix-store/errors';
import {
	type NarInfoOffer,
	offerFromNarInfo
} from '@cupboard/nix-store/narinfo-reader';
import {
	type StoreDirectory,
	storeDirectorySchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { byCodeUnit, StorePath } from '@cupboard/nix-store/store-path';
import { canonicalHref } from '@cupboard/nix-store/url';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import {
	basicAuthHeader,
	type BasicCredential,
	readUserSchema
} from '@cupboard/shared/http';

import {
	type LocalStoreDirectories,
	localStoreOfUri,
	storeUriParameters,
	storeUriQuery
} from './local-store-uri.ts';
import { netrcCredentialFor } from './netrc.ts';
import {
	type NixStoreDatabase,
	openLocalStoreDatabase,
	pathInfoIn
} from './nix-local-store.ts';
import {
	NixConfigSettingError,
	NixStoreError,
	type NixSubstituterOffer,
	type UnreachableSubstituter
} from './nix-store.ts';
import {
	defaultFileTransferSettings,
	isEnabledSettingValue,
	type NixFileTransferSettings
} from './store-config.ts';

/**
 * How many bytes of a substituter's answer are read. A narinfo and a
 * `nix-cache-info` are both a few hundred bytes, so this is far above any
 * real one and bounds what a substituter can make this process hold.
 */
export const maxSubstituterAnswerByteLength = 1024 * 1024;

/**
 * How many requests are in flight at once when the configuration puts no
 * bound on them. Each question is one request, so something has to keep a
 * query over a whole closure from opening a connection per path.
 */
export const unboundedSubstituterConcurrency = 64;

/**
 * The longest this waits before asking a substituter again. A substituter that
 * asks to be left alone for longer than this is left alone: the query gives up
 * on it and reports it as one that did not answer, rather than coming back
 * before it said it would be ready.
 */
export const maxRetryWaitMs = 60_000;

// A server that is rate-limiting this client, or saying it is overloaded, is
// given the longer wait before being asked again.
const rateLimitedStatuses = new Set([429, 503]);

/**
 * The statuses worth trying again. A server that timed out waiting for the
 * request, one asking for a slower pace, and one failing on its own account
 * may all answer next time; a server that has already given its answer about
 * the request itself will give the same one.
 */
function isTransientStatus(status: number): boolean {
	if (status === 408 || status === 429) {
		return true;
	}

	// 501, 505 and 511 are the server's answer about the request, not a
	// passing condition: not implemented, a version it will not speak, and a
	// captive portal standing in the way.
	return status >= 500 && ![501, 505, 511].includes(status);
}

/** The default for a substituter that advertises no priority. */
const defaultPriority = 0;

const cacheInfoFile = 'nix-cache-info';
const servedStoreDirectory = storeDirectorySchema.parse('/nix/store');

// The settings a request runs under, defaulting to the compiled-in ones so a
// caller that states none still attempts a request the way Nix would.
function transferSettings(
	dependencies: SubstituterEnvironment
): NixFileTransferSettings {
	return dependencies.transfer ?? defaultFileTransferSettings;
}

// The store directory the answers are for, which is also the one a substituter
// naming none of its own is read as serving.
function queriedStoreDirectory(
	dependencies: SubstituterEnvironment
): StoreDirectory {
	return dependencies.storeDirectory ?? servedStoreDirectory;
}

// `http-connections` reads zero as no limit, which still needs a bound here:
// a query over a whole closure would otherwise open a connection per path.
function requestConcurrency(dependencies: SubstituterEnvironment): number {
	const { httpConnections } = transferSettings(dependencies);

	return httpConnections === 0
		? unboundedSubstituterConcurrency
		: httpConnections;
}

/** A substituter that failed to answer, named so a caller can say which. */
export class SubstituterUnreachableError extends NixStoreError {
	/** The wait the substituter asked for, when it asked for one. */
	readonly retryAfterMs?: number;

	constructor(
		public readonly substituter: string,
		public readonly status?: number,
		options?: ErrorOptions & { readonly retryAfterMs?: number }
	) {
		super(
			status === undefined
				? `Substituter did not answer: ${substituter}`
				: `Substituter answered ${String(status)}: ${substituter}`,
			options
		);
		this.name = 'SubstituterUnreachableError';

		if (options?.retryAfterMs !== undefined) {
			this.retryAfterMs = options.retryAfterMs;
		}
	}
}

/** A substituter whose answer could not be read as one. */
export class SubstituterAnswerUnreadableError extends NixStoreError {
	constructor(
		public readonly substituter: string,
		options?: ErrorOptions
	) {
		super(`Substituter answered something unreadable: ${substituter}`, options);
		this.name = 'SubstituterAnswerUnreadableError';
	}
}

/**
 * What a substituter advertises about itself, read from its `nix-cache-info`.
 * The compiled-in defaults fill in whatever the document leaves out, so a cache
 * publishing only its store directory reads as priority zero and unwilling to
 * answer a batch.
 */
export interface SubstituterDescription {
	/** The store directory this substituter serves paths for. */
	readonly storeDirectory: StoreDirectory;
	/**
	 * Whether the substituter invites being asked about many paths at once.
	 * Only one that says so is given a batch to answer.
	 */
	readonly hasMassQuery: boolean;
	/** Lower sorts earlier, so the lowest-numbered substituter answers first. */
	readonly priority: number;
	/**
	 * Whether this substituter is configured as trusted, which takes what it
	 * serves without asking for a signature.
	 */
	readonly isTrusted: boolean;
}

/**
 * Where a substituter's documents are read from. A binary cache is a set of
 * files under a base, whether that base is an HTTP endpoint or a directory on
 * this machine.
 */
export type SubstituterLocation =
	| {
			/**
			 * A local Nix store, which serves what its database holds. A store
			 * publishes no `nix-cache-info` and no narinfo, so its answers are
			 * read from the database rather than from documents.
			 */
			readonly kind: 'local-store';
			readonly directories: LocalStoreDirectories;
	  }
	| {
			readonly kind: 'http';
			readonly baseUrl: URL;
			/**
			 * What the cache asks for before it serves anything, when the store
			 * URI or the netrc names it.
			 */
			readonly credential?: BasicCredential;
	  }
	| { readonly kind: 'file'; readonly directory: string };

/** One configured substituter, ready to be asked about paths. */
export interface Substituter extends SubstituterDescription {
	/** The substituter as configured, which names it in an error. */
	readonly uri: string;
	/** Where each of its documents is read from. */
	readonly location: SubstituterLocation;
}

export interface SubstituterEnvironment {
	readonly fetch?: typeof fetch;
	readonly signal?: AbortSignal;
	/**
	 * How a request is attempted and how long it waits before being attempted
	 * again, as the running configuration settles it.
	 */
	readonly transfer?: NixFileTransferSettings;
	/** Waits between tries, injected so a test does not. */
	readonly delay?: (
		milliseconds: number,
		signal: AbortSignal | undefined
	) => Promise<void>;
	/**
	 * How much of a wait is spread, between none and all of it, injected so a
	 * test reads a wait it can state.
	 */
	readonly spread?: () => number;
	/**
	 * The store directory a substituter serves when its `nix-cache-info` does
	 * not name one. Nix reads that as the directory the store it opened
	 * serves, which is the one being asked about.
	 */
	readonly storeDirectory?: StoreDirectory;
	/**
	 * Where a local store keeps its database, for a substituter naming a store
	 * rather than a cache. A URI naming a root of its own states this itself.
	 */
	readonly stateDirectory?: string;
	/** Opens a local store's database, injected so a test needs no store. */
	readonly openStore?: (stateDirectory: string) => NixStoreDatabase;
	/**
	 * The netrc the configuration names, as it was read. A request to a host it
	 * names carries that host's credentials.
	 */
	readonly netrc?: string;
}

/** The substituters a client can ask, and the ones it cannot. */
export interface OpenedSubstituters {
	/**
	 * Ordered the way Nix orders them: by ascending priority, ties keeping
	 * configured order.
	 */
	readonly substituters: readonly Substituter[];
	readonly unreachable: readonly UnreachableSubstituter[];
}

/**
 * Opens each configured substituter. One that cannot describe itself and one
 * serving another store's paths are both left out, and each is named among the
 * unreachable: every later answer is missing whatever it held.
 *
 * A resolved configuration holds the substituters Nix holds, a URI stated
 * twice among them, so each distinct one is opened and asked once.
 */
export async function openSubstituters(
	uris: readonly string[],
	dependencies: SubstituterEnvironment = {}
): Promise<OpenedSubstituters> {
	const opened = await mapWithConcurrency(
		[...new Set(uris)],
		requestConcurrency(dependencies),
		async (uri): Promise<OpenOutcome> => {
			const parsed = substituterConfiguration(uri, dependencies);

			if (!parsed.opened) {
				return { opened: false, unreachable: { uri, reason: parsed.reason } };
			}

			const { location, configured } = parsed;
			const described = await describeSubstituter(location, uri, dependencies);

			if (described.kind !== 'described') {
				return {
					opened: false,
					unreachable: { uri, reason: described.reason }
				};
			}

			// A store URI's own parameters settle what they name, and the
			// document fills in the rest.
			const substituter = {
				uri,
				location,
				...described.description,
				...configured
			};
			const queried = queriedStoreDirectory(dependencies);

			// Nix refuses to open a cache serving another store's paths, so it
			// is named here rather than left out of the query silently: every
			// answer the query gives is missing whatever that cache held.
			return substituter.storeDirectory === queried
				? { opened: true, substituter }
				: {
						opened: false,
						unreachable: {
							uri,
							reason: 'store-directory-mismatch',
							servesStoreDirectory: substituter.storeDirectory,
							queriedStoreDirectory: queried
						}
					};
		}
	);
	const substituters: Substituter[] = [];
	const unreachable: UnreachableSubstituter[] = [];

	for (const outcome of opened) {
		if (outcome.opened) {
			substituters.push(outcome.substituter);
		} else {
			unreachable.push(outcome.unreachable);
		}
	}

	return {
		substituters: substituters
			.map((substituter, order) => ({ substituter, order }))
			.toSorted(
				(left, right) =>
					left.substituter.priority - right.substituter.priority ||
					left.order - right.order
			)
			.map(({ substituter }) => substituter),
		unreachable
	};
}

// How opening one configured substituter settled.
type OpenOutcome =
	| { readonly opened: true; readonly substituter: Substituter }
	| { readonly opened: false; readonly unreachable: UnreachableSubstituter };

/**
 * The substituters a client asks: the opened ones, or a way to open them when
 * it is first asked something.
 */
export type SubstituterSource =
	readonly Substituter[] | (() => Promise<OpenedSubstituters>);

/** What the substituter queries need to know beyond the substituters. */
export interface SubstituterClientOptions extends SubstituterEnvironment {
	/** The store the answers are for: a substituter serving another is skipped. */
	readonly storeDirectory: StoreDirectory;
	/** The `substitute` setting: with it off, nothing is substitutable. */
	readonly substitute: boolean;
	/**
	 * The `fallback` setting. A substituter that fails leaves the whole query
	 * in doubt, since it might have held what it failed to answer for, so by
	 * default the failure is raised; with `fallback` on, Nix carries on
	 * without it and so does this.
	 */
	readonly fallback: boolean;
}

/**
 * Asks a store's substituters what they can supply, the way libstore does when
 * no daemon holds the substituter configuration for it.
 *
 * Every answer comes from the substituter itself. Nix keeps a database of the
 * narinfos it has read and reuses an entry for as long as
 * `narinfo-cache-positive-ttl` or `narinfo-cache-negative-ttl` allows, so an
 * answer of its can be a month old for a path a cache holds and an hour old
 * for one it does not. Nothing is kept here, so what these queries report is
 * what those substituters serve now.
 *
 * That is the stricter reading, and the one a plan needs. A plan decides which
 * targets to publish and which to leave for consumers to fetch, and a
 * remembered absence would make it publish work already available while a
 * remembered presence would make it leave a target on a copy that has since
 * gone. The cost is a request per path per run, which is what a plan is for.
 */
export class SubstituterClient {
	private opening?: Promise<OpenedSubstituters>;

	constructor(
		private readonly source: SubstituterSource,
		private readonly options: SubstituterClientOptions
	) {}

	// Opening a substituter reads its `nix-cache-info`, so a client built
	// from configured URIs opens them when it is first asked something, and
	// holds them for every question after.
	private open(): Promise<OpenedSubstituters> {
		const source = this.source;

		if (typeof source !== 'function') {
			return Promise.resolve({ substituters: source, unreachable: [] });
		}

		const opening = (this.opening ??= source());

		return opening;
	}

	private async opened(): Promise<readonly Substituter[]> {
		const { substituters } = await this.open();

		return substituters;
	}

	// Nix asks each substituter in turn and takes the first answer, so a
	// higher-priority substituter's copy is the one reported.
	private async firstOffer(
		storePath: StorePathString
	): Promise<NixSubstituterOffer | undefined> {
		let failure: SubstituterUnreachableError | undefined;
		const substituters = await this.opened();

		for (const substituter of substituters) {
			if (!this.serves(substituter)) {
				continue;
			}

			// A failure the next substituter gets a chance to answer past is
			// left behind, so only the last one asked can settle the query.
			failure = undefined;

			const answer = await this.offerFor(substituter, storePath);

			if (answer.kind === 'held') {
				return { storePath, ...answer.offer };
			}

			if (answer.kind === 'failed') {
				failure = answer.error;
			}
		}

		this.raiseIfLastFailed(failure);

		return undefined;
	}

	// The substituter asked last is the one whose failure stands: an earlier
	// one that failed was followed by a substituter that answered for the
	// question, so nothing about it is left in doubt.
	private raiseIfLastFailed(failure: SubstituterFailure | undefined): void {
		if (failure !== undefined && !this.options.fallback) {
			throw failure;
		}
	}

	// Nix puts a question only to the substituters serving the store directory
	// it is asking about, so one serving another store's paths answers nothing
	// here.
	private serves(substituter: Substituter): boolean {
		return substituter.storeDirectory === this.options.storeDirectory;
	}

	private async offerFor(
		substituter: Substituter,
		storePath: StorePathString
	): Promise<SubstituterAnswer> {
		if (substituter.location.kind === 'local-store') {
			return this.offerFromStore(
				substituter,
				substituter.location.directories,
				storePath
			);
		}

		const asked = await readDocument(
			substituter.location,
			substituter.uri,
			`${StorePath.hash(storePath)}.narinfo`,
			this.options
		);

		if (asked.kind !== 'answered') {
			return asked;
		}

		try {
			return {
				kind: 'held',
				offer: {
					...offerFromNarInfo(
						asked.document,
						storePath,
						this.options.storeDirectory
					),
					fromTrustedSubstituter: substituter.isTrusted
				}
			};
		} catch (error) {
			this.raiseIfAbandoned();

			// A narinfo naming another path describes something the caller did
			// not ask for, which reads as a substituter that does not hold it.
			if (error instanceof MismatchedNarInfoPathError) {
				return { kind: 'absent' };
			}

			return {
				kind: 'failed',
				error: new SubstituterAnswerUnreadableError(substituter.uri, {
					cause: error
				})
			};
		}
	}

	/**
	 * What a local store offers for the path, read from its database. A store
	 * serves the NAR it would dump on request, so it names no transfer size:
	 * Nix reports a download of nothing for a store that publishes no narinfo,
	 * and the NAR size the database holds for what the fetch would materialise.
	 */
	private offerFromStore(
		substituter: Substituter,
		directories: LocalStoreDirectories,
		storePath: StorePathString
	): SubstituterAnswer {
		const open = this.options.openStore ?? openLocalStoreDatabase;
		let database: NixStoreDatabase;

		try {
			database = open(directories.stateDirectory);
		} catch (error) {
			this.raiseIfAbandoned();

			return {
				kind: 'failed',
				error: new SubstituterUnreachableError(substituter.uri, undefined, {
					cause: error
				})
			};
		}

		try {
			const held = pathInfoIn(database, storePath);

			if (held === undefined) {
				return { kind: 'absent' };
			}

			return {
				kind: 'held',
				offer: {
					source: 'substituter',
					narHash: held.narHash,
					narSize: held.narSize,
					downloadSize: 0,
					references: held.references,
					signatures: held.signatures,
					fromTrustedSubstituter: substituter.isTrusted,
					...(held.deriver !== undefined && { deriver: held.deriver })
				}
			};
		} catch (error) {
			this.raiseIfAbandoned();

			return {
				kind: 'failed',
				error: new SubstituterAnswerUnreadableError(substituter.uri, {
					cause: error
				})
			};
		} finally {
			database.close();
		}
	}

	// A caller that abandons the query gets its own reason back, never a
	// report about the substituter it happened to be talking to.
	private raiseIfAbandoned(): void {
		this.options.signal?.throwIfAborted();
	}

	/**
	 * The configured substituters nothing could be asked of, as far as this
	 * client has asked anything. A client that has been asked nothing has
	 * opened nothing and reports none: there are no answers yet for a
	 * substituter's absence to have shaped.
	 */
	async unreachable(): Promise<readonly UnreachableSubstituter[]> {
		const opening = this.opening;

		if (opening === undefined) {
			return [];
		}

		const { unreachable } = await opening;

		return unreachable;
	}

	/**
	 * The subset of the given paths some substituter offers, deduplicated and
	 * sorted. Only substituters advertising `WantMassQuery` are asked, since
	 * the others have declared that answering a batch is not something they
	 * want, and each is asked only about what its predecessors left over.
	 *
	 * A substituter is asked for what it holds, the same question a single
	 * path's query asks, so a document it could not serve settles the path the
	 * same way here. Nix asks it that way too: this operation reaches its
	 * substituters through the same path-info read.
	 */
	async querySubstitutablePaths(
		storePaths: readonly StorePathString[]
	): Promise<readonly StorePathString[]> {
		if (!this.options.substitute) {
			return [];
		}

		const found = new Set<StorePathString>();
		const substituters = await this.opened();
		let remaining = [...new Set(storePaths)];
		let failure: SubstituterFailure | undefined;

		for (const substituter of substituters) {
			if (remaining.length === 0) {
				break;
			}

			if (!substituter.hasMassQuery || !this.serves(substituter)) {
				continue;
			}

			// A failure the next substituter gets a chance to answer past is
			// left behind, so only the last one asked can settle the query.
			failure = undefined;

			const answers = await mapWithConcurrency(
				remaining,
				requestConcurrency(this.options),
				(storePath) => this.offerFor(substituter, storePath)
			);

			for (const [index, storePath] of remaining.entries()) {
				const answer = answers[index];

				if (answer?.kind === 'held') {
					found.add(storePath);
				}

				if (answer?.kind === 'failed') {
					failure = answer.error;
				}
			}

			remaining = remaining.filter((storePath) => !found.has(storePath));
		}

		if (remaining.length > 0) {
			this.raiseIfLastFailed(failure);
		}

		return [...found].toSorted(byCodeUnit);
	}

	/**
	 * What the first substituter holding each path offers for it, sorted by
	 * store path. A path no substituter offers has no entry, and substituters
	 * are asked in priority order so the answer is the one Nix would fetch
	 * from.
	 */
	async querySubstitutablePathInfos(
		storePaths: readonly StorePathString[]
	): Promise<readonly NixSubstituterOffer[]> {
		if (!this.options.substitute) {
			return [];
		}

		const offers = await mapWithConcurrency(
			[...new Set(storePaths)],
			requestConcurrency(this.options),
			(storePath) => this.firstOffer(storePath)
		);

		return offers
			.filter((offer) => offer !== undefined)
			.toSorted((left, right) => byCodeUnit(left.storePath, right.storePath));
	}
}

/** What a substituter reported for one path, without naming the path. */
type SubstituterOffer = NarInfoOffer & {
	readonly fromTrustedSubstituter: boolean;
};

/** A substituter that answered neither what it holds nor that it holds nothing. */
type SubstituterFailure =
	SubstituterUnreachableError | SubstituterAnswerUnreadableError;

/**
 * What one substituter said about one path: what it holds, that it holds
 * nothing, or that it could not say. A failure is one substituter's, so
 * another may still answer the question.
 */
type SubstituterAnswer =
	| { readonly kind: 'held'; readonly offer: SubstituterOffer }
	| { readonly kind: 'absent' }
	| { readonly kind: 'failed'; readonly error: SubstituterFailure };

/**
 * The statuses that mean a substituter does not hold a path. A bucket that
 * will not list its contents answers 403 for an object it does not have, and
 * one that held a path and dropped it may answer 410, so Nix reads all three
 * as an absence.
 */
const absentStatuses = new Set([403, 404, 410]);

/** How one request settled, body and all. */
type DocumentOutcome =
	| { readonly kind: 'answered'; readonly document: string }
	| { readonly kind: 'absent' }
	| { readonly kind: 'failed'; readonly error: SubstituterFailure };

/**
 * Reads one document from a substituter, trying again while what went wrong
 * is something that may go differently: a connection that failed, a body that
 * stopped part-way, a server that timed out waiting, one asking for a slower
 * pace, and one failing on its own account. A server's answer about the
 * request itself stands, and so does a body too long to be an answer.
 *
 * The whole transfer is one attempt, so a body that fails after the headers
 * arrived is retried the same as a connection that never opened.
 */
async function fetchDocument(
	url: URL,
	uri: string,
	credential: BasicCredential | undefined,
	dependencies: SubstituterEnvironment
): Promise<DocumentOutcome> {
	const fetcher = dependencies.fetch ?? fetch;
	const settings = transferSettings(dependencies);
	let failure: SubstituterUnreachableError | undefined;

	for (let attempt = 0; attempt < settings.attempts; attempt += 1) {
		if (attempt > 0 && !(await waitToRetry(attempt, failure, dependencies))) {
			break;
		}

		let response: Response;

		try {
			response = await fetcher(url, {
				signal: requestSignal(
					settings.stalledTransferTimeoutMs,
					dependencies.signal
				),
				...(credential !== undefined && {
					headers: basicAuthHeader(credential)
				})
			});
		} catch (error) {
			dependencies.signal?.throwIfAborted();
			failure = new SubstituterUnreachableError(uri, undefined, {
				cause: error
			});
			continue;
		}

		if (absentStatuses.has(response.status)) {
			await discard(response);

			return { kind: 'absent' };
		}

		if (response.ok) {
			try {
				return {
					kind: 'answered',
					document: await boundedText(response, maxSubstituterAnswerByteLength)
				};
			} catch (error) {
				dependencies.signal?.throwIfAborted();

				// A body longer than an answer can be is what the server sent,
				// not a passing condition: coming back gets the same one.
				if (error instanceof OversizedSubstituterAnswerError) {
					return {
						kind: 'failed',
						error: new SubstituterAnswerUnreadableError(uri, { cause: error })
					};
				}

				failure = new SubstituterUnreachableError(uri, undefined, {
					cause: error
				});
				continue;
			}
		}

		await discard(response);
		failure = new SubstituterUnreachableError(uri, response.status, {
			retryAfterMs: retryAfterMilliseconds(response)
		});

		if (!isTransientStatus(response.status)) {
			break;
		}
	}

	return {
		kind: 'failed',
		error: failure ?? new SubstituterUnreachableError(uri)
	};
}

/**
 * Waits before the next attempt, reporting whether there is to be one. The
 * retries are spread so that clients answered alike do not all come back at
 * the same moment, and never come sooner than a server asked; a server saying
 * it is overloaded or rate-limiting this client is given longer.
 *
 * A server asking for longer than this query will wait gets no further
 * attempt: coming back before it is ready would spend one on the same answer.
 */
async function waitToRetry(
	attempt: number,
	failure: SubstituterUnreachableError | undefined,
	dependencies: SubstituterEnvironment
): Promise<boolean> {
	const wait = retryDelayMs(
		attempt,
		failure?.retryAfterMs,
		rateLimitedStatuses.has(failure?.status ?? 0),
		transferSettings(dependencies),
		dependencies.spread ?? Math.random
	);

	if (wait === undefined) {
		return false;
	}

	await (dependencies.delay ?? sleep)(wait, dependencies.signal);
	dependencies.signal?.throwIfAborted();

	return true;
}

/**
 * How long to wait before attempting a transfer again, or nothing when the
 * server asked to be left alone for longer than {@link maxRetryWaitMs}.
 *
 * The backoff doubles with each attempt up to `filetransfer-retry-max-delay`,
 * and a `Retry-After` is a hard minimum that ceiling does not cap. Nothing
 * here shortens either of them: the ceiling is what the operator configured,
 * and coming back before a server is ready only spends an attempt on the
 * answer it has already given. With jitter on, the wait falls between the
 * minimum and the minimum plus the backoff.
 *
 * The bound decides only whether a substituter is worth waiting for at all.
 */
function retryDelayMs(
	attempt: number,
	retryAfterMs: number | undefined,
	isRateLimited: boolean,
	settings: NixFileTransferSettings,
	spread: () => number
): number | undefined {
	const floor = retryAfterMs ?? 0;

	if (floor > maxRetryWaitMs) {
		return;
	}

	const base = isRateLimited
		? settings.rateLimitedRetryDelayMs
		: settings.retryDelayMs;
	const backoff = Math.min(
		base * 2 ** Math.min(attempt - 1, 31),
		settings.maxRetryDelayMs
	);

	return settings.retryJitter
		? floor + Math.round(spread() * backoff)
		: Math.max(floor, backoff);
}

/**
 * The wait a server asked for, or nothing when it asked for none this can read.
 * A server states the wait in seconds or as the moment to come back at, and Nix
 * reads it that way round; a header naming neither is one Nix passes over, so
 * the wait is the one the backoff would have settled on anyway.
 */
function retryAfterMilliseconds(response: Response): number | undefined {
	const header = response.headers.get('retry-after');

	if (header === null) {
		return;
	}

	const asked = header.trim();
	const seconds = delaySeconds(asked);

	if (seconds !== undefined) {
		return seconds * 1000;
	}

	const moment = Date.parse(asked);

	return Number.isNaN(moment) ? undefined : Math.max(0, moment - Date.now());
}

/**
 * The seconds a `Retry-After` states, when the whole of it states them. The
 * header writes a delay as digits and nothing else, and Nix reads the whole
 * value into an unsigned 32-bit count, so a sign, a fraction, anything
 * following the digits, and a count wider than that field all leave the value
 * naming no delay at all.
 */
function delaySeconds(value: string): number | undefined {
	if (!/^\d+$/u.test(value)) {
		return;
	}

	const seconds = Number(value);

	return seconds <= maxDelaySeconds ? seconds : undefined;
}

// The widest delay a `Retry-After` can stand for, which is the field Nix reads
// one into.
const maxDelaySeconds = 2 ** 32 - 1;

// A signal carries whatever reason the caller gave, which need not be an
// error; a caller that gave none gets the one abandoning always means.
function abandonedReason(signal: AbortSignal | undefined): Error {
	const reason: unknown = signal?.reason;

	return reason instanceof Error ? reason : new Error('The wait was abandoned');
}

function sleep(
	milliseconds: number,
	signal: AbortSignal | undefined
): Promise<void> {
	return new Promise((resolve, reject) => {
		// A listener added to a signal already aborted never fires, so that case
		// is settled here rather than left to one.
		if (signal?.aborted === true) {
			reject(abandonedReason(signal));

			return;
		}

		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', abandon);
			resolve();
		}, milliseconds);

		function abandon(): void {
			clearTimeout(timer);
			reject(abandonedReason(signal));
		}

		signal?.addEventListener('abort', abandon, { once: true });
	});
}

/**
 * Lets go of a response whose body is not read. An unread body holds its
 * connection until the response is collected, and a query over a closure asks
 * about thousands of paths most substituters do not hold.
 */
async function discard(response: Response): Promise<void> {
	await response.body?.cancel();
}

/** An answer longer than a substituter's answer can be. */
class OversizedSubstituterAnswerError extends NixStoreError {
	constructor(public readonly maxByteLength: number) {
		super(
			`A substituter answered with more than ${String(maxByteLength)} bytes`
		);
		this.name = 'OversizedSubstituterAnswerError';
	}
}

// Nix reads a priority with a signed conversion, which takes the digits it
// starts with and stops at the first character that is not one.
function leadingInteger(value: string): number | undefined {
	const digits = /^\s*(-?\d+)/u.exec(value);

	if (digits === null) {
		return;
	}

	const parsed = Number(digits[1]);

	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * A file's text, refusing one longer than an answer can be. The size is read
 * before the contents, so a directory holding something far larger than a
 * narinfo never has it loaded.
 */
async function boundedFileText(
	filePath: string,
	maxByteLength: number
): Promise<string> {
	const handle = await open(filePath);

	try {
		const { size } = await handle.stat();

		if (size > maxByteLength) {
			throw new OversizedSubstituterAnswerError(maxByteLength);
		}

		return await handle.readFile('utf8');
	} finally {
		await handle.close();
	}
}

/**
 * The answer's text, refusing one longer than an answer can be. A body
 * arrives in chunks, so the bound is applied as it is read: a substituter
 * cannot make this process hold a body it would then refuse.
 */
async function boundedText(
	response: Response,
	maxByteLength: number
): Promise<string> {
	const body = response.body;

	if (body === null) {
		return '';
	}

	const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
	const decoder = new TextDecoder();
	let text = '';
	let byteLength = 0;

	try {
		for (;;) {
			const { done, value } = await reader.read();

			if (done) {
				return text + decoder.decode();
			}

			byteLength += value.byteLength;

			if (byteLength > maxByteLength) {
				throw new OversizedSubstituterAnswerError(maxByteLength);
			}

			text += decoder.decode(value, { stream: true });
		}
	} finally {
		await reader.cancel();
	}
}

/**
 * The signal a single request runs under: the caller's, and a deadline of its
 * own, so a substituter that accepts a connection and never answers on it
 * settles rather than holding the query open.
 */
function requestSignal(
	timeoutMs: number,
	signal: AbortSignal | undefined
): AbortSignal {
	const deadline = AbortSignal.timeout(timeoutMs);

	return signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
}

/**
 * A substituter is configured as a store URI. A binary cache served over HTTP,
 * one held in a directory, and a local store are all read here; any other
 * scheme names a store this reader does not open, and it is reported as such
 * so a caller knows its answers are missing whatever that store holds.
 *
 * A local store is read from the URI as it was written, since Nix names one by
 * the bare word as well as by the scheme, and the bare word carrying
 * parameters is no URL.
 */
function substituterConfiguration(
	uri: string,
	dependencies: SubstituterEnvironment
): ConfigurationOutcome {
	const local = localStoreLocation(uri, dependencies);

	if (local !== undefined) {
		return describedBy(local, storeUriQuery(uri));
	}

	let parsed: URL;

	try {
		parsed = new URL(uri);
	} catch {
		return { opened: false, reason: 'unreadable-uri' };
	}

	const location = substituterLocation(parsed, dependencies);

	if (location === undefined) {
		return { opened: false, reason: 'unsupported-scheme' };
	}

	return describedBy(location, parsed.search.replace(/^\?/u, ''));
}

// The parameters a store URI carries settle what they name, and a value the
// setting they name could not hold leaves the URI naming a substituter this
// reader will not invent.
function describedBy(
	location: SubstituterLocation,
	query: string
): ConfigurationOutcome {
	try {
		return { opened: true, location, configured: configuredDescription(query) };
	} catch {
		return { opened: false, reason: 'unreadable-uri' };
	}
}

// The local store a substituter names, or `undefined` for one naming anything
// else. A URI naming no root of its own reads the directories the running
// configuration settled.
function localStoreLocation(
	uri: string,
	dependencies: SubstituterEnvironment
): SubstituterLocation | undefined {
	const directories = localStoreOfUri(uri, {
		storeDirectory: queriedStoreDirectory(dependencies),
		stateDirectory: dependencies.stateDirectory ?? defaultStateDirectory
	});

	return directories === undefined
		? undefined
		: { kind: 'local-store', directories };
}

// Where Nix keeps a local store's state when nothing names another directory.
const defaultStateDirectory = '/nix/var/nix';

type ConfigurationOutcome =
	| {
			readonly opened: true;
			readonly location: SubstituterLocation;
			readonly configured: Partial<SubstituterDescription>;
	  }
	| {
			readonly opened: false;
			readonly reason: 'unreadable-uri' | 'unsupported-scheme';
	  };

function substituterLocation(
	parsed: URL,
	dependencies: SubstituterEnvironment
): SubstituterLocation | undefined {
	if (parsed.protocol === 'file:') {
		return {
			kind: 'file',
			directory: fileURLToPath(withoutParameters(parsed))
		};
	}

	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return;
	}

	const credential = substituterCredential(parsed, dependencies.netrc);

	return {
		kind: 'http',
		baseUrl: withoutParameters(parsed),
		...(credential !== undefined && { credential })
	};
}

/**
 * What a cache asks for before it serves anything. A store URI stating a user
 * and password states the credentials itself, and one stating none leaves the
 * netrc to name them by host.
 */
function substituterCredential(
	parsed: URL,
	netrc: string | undefined
): BasicCredential | undefined {
	if (parsed.username !== '') {
		return {
			user: readUserSchema.parse(decodeURIComponent(parsed.username)),
			password: decodeURIComponent(parsed.password)
		};
	}

	const named =
		netrc === undefined
			? undefined
			: netrcCredentialFor(netrc, parsed.hostname);

	return named === undefined
		? undefined
		: { user: readUserSchema.parse(named.login), password: named.password };
}

/**
 * A store URI's parameters configure the store, so the base every document is
 * read under is the URI without them. The credentials it may state go the same
 * way: they are carried as a header, and a URL holding any is one no request
 * can be made from.
 */
function withoutParameters(parsed: URL): URL {
	const base = new URL(parsed);
	base.search = '';
	base.hash = '';
	base.username = '';
	base.password = '';

	return base;
}

/**
 * Reads one document from a substituter. An HTTP cache is asked for it, and a
 * directory is read: a file that is not there is the directory's way of saying
 * it holds nothing, and anything else that stops the read is the substituter
 * failing to answer.
 */
// A local store publishes no documents, so only a cache reaches this.
async function readDocument(
	location: Exclude<SubstituterLocation, { kind: 'local-store' }>,
	uri: string,
	documentPath: string,
	dependencies: SubstituterEnvironment
): Promise<DocumentOutcome> {
	if (location.kind === 'http') {
		return fetchDocument(
			new URL(`${canonicalHref(location.baseUrl)}/${documentPath}`),
			uri,
			location.credential,
			dependencies
		);
	}

	try {
		return {
			kind: 'answered',
			document: await boundedFileText(
				path.join(location.directory, documentPath),
				maxSubstituterAnswerByteLength
			)
		};
	} catch (error) {
		dependencies.signal?.throwIfAborted();

		return errorCodeOf(error) === absentFileErrorCode
			? { kind: 'absent' }
			: {
					kind: 'failed',
					error: new SubstituterUnreachableError(uri, undefined, {
						cause: error
					})
				};
	}
}

// What a filesystem reports for a document a directory does not hold. Nix reads
// this one code as the cache saying it holds nothing and lets every other one
// stand as the read failing, so a directory whose path runs through a file, or
// one this process may not read, is a substituter that could not answer rather
// than one answering that it holds nothing.
const absentFileErrorCode = 'ENOENT';

function errorCodeOf(error: unknown): string {
	return error instanceof Error && 'code' in error
		? String(error.code)
		: 'unknown';
}

/**
 * Reads what a substituter says about itself. An HTTP read is attempted the
 * same way every other one is, so a cache that is briefly unreachable while a
 * plan starts is still opened rather than left out of every answer after.
 *
 * A substituter that says something unreadable, or says more than an answer
 * can hold, cannot be asked about a store's paths.
 */
async function describeSubstituter(
	location: SubstituterLocation,
	uri: string,
	dependencies: SubstituterEnvironment
): Promise<CacheInfoOutcome> {
	// A local store publishes nothing about itself, so it stands on the
	// compiled-in defaults: priority zero, and unwilling to answer a batch.
	if (location.kind === 'local-store') {
		return {
			kind: 'described',
			description: parseCacheInfo('', location.directories.storeDirectory)
		};
	}

	const servedBy = queriedStoreDirectory(dependencies);

	const asked = await readDocument(location, uri, cacheInfoFile, dependencies);

	// A cache serving no `nix-cache-info` states nothing about itself, which is
	// what an empty document states too. Nix opens a directory cache by writing
	// the document into it and carries on with the defaults; over HTTP it
	// reports a cache as not being a binary cache, since the upload it attempts
	// there is refused by anything serving reads alone.
	if (asked.kind === 'absent') {
		return location.kind === 'file'
			? { kind: 'described', description: parseCacheInfo('', servedBy) }
			: { kind: 'unreachable', reason: 'no-cache-info' };
	}

	if (asked.kind === 'failed') {
		return { kind: 'unreachable', reason: reasonFor(asked.error) };
	}

	try {
		return {
			kind: 'described',
			description: parseCacheInfo(asked.document, servedBy)
		};
	} catch {
		return { kind: 'unreachable', reason: 'no-cache-info' };
	}
}

/** What a substituter's own document made of it. */
type CacheInfoOutcome =
	| { readonly kind: 'described'; readonly description: SubstituterDescription }
	| {
			readonly kind: 'unreachable';
			readonly reason: 'no-cache-info' | 'needs-credentials';
	  };

/**
 * Which of a cache's own answers this was. A cache asking to be identified, and
 * a proxy asking the same before it will carry the request, are both a
 * credential this run does not hold, which reads differently from a cache that
 * said nothing a reader could use.
 */
function reasonFor(
	failure: SubstituterFailure
): 'no-cache-info' | 'needs-credentials' {
	return failure instanceof SubstituterUnreachableError &&
		credentialStatuses.has(failure.status ?? 0)
		? 'needs-credentials'
		: 'no-cache-info';
}

/**
 * The statuses that name a credential rather than an answer about the path. A
 * cache answers 401 when it wants the reader identified and a proxy answers 407
 * when it wants the same before carrying the request; Nix reads both as being
 * unauthorised, and neither is worth attempting again with what this run holds.
 */
const credentialStatuses = new Set([401, 407]);

/**
 * What a store URI's own parameters say about the substituter, which stand
 * whatever its `nix-cache-info` goes on to say.
 */
function configuredDescription(query: string): Partial<SubstituterDescription> {
	const parameters = storeUriParameters(query);
	const priority = parameters.get('priority');
	const massQuery = parameters.get('want-mass-query');
	const trusted = parameters.get('trusted');

	return {
		...(priority !== undefined && { priority: settingPriority(priority) }),
		...(massQuery !== undefined && {
			hasMassQuery: isEnabledSettingValue('want-mass-query', massQuery)
		}),
		...(trusted !== undefined && {
			isTrusted: isEnabledSettingValue('trusted', trusted)
		})
	};
}

/**
 * A `priority` parameter's value, read the way Nix reads an integer setting:
 * an optional binary unit multiplying what comes before it, and before that a
 * signed decimal number the width Nix declared the setting with can hold.
 * Nothing else states a priority, so digits with anything after them, a
 * fraction, another base, and a number too wide for the setting all leave the
 * URI naming one this reader will not invent.
 */
function settingPriority(value: string): number {
	const suffix = value.slice(-1);
	const multiplier = binaryUnits.get(suffix.toUpperCase());
	const number = multiplier === undefined ? value : value.slice(0, -1);

	if (
		(multiplier === undefined && /^\p{Letter}$/u.test(suffix)) ||
		!/^[+-]?\d+$/u.test(number)
	) {
		throw new NixConfigSettingError('priority', value, priorityExpectation);
	}

	const parsed = Number(number);

	if (parsed < minPriority || parsed > maxPriority) {
		throw new NixConfigSettingError('priority', value, priorityExpectation);
	}

	return parsed * (multiplier ?? 1);
}

// The units Nix multiplies an integer setting by, named by the letter each
// value may end with.
const binaryUnits: ReadonlyMap<string, number> = new Map([
	['K', 1024],
	['M', 1024 ** 2],
	['G', 1024 ** 3],
	['T', 1024 ** 4]
]);

// Nix declares the priority as a signed 32-bit setting, and reads the number
// into that width before any unit multiplies it.
const minPriority = -(2 ** 31);
const maxPriority = 2 ** 31 - 1;

const priorityExpectation =
	'a 32-bit integer, optionally followed by K, M, G or T';

// Nix reads the document line by line and applies its own default to every
// field the document leaves out, so a cache publishing a partial one is
// usable.
function parseCacheInfo(
	source: string,
	servedBy: StoreDirectory
): SubstituterDescription {
	let storeDirectory = servedBy;
	let hasMassQuery = false;
	let priority = defaultPriority;
	// Nothing in the document says a cache is trusted: only the store URI
	// that named it can.
	const isTrusted = false;

	for (const line of source.split(/\r?\n/u)) {
		const separator = line.indexOf(':');

		if (separator <= 0) {
			continue;
		}

		const name = line.slice(0, separator).trim();
		const value = line.slice(separator + 1).trim();

		if (name === 'StoreDir') {
			storeDirectory = storeDirectorySchema.parse(value);
			continue;
		}

		if (name === 'WantMassQuery') {
			hasMassQuery = value === '1';
			continue;
		}

		if (name === 'Priority') {
			priority = leadingInteger(value) ?? priority;
		}
	}

	return { storeDirectory, hasMassQuery, priority, isTrusted };
}
