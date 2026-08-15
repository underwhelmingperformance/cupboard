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
import { nixIntegerOfWidth } from './setting-types.ts';
import {
	defaultFileTransferSettings,
	isEnabledSettingValue,
	type NixFileTransferSettings
} from './store-config.ts';

/**
 * Maximum number of bytes read from a substituter response. A narinfo and
 * `nix-cache-info` are both a few hundred bytes, so this is far above any
 * real response and this limit bounds memory use.
 */
export const maxSubstituterAnswerByteLength = 1024 * 1024;

/**
 * Maximum concurrent requests when the configuration specifies no limit. A
 * closure query could otherwise open one connection per path.
 */
export const maxSubstituterConcurrency = 64;

/**
 * Maximum delay before retrying a substituter. If `Retry-After` exceeds this
 * limit, the query reports the substituter as unreachable instead of retrying
 * before the requested time.
 */
export const maxRetryWaitMs = 60_000;

// When a server rate-limits this client, or reports that it is overloaded, the
// client waits the longer delay before retrying.
const rateLimitedStatuses = new Set([429, 503]);

/**
 * Statuses for failures that may succeed on a later attempt: request timeouts,
 * rate limits and transient server failures.
 */
function isTransientStatus(status: number): boolean {
	if (status === 408 || status === 429) {
		return true;
	}

	// Exclude permanent protocol responses such as 501, 505 and 511.
	return status >= 500 && ![501, 505, 511].includes(status);
}

/** The default for a substituter that advertises no priority. */
const defaultPriority = 0;

const cacheInfoFile = 'nix-cache-info';
const servedStoreDirectory = storeDirectorySchema.parse('/nix/store');

// Request settings, with Nix's compiled-in defaults.
function transferSettings(
	dependencies: SubstituterEnvironment
): NixFileTransferSettings {
	return dependencies.transfer ?? defaultFileTransferSettings;
}

// The requested store directory, also used when a substituter does not
// advertise one.
function queriedStoreDirectory(
	dependencies: SubstituterEnvironment
): StoreDirectory {
	return dependencies.storeDirectory ?? servedStoreDirectory;
}

// `http-connections` reads zero as no limit, which still needs a bound here:
// a query over a whole closure would otherwise open a connection per path.
function requestConcurrency(dependencies: SubstituterEnvironment): number {
	const { httpConnections } = transferSettings(dependencies);

	return httpConnections === 0 ? maxSubstituterConcurrency : httpConnections;
}

/** A substituter that could not respond to a query. */
export class SubstituterUnreachableError extends NixStoreError {
	/** The delay requested by the substituter, if provided. */
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

/** A substituter that returned a malformed response. */
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
 * A substituter's advertised `nix-cache-info`. Missing fields use Nix's
 * compiled-in defaults, so a document containing only its store directory has
 * priority zero and disables mass queries.
 */
export interface SubstituterDescription {
	/** The store directory this substituter serves paths for. */
	readonly storeDirectory: StoreDirectory;
	/**
	 * Whether the substituter accepts batch availability queries.
	 */
	readonly hasMassQuery: boolean;
	/** Query priority. Lower-numbered substituters are queried first. */
	readonly priority: number;
	/**
	 * Whether paths from this substituter may be accepted without a signature.
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
			 * A local Nix store. Local stores publish neither `nix-cache-info` nor
			 * narinfos, so availability is read from the store database.
			 */
			readonly kind: 'local-store';
			readonly directories: LocalStoreDirectories;
	  }
	| {
			readonly kind: 'http';
			readonly baseUrl: URL;
			/**
			 * Credentials supplied by the store URI or netrc.
			 */
			readonly credential?: BasicCredential;
	  }
	| { readonly kind: 'file'; readonly directory: string };

/** A configured substituter ready to query. */
export interface Substituter extends SubstituterDescription {
	/** The configured URI used to identify the substituter in errors. */
	readonly uri: string;
	/** Where each of its documents is read from. */
	readonly location: SubstituterLocation;
}

export interface SubstituterEnvironment {
	readonly fetch?: typeof fetch;
	readonly signal?: AbortSignal;
	/**
	 * Retry settings from the effective Nix configuration.
	 */
	readonly transfer?: NixFileTransferSettings;
	/** Retry delay implementation, injected to avoid waiting in tests. */
	readonly delay?: (
		milliseconds: number,
		signal: AbortSignal | undefined
	) => Promise<void>;
	/**
	 * Jitter source in the range zero to one, injected for deterministic tests.
	 */
	readonly spread?: () => number;
	/**
	 * The store directory used when `nix-cache-info` does not specify one.
	 */
	readonly storeDirectory?: StoreDirectory;
	/**
	 * The state directory for a local store that does not specify its own root.
	 */
	readonly stateDirectory?: string;
	/** Opens a local store database, injected for tests. */
	readonly openStore?: (stateDirectory: string) => NixStoreDatabase;
	/**
	 * Parsed netrc credentials. Requests use the credentials for their host.
	 */
	readonly netrc?: string;
}

/** The reachable and unreachable configured substituters. */
export interface OpenedSubstituters {
	/**
	 * Ordered the way Nix orders them: by ascending priority, ties keeping
	 * configured order.
	 */
	readonly substituters: readonly Substituter[];
	readonly unreachable: readonly UnreachableSubstituter[];
}

/**
 * Opens each configured substituter. Substituters with unreadable metadata or
 * a different store directory are reported as unreachable and excluded from
 * later queries.
 *
 * Duplicate URIs are opened and queried once, matching the resolved Nix
 * configuration.
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

			// Store URI parameters override values advertised by the document.
			const substituter = {
				uri,
				location,
				...described.description,
				...configured
			};
			const queried = queriedStoreDirectory(dependencies);

			// Report caches for a different store directory as unreachable instead
			// of silently omitting them.
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

// The result of opening one configured substituter.
type OpenOutcome =
	| { readonly opened: true; readonly substituter: Substituter }
	| { readonly opened: false; readonly unreachable: UnreachableSubstituter };

/**
 * Open substituters, or a lazy operation that opens them on the first query.
 */
export type SubstituterSource =
	readonly Substituter[] | (() => Promise<OpenedSubstituters>);

/** Store-wide settings used by substituter queries. */
export interface SubstituterClientOptions extends SubstituterEnvironment {
	/** The store directory for which availability is being queried. */
	readonly storeDirectory: StoreDirectory;
	/** The `substitute` setting. When disabled, no paths are substitutable. */
	readonly substitute: boolean;
	/**
	 * The `fallback` setting. By default, a failed substituter makes the result
	 * incomplete and raises an error. When fallback is enabled, queries continue
	 * with the remaining substituters, matching Nix.
	 */
	readonly fallback: boolean;
}

/**
 * Queries a store's substituters directly when no daemon manages the
 * substituter configuration.
 *
 * Every result comes from the substituter itself. Nix keeps a database of the
 * narinfos it has read and reuses an entry for as long as
 * `narinfo-cache-positive-ttl` or `narinfo-cache-negative-ttl` allows, so a
 * cached positive result can be a month old and a cached negative result an
 * hour old. This client does not cache narinfos, so each query observes current
 * substituter state.
 *
 * Planning decides which targets to publish and which to leave for consumers to
 * fetch, so it needs current results. A cached absence would make it publish a
 * path that is already available, and a cached presence would make it leave a
 * target on a substituter that no longer has it. The cost is one request per
 * path per run.
 */
export class SubstituterClient {
	private opening?: Promise<OpenedSubstituters>;

	constructor(
		private readonly source: SubstituterSource,
		private readonly options: SubstituterClientOptions
	) {}

	// Opening a substituter reads its `nix-cache-info`. Open configured URIs on
	// the first query and reuse them for later queries.
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

	// Nix queries substituters in order and uses the first offer.
	private async firstOffer(
		storePath: StorePathString
	): Promise<NixSubstituterOffer | undefined> {
		let failure: SubstituterUnreachableError | undefined;
		const substituters = await this.opened();

		for (const substituter of substituters) {
			if (!this.serves(substituter)) {
				continue;
			}

			// A later successful response supersedes an earlier failure.
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

	// If no substituter returns a result, report the final failure.
	private raiseIfLastFailed(failure: SubstituterFailure | undefined): void {
		if (failure !== undefined && !this.options.fallback) {
			throw failure;
		}
	}

	// Query only substituters that serve the requested store directory.
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

			// A narinfo for a different path does not satisfy this query.
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
	 * Reads a path offer from a local store database. A local store does not
	 * publish a transfer size, so the download size is zero and the NAR size
	 * comes from the database.
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

	// Preserve the caller's abort reason instead of replacing it with a
	// substituter failure.
	private raiseIfAbandoned(): void {
		this.options.signal?.throwIfAborted();
	}

	/**
	 * The configured substituters that this client could not query. This list is
	 * empty until the first query opens the configured substituters.
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
	 * the others have disabled batch queries. Each substituter receives only the
	 * paths not offered by a higher-priority substituter.
	 *
	 * Each path uses the same narinfo lookup as a single-path query. Nix
	 * implements its mass query through the same path-info operation.
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

		for (const substituter of substituters) {
			if (remaining.length === 0) {
				break;
			}

			if (!substituter.hasMassQuery || !this.serves(substituter)) {
				continue;
			}

			const answers = await mapWithConcurrency(
				remaining,
				requestConcurrency(this.options),
				(storePath) => this.offerFor(substituter, storePath)
			);

			for (const [index, storePath] of remaining.entries()) {
				const answer = answers[index];

				// Nix calls this substituter's mass query as one operation. A
				// failure escapes that operation directly: `fallback` belongs to
				// realising/building after a substitute fails, not to this query.
				if (answer?.kind === 'failed') {
					throw answer.error;
				}

				if (answer?.kind === 'held') {
					found.add(storePath);
				}
			}

			remaining = remaining.filter((storePath) => !found.has(storePath));
		}

		return [...found].toSorted(byCodeUnit);
	}

	/**
	 * The offer from the first substituter that has each path, sorted by store
	 * path. Paths with no offer are omitted. Priority order matches the
	 * substituter Nix would fetch from.
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

/** The result from one substituter for one path. */
type SubstituterOffer = NarInfoOffer & {
	readonly fromTrustedSubstituter: boolean;
};

/** A substituter that failed before reporting whether it has a path. */
type SubstituterFailure =
	SubstituterUnreachableError | SubstituterAnswerUnreadableError;

/**
 * The result from one substituter for one path: an offer, an absence or a
 * failure. A later substituter may still provide the path after a failure.
 */
type SubstituterAnswer =
	| { readonly kind: 'held'; readonly offer: SubstituterOffer }
	| { readonly kind: 'absent' }
	| { readonly kind: 'failed'; readonly error: SubstituterFailure };

/**
 * Statuses that indicate a substituter does not have a path. A missing object
 * returns 404, a bucket that will not list its contents returns 403 for an
 * object it does not have, and a bucket that once had a path may return 410, so
 * Nix treats all three as an absence.
 */
const absentStatuses = new Set([403, 404, 410]);

/** The complete result of one request attempt. */
type DocumentOutcome =
	| { readonly kind: 'answered'; readonly document: string }
	| { readonly kind: 'absent' }
	| { readonly kind: 'failed'; readonly error: SubstituterFailure };

/**
 * Reads one substituter document and retries transient connection, transfer,
 * timeout, rate-limit and server failures. Permanent HTTP responses and
 * oversized bodies are not retried.
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

				// The server will return the same oversized document on a retry.
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
 * Waits before the next attempt and reports whether to retry. Jitter prevents
 * clients from retrying in lockstep, and `Retry-After` supplies a minimum
 * delay. Overload and rate-limit responses use the longer backoff.
 *
 * The operation stops retrying if the server's requested delay exceeds the
 * maximum wait.
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
 * The delay before the next transfer attempt, or `undefined` when
 * `Retry-After` exceeds {@link maxRetryWaitMs}.
 *
 * The backoff doubles with each attempt up to `filetransfer-retry-max-delay`,
 * and `Retry-After` is a hard minimum that the ceiling does not cap. With
 * jitter enabled, the delay falls between the minimum and the minimum plus the
 * backoff.
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
	const minimumDelayMs = retryAfterMs ?? 0;

	if (minimumDelayMs > maxRetryWaitMs) {
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
		? minimumDelayMs + Math.round(spread() * backoff)
		: Math.max(minimumDelayMs, backoff);
}

/**
 * Parses `Retry-After` as either seconds or an HTTP date. Returns `undefined`
 * when the header is absent or malformed, allowing the normal backoff to apply.
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
 * Parses a `Retry-After` delay consisting only of decimal digits. Nix reads the
 * entire value as an unsigned 32-bit count, so signs, fractions, suffixes and
 * wider values are invalid.
 */
function delaySeconds(value: string): number | undefined {
	if (!/^\d+$/u.test(value)) {
		return;
	}

	const seconds = Number(value);

	return seconds <= maxDelaySeconds ? seconds : undefined;
}

// Nix stores a `Retry-After` delay in an unsigned 32-bit field.
const maxDelaySeconds = 2 ** 32 - 1;

// Preserve an explicit abort reason. Otherwise use the standard abort error.
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
		// must be handled immediately.
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

/** Cancels an unread response body so its connection can be reused promptly. */
async function discard(response: Response): Promise<void> {
	await response.body?.cancel();
}

/** A substituter response that exceeds the configured size limit. */
class OversizedSubstituterAnswerError extends NixStoreError {
	constructor(public readonly maxByteLength: number) {
		super(
			`A substituter answered with more than ${String(maxByteLength)} bytes`
		);
		this.name = 'OversizedSubstituterAnswerError';
	}
}

// `BinaryCacheStore::init()` gives the advertised value to `std::stoi`: leading
// whitespace and either sign are accepted, conversion stops after the decimal
// digits, and a missing or out-of-range integer refuses the cache info.
function cacheInfoPriority(value: string): number {
	const digits = /^\s*([+-]?\d+)/u.exec(value);
	const parsed = digits === null ? undefined : Number(digits[1]);

	if (
		parsed === undefined ||
		!Number.isSafeInteger(parsed) ||
		parsed < minPriority ||
		parsed > maxPriority
	) {
		throw new NixConfigSettingError(
			'Priority',
			value,
			'a signed 32-bit integer prefix'
		);
	}

	return parsed;
}

/**
 * Reads a file as text, refusing a file larger than `maxByteLength`. A
 * directory substituter serves its documents from disk, and the caller passes
 * `maxSubstituterAnswerByteLength`, so the same bound applies to a file and to
 * a response.
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
 * Reads a response body as text while enforcing the size limit on each chunk.
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
 * Combines the caller's abort signal with a per-request timeout so an
 * unresponsive substituter cannot leave the query open indefinitely.
 */
function requestSignal(
	timeoutMs: number,
	signal: AbortSignal | undefined
): AbortSignal {
	const deadline = AbortSignal.timeout(timeoutMs);

	return signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
}

/**
 * Opens a substituter store URI for an HTTP cache, directory cache or local
 * store. Other schemes are reported as unsupported so callers know the query
 * is incomplete.
 *
 * Preserve the original local-store URI because Nix accepts both the bare
 * store type and the URI scheme, and a bare type with parameters is not a URL.
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

// Store URI parameters override the corresponding settings. Reject parameter
// values that the setting type cannot parse.
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

// Parse a local-store substituter. A URI without its own root uses the
// directories from the effective configuration.
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

// The default state directory for a local store.
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
 * Credentials for a cache. The store URI takes precedence over netrc
 * credentials for the host.
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
 * Removes store configuration and credentials from the base URL. Credentials
 * are sent in a header rather than embedded in request URLs.
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
 * Reads one document from an HTTP or directory cache. A missing file reports
 * an absence; other filesystem errors report an unreachable substituter.
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

// Only ENOENT means the cache does not contain a document. Other filesystem
// errors make the directory substituter unreachable.
const absentFileErrorCode = 'ENOENT';

function errorCodeOf(error: unknown): string {
	return error instanceof Error && 'code' in error
		? String(error.code)
		: 'unknown';
}

/**
 * Reads a substituter's `nix-cache-info`. HTTP requests use the normal retry
 * policy so a transient failure at startup does not exclude the cache.
 *
 * Malformed or oversized metadata makes the substituter unreachable.
 */
async function describeSubstituter(
	location: SubstituterLocation,
	uri: string,
	dependencies: SubstituterEnvironment
): Promise<CacheInfoOutcome> {
	// Local stores publish no cache metadata and use the compiled-in defaults.
	if (location.kind === 'local-store') {
		return {
			kind: 'described',
			description: parseCacheInfo('', location.directories.storeDirectory)
		};
	}

	const servedBy = queriedStoreDirectory(dependencies);

	const asked = await readDocument(location, uri, cacheInfoFile, dependencies);

	// A missing `nix-cache-info` is equivalent to an empty document. Nix writes
	// the file with the compiled-in defaults when it opens a directory cache;
	// over HTTP a cache that serves reads alone refuses that write, so Nix
	// reports that the URL is not a binary cache.
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

/** Metadata parsed from a substituter's own document. */
type CacheInfoOutcome =
	| { readonly kind: 'described'; readonly description: SubstituterDescription }
	| {
			readonly kind: 'unreachable';
			readonly reason: 'no-cache-info' | 'needs-credentials';
	  };

/**
 * Classification of a cache metadata response. Authentication failures are
 * distinct from missing or malformed metadata.
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
 * Authentication statuses. A cache returns 401 and a proxy returns 407; Nix
 * treats both as unauthorised and does not retry with unchanged credentials.
 */
const credentialStatuses = new Set([401, 407]);

/**
 * Substituter settings from the store URI, which override `nix-cache-info`.
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
 * Parses a `priority` parameter using Nix's integer-setting rules:
 * an optional binary unit multiplying what comes before it, and before that a
 * signed decimal number within the setting's declared width. Suffixes,
 * fractions, other bases and out-of-range values are invalid.
 */
function settingPriority(value: string): number {
	const priority = nixIntegerOfWidth(value, 'int32');

	if (priority === undefined) {
		throw new NixConfigSettingError('priority', value, priorityExpectation);
	}

	return Number(priority);
}

const priorityExpectation =
	'a 32-bit integer, optionally followed by K, M, G or T';

const minPriority = -(2 ** 31);
const maxPriority = 2 ** 31 - 1;

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
	// Trust is configured only by the store URI, not `nix-cache-info`.
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
			priority = cacheInfoPriority(value);
		}
	}

	return { storeDirectory, hasMassQuery, priority, isTrusted };
}
