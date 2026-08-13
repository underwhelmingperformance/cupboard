import { open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	referencesSchema,
	type StoreDirectory,
	storeDirectorySchema,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { byCodeUnit, StorePath } from '@cupboard/nix-store/store-path';
import { canonicalHref } from '@cupboard/nix-store/url';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';

import {
	NixStoreError,
	type NixSubstituterOffer,
	type UnreachableSubstituter
} from './nix-store.ts';
import {
	defaultFileTransferSettings,
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
	| { readonly kind: 'http'; readonly baseUrl: URL }
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
 * Opens each configured substituter. One that cannot describe itself is left
 * out, since a substituter that cannot answer for its own `nix-cache-info`
 * cannot be asked about paths either, and it is named among the unreachable:
 * every later answer is missing whatever it held.
 */
export async function openSubstituters(
	uris: readonly string[],
	dependencies: SubstituterEnvironment = {}
): Promise<OpenedSubstituters> {
	const opened = await mapWithConcurrency(
		[...new Set(uris)],
		requestConcurrency(dependencies),
		async (uri): Promise<OpenOutcome> => {
			const parsed = substituterConfiguration(uri);

			if (!parsed.opened) {
				return { ...parsed, uri };
			}

			const { location, configured } = parsed;
			const described = await describeSubstituter(location, uri, dependencies);

			// A store URI's own parameters settle what they name, and the
			// document fills in the rest.
			return described === undefined
				? { opened: false, uri, reason: 'no-cache-info' }
				: {
						opened: true,
						substituter: { uri, location, ...described, ...configured }
					};
		}
	);
	const substituters: Substituter[] = [];
	const unreachable: UnreachableSubstituter[] = [];

	for (const outcome of opened) {
		if (outcome.opened) {
			substituters.push(outcome.substituter);
		} else {
			unreachable.push({ uri: outcome.uri, reason: outcome.reason });
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
	| ({ readonly opened: false } & UnreachableSubstituter);

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

	private serves(substituter: Substituter): boolean {
		return substituter.storeDirectory === this.options.storeDirectory;
	}

	private async offerFor(
		substituter: Substituter,
		storePath: StorePathString
	): Promise<SubstituterAnswer> {
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
type SubstituterOffer = Omit<NixSubstituterOffer, 'storePath'>;

/** What one narinfo states, before the substituter serving it is named. */
type NarInfoOffer = Omit<SubstituterOffer, 'fromTrustedSubstituter'>;

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
				)
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

// A server asking for a wait states it in seconds, or as the moment to come
// back at.
function retryAfterMilliseconds(response: Response): number | undefined {
	const asked = response.headers.get('retry-after');

	if (asked === null) {
		return;
	}

	const seconds = leadingInteger(asked);

	if (seconds !== undefined) {
		return Math.max(0, seconds) * 1000;
	}

	const moment = Date.parse(asked);

	return Number.isNaN(moment) ? undefined : Math.max(0, moment - Date.now());
}

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

/**
 * A narinfo missing what Nix requires of one. Nix reads such a document as a
 * corrupt answer, so nothing here is read out of it either.
 */
class CorruptNarInfoError extends NixStoreError {
	constructor(public readonly storePath: StorePathString) {
		super(`The narinfo served for ${storePath} is missing required fields`);
		this.name = 'CorruptNarInfoError';
	}
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

/** A narinfo that describes a path other than the one it was asked for. */
class MismatchedNarInfoPathError extends NixStoreError {
	constructor(public readonly storePath: StorePathString) {
		super(`The narinfo served does not describe ${storePath}`);
		this.name = 'MismatchedNarInfoPathError';
	}
}

// The literal a cache serves for a path whose deriver it does not know.
// cache.nixos.org carries it on many older paths, and Nix reads it as an
// absent deriver.
const unknownDeriver = 'unknown-deriver';

// A served narinfo names the deriver and every reference by basename, while a
// substitutable-path answer names them the way the store does. A narinfo is
// read whatever compression it names, and a document missing what Nix
// requires of one is refused as corrupt, the way Nix refuses it.
function offerFromNarInfo(
	source: string,
	storePath: StorePathString,
	storeDirectory: StoreDirectory
): NarInfoOffer {
	const read = new NarInfoReader(source, storePath, storeDirectory);

	return read.offer();
}

/**
 * Reads a narinfo the way Nix reads one from a substituter. Nix accepts a
 * document only when it can read
 * every field it carries, so a value this reader let through is a value Nix
 * would refuse the whole document over: a path counted as available on the
 * strength of one is a path Nix would decline to fetch.
 *
 * A field's value starts two characters past its colon, and every line ends
 * with a newline, both of which Nix requires exactly.
 */
class NarInfoReader {
	private references?: readonly StorePathString[];

	private deriver?: StorePathString;

	private url = '';

	private narSize = 0;

	private downloadSize = 0;

	private hasPath = false;

	private narHash?: NixSha256Hash;

	// A narinfo carries one `Sig` line per key that signed the path.
	private readonly signatures: string[] = [];

	constructor(
		private readonly source: string,
		private readonly storePath: StorePathString,
		private readonly storeDirectory: StoreDirectory
	) {}

	private readLines(): void {
		let position = 0;

		while (position < this.source.length) {
			const colon = this.source.indexOf(':', position);

			if (colon === -1) {
				throw new CorruptNarInfoError(this.storePath);
			}

			const end = this.source.indexOf('\n', colon + 2);

			if (end === -1) {
				throw new CorruptNarInfoError(this.storePath);
			}

			this.readField(
				this.source.slice(position, colon),
				this.source.slice(colon + 2, end)
			);
			position = end + 1;
		}
	}

	private readField(name: string, value: string): void {
		if (name === 'StorePath') {
			// The answer stands for the path it was asked about. A substituter
			// naming another describes something the caller did not ask for.
			if (value !== this.storePath) {
				throw new MismatchedNarInfoPathError(this.storePath);
			}

			this.hasPath = true;

			return;
		}

		if (name === 'URL') {
			this.url = value;

			return;
		}

		this.readMeasuredField(name, value);
	}

	private readMeasuredField(name: string, value: string): void {
		if (name === 'Compression') {
			// An empty value is the one Nix reads as its own default.
			if (value !== '' && !compressionAlgorithms.has(value)) {
				throw new CorruptNarInfoError(this.storePath);
			}

			return;
		}

		if (name === 'FileHash' || name === 'NarHash') {
			this.readHash(name, value);

			return;
		}

		if (name === 'FileSize' || name === 'NarSize') {
			this.readSize(name, value);

			return;
		}

		this.readNamedField(name, value);
	}

	private readNamedField(name: string, value: string): void {
		if (name === 'References') {
			// Nix separates them with single spaces, so anything else lands
			// inside a name and stops it being one.
			if (this.references !== undefined) {
				throw new CorruptNarInfoError(this.storePath);
			}

			this.references = referencesSchema
				.parse(value.split(' ').filter(Boolean))
				.map((basename) => this.inStore(basename));

			return;
		}

		if (name === 'Deriver') {
			// The literal a cache serves for a path whose deriver it does not
			// know, which Nix reads as no deriver.
			this.deriver = value === unknownDeriver ? undefined : this.inStore(value);

			return;
		}

		if (name === 'Sig') {
			if (!signaturePattern.test(value)) {
				throw new CorruptNarInfoError(this.storePath);
			}

			this.signatures.push(value);

			return;
		}

		if (name === 'CA' && value !== '' && !contentAddressPattern.test(value)) {
			throw new CorruptNarInfoError(this.storePath);
		}
	}

	// Nix reads a hash field as an algorithm and a digest, in any of the
	// spellings it writes them in, and refuses the document when it cannot.
	// A NAR hash is kept when it is sha256, the algorithm a store path's own
	// hash uses and so the only one an offer can be compared under; a document
	// naming any other algorithm states a hash this reader has no offer to
	// make from.
	private readHash(name: string, value: string): void {
		if (!isHashField(value)) {
			throw new CorruptNarInfoError(this.storePath);
		}

		if (name !== 'NarHash') {
			return;
		}

		this.narHash = sha256Of(value);
	}

	private readSize(name: string, value: string): void {
		if (!/^\d+$/u.test(value)) {
			throw new CorruptNarInfoError(this.storePath);
		}

		const parsed = Number(value);

		if (!Number.isSafeInteger(parsed)) {
			throw new CorruptNarInfoError(this.storePath);
		}

		if (name === 'NarSize') {
			this.narSize = parsed;
		} else {
			this.downloadSize = parsed;
		}
	}

	private inStore(basename: string): StorePathString {
		const named = storePathSchema.safeParse(
			`${this.storeDirectory}/${basename}`
		);

		if (!named.success) {
			throw new CorruptNarInfoError(this.storePath);
		}

		return named.data;
	}

	offer(): NarInfoOffer {
		this.readLines();

		const narHash = this.narHash;

		// Nix reads a document missing any of these as one the substituter did
		// not finish writing.
		if (
			narHash === undefined ||
			!this.hasPath ||
			this.url === '' ||
			this.narSize === 0
		) {
			throw new CorruptNarInfoError(this.storePath);
		}

		return {
			source: 'substituter',
			references: this.references ?? [],
			...(this.deriver !== undefined && { deriver: this.deriver }),
			narHash,
			signatures: [...this.signatures],
			downloadSize: this.downloadSize,
			narSize: this.narSize
		};
	}
}

// The compression a narinfo may name, which Nix reads by the same list.
const compressionAlgorithms = new Set([
	'none',
	'br',
	'bzip2',
	'compress',
	'grzip',
	'gzip',
	'lrzip',
	'lz4',
	'lzip',
	'lzma',
	'lzop',
	'xz',
	'zstd'
]);

// `<algorithm>:<digest>`, the digest written base16, base32 or base64.
// The digest sizes, in bytes, of the algorithms a hash field may name.
const hashDigestBytes = new Map([
	['md5', 16],
	['sha1', 20],
	['sha256', 32],
	['sha512', 64]
]);

const hashFieldPattern = /^([\da-z]+)([:-])([\d+/A-Za-z]+={0,2})$/u;

/**
 * Whether the value names an algorithm and a digest that algorithm writes.
 * Nix takes the algorithm from before the separator and reads the digest by
 * its length, so a digest of any other length is one it cannot read.
 */
function isHashField(value: string): boolean {
	const named = hashFieldPattern.exec(value);

	if (named === null) {
		return false;
	}

	const [, algorithm, separator, digest] = named;

	if (algorithm === undefined || digest === undefined) {
		return false;
	}

	const bytes = hashDigestBytes.get(algorithm);

	if (bytes === undefined) {
		return false;
	}

	// A dash names the SRI spelling, which is always base64.
	return separator === '-'
		? digest.length === base64Length(bytes)
		: [2 * bytes, base32Length(bytes), base64Length(bytes)].includes(
				digest.length
			);
}

// The sha256 spellings a narinfo writes, read as a hash. A field naming any
// other algorithm is one no store path's NAR hash can be compared under, and
// the SRI spelling separates the algorithm from its base64 digest with a dash.
function sha256Of(value: string): NixSha256Hash | undefined {
	const prefixed = value.startsWith('sha256-')
		? `sha256:${value.slice('sha256-'.length)}`
		: value;

	if (!prefixed.startsWith('sha256:')) {
		return;
	}

	return NixSha256Hash.parsePrefixed(prefixed);
}

function base32Length(bytes: number): number {
	return Math.ceil((bytes * 8) / 5);
}

function base64Length(bytes: number): number {
	return 4 * Math.ceil(bytes / 3);
}

// A signature names the key that made it and carries the signature itself.
const signaturePattern = /^[^\s:]+:[\d+/A-Za-z]+={0,2}$/u;

// A content address names how it was made before the hash it is.
const contentAddressPattern = /^[\d:A-Za-z-]+$/u;

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
 * A substituter is configured as a store URI. A binary cache served over HTTP
 * and one held in a directory are both read here; any other scheme names a
 * store this reader does not open, and it is reported as such so a caller
 * knows its answers are missing whatever that store holds.
 */
function substituterConfiguration(uri: string): ConfigurationOutcome {
	let parsed: URL;

	try {
		parsed = new URL(uri);
	} catch {
		return { opened: false, reason: 'unreadable-uri' };
	}

	const location = substituterLocation(parsed);

	if (location === undefined) {
		return { opened: false, reason: 'unsupported-scheme' };
	}

	return { opened: true, location, configured: configuredDescription(parsed) };
}

type ConfigurationOutcome =
	| {
			readonly opened: true;
			readonly location: SubstituterLocation;
			readonly configured: Partial<SubstituterDescription>;
	  }
	| {
			readonly opened: false;
			readonly reason: UnreachableSubstituter['reason'];
	  };

function substituterLocation(parsed: URL): SubstituterLocation | undefined {
	if (parsed.protocol === 'file:') {
		return {
			kind: 'file',
			directory: fileURLToPath(withoutParameters(parsed))
		};
	}

	return parsed.protocol === 'http:' || parsed.protocol === 'https:'
		? { kind: 'http', baseUrl: withoutParameters(parsed) }
		: undefined;
}

// A store URI's parameters configure the store, so the base every document is
// read under is the URI without them.
function withoutParameters(parsed: URL): URL {
	const base = new URL(parsed);
	base.search = '';
	base.hash = '';

	return base;
}

/**
 * Reads one document from a substituter. An HTTP cache is asked for it, and a
 * directory is read: a file that is not there is the directory's way of saying
 * it holds nothing, and anything else that stops the read is the substituter
 * failing to answer.
 */
async function readDocument(
	location: SubstituterLocation,
	uri: string,
	documentPath: string,
	dependencies: SubstituterEnvironment
): Promise<DocumentOutcome> {
	if (location.kind === 'http') {
		return fetchDocument(
			new URL(`${canonicalHref(location.baseUrl)}/${documentPath}`),
			uri,
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

		return absentFileErrorCodes.has(errorCodeOf(error))
			? { kind: 'absent' }
			: {
					kind: 'failed',
					error: new SubstituterUnreachableError(uri, undefined, {
						cause: error
					})
				};
	}
}

// What a filesystem reports for a document a directory does not hold, whether
// because the file is absent or because a component of its path is not a
// directory at all.
const absentFileErrorCodes = new Set(['ENOENT', 'ENOTDIR', 'EISDIR']);

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
 * A substituter that cannot say which store it serves, says something
 * unreadable, or says more than an answer can hold cannot be asked about that
 * store's paths.
 */
async function describeSubstituter(
	location: SubstituterLocation,
	uri: string,
	dependencies: SubstituterEnvironment
): Promise<SubstituterDescription | undefined> {
	const asked = await readDocument(location, uri, cacheInfoFile, dependencies);

	if (asked.kind !== 'answered') {
		return;
	}

	try {
		return parseCacheInfo(
			asked.document,
			dependencies.storeDirectory ?? servedStoreDirectory
		);
	} catch {
		return;
	}
}

/**
 * What a store URI's own parameters say about the substituter, which stand
 * whatever its `nix-cache-info` goes on to say.
 */
function configuredDescription(url: URL): Partial<SubstituterDescription> {
	const priority = configuredPriority(url);
	const massQuery = url.searchParams.get('want-mass-query');
	const trusted = url.searchParams.get('trusted');

	return {
		...(priority !== undefined && { priority }),
		...(massQuery !== null && { hasMassQuery: massQuery === '1' }),
		...(trusted !== null && { isTrusted: trusted === '1' })
	};
}

// The `?priority=` parameter a store URI may carry, which settles the priority
// whatever the substituter advertises.
function configuredPriority(url: URL): number | undefined {
	const configured = url.searchParams.get('priority');

	return configured === null ? undefined : leadingInteger(configured);
}

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
