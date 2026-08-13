import { parseFields } from '@cupboard/nix-store/narinfo';
import {
	type StoreDirectory,
	storeDirectorySchema,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { canonicalHref } from '@cupboard/nix-store/url';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';

import { NixStoreError, type NixSubstitutablePathInfo } from './nix-store.ts';

/**
 * How many paths a substituter is asked about at once. Each question is one
 * request, so the bound is what keeps a large partition from opening a
 * connection per path.
 */
export const defaultSubstituterConcurrency = 16;

/** Nix's own default for a substituter that advertises no priority. */
const defaultPriority = 0;

const cacheInfoFile = 'nix-cache-info';
const servedStoreDirectory = storeDirectorySchema.parse('/nix/store');

/** A substituter that failed to answer, named so a caller can say which. */
export class SubstituterUnreachableError extends NixStoreError {
	constructor(
		public readonly substituter: string,
		public readonly status?: number,
		options?: ErrorOptions
	) {
		super(
			status === undefined
				? `Substituter did not answer: ${substituter}`
				: `Substituter answered ${String(status)}: ${substituter}`,
			options
		);
		this.name = 'SubstituterUnreachableError';
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
 * Nix's own defaults fill in whatever the document leaves out, so a cache
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
}

/** One configured substituter, ready to be asked about paths. */
export interface Substituter extends SubstituterDescription {
	/** The substituter as configured, which names it in an error. */
	readonly uri: string;
	/** The base every request is resolved against. */
	readonly baseUrl: URL;
}

export interface SubstituterEnvironment {
	readonly fetch?: typeof fetch;
	readonly signal?: AbortSignal;
	/** How many requests are in flight at once across all substituters. */
	readonly concurrency?: number;
}

/**
 * Opens each configured substituter and orders them the way Nix does: by
 * ascending priority, ties keeping configured order. A substituter that
 * cannot describe itself is left out, since one that cannot answer for its own
 * `nix-cache-info` cannot be asked about paths either.
 */
export async function openSubstituters(
	uris: readonly string[],
	dependencies: SubstituterEnvironment = {}
): Promise<readonly Substituter[]> {
	const opened = await mapWithConcurrency(
		[...new Set(uris)],
		dependencies.concurrency ?? defaultSubstituterConcurrency,
		async (uri) => {
			const parsed = substituterUrl(uri);

			if (parsed === undefined) {
				return;
			}

			const { baseUrl, priority } = parsed;
			const described = await describeSubstituter(baseUrl, dependencies);

			return described === undefined
				? undefined
				: {
						uri,
						baseUrl,
						...described,
						...(priority !== undefined && { priority })
					};
		}
	);

	return opened
		.filter((substituter) => substituter !== undefined)
		.map((substituter, order) => ({ substituter, order }))
		.toSorted(
			(left, right) =>
				left.substituter.priority - right.substituter.priority ||
				left.order - right.order
		)
		.map(({ substituter }) => substituter);
}

/**
 * The substituters a client asks: the opened ones, or a way to open them when
 * it is first asked something.
 */
export type SubstituterSource =
	readonly Substituter[] | (() => Promise<readonly Substituter[]>);

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
 * Asks a store's substituters what they can supply, the way Nix's own client
 * does when no daemon holds the substituter configuration for it. Every answer
 * comes from the substituter itself: there is no local cache in front of these
 * queries, so what they report is what those substituters serve now.
 */
export class SubstituterClient {
	private opening?: Promise<readonly Substituter[]>;

	constructor(
		private readonly source: SubstituterSource,
		private readonly options: SubstituterClientOptions
	) {}

	// Opening a substituter reads its `nix-cache-info`, so a client built
	// from configured URIs opens them when it is first asked something, and
	// holds them for every question after.
	private opened(): Promise<readonly Substituter[]> {
		const source = this.source;

		if (typeof source !== 'function') {
			return Promise.resolve(source);
		}

		const opening = (this.opening ??= source());

		return opening;
	}

	// Nix asks each substituter in turn and takes the first answer, so a
	// higher-priority substituter's copy is the one reported.
	private async firstOffer(
		storePath: StorePathString
	): Promise<NixSubstitutablePathInfo | undefined> {
		let failure: SubstituterUnreachableError | undefined;
		const substituters = await this.opened();

		for (const substituter of substituters) {
			if (!this.serves(substituter)) {
				continue;
			}

			let answer: SubstituterOffer | undefined;

			try {
				[answer] = await this.ask(substituter, [storePath]);
			} catch (error) {
				if (!(error instanceof SubstituterUnreachableError)) {
					throw error;
				}

				failure = error;
				continue;
			}

			if (answer !== undefined) {
				return { storePath, ...answer };
			}
		}

		// A substituter that failed might have held the path, so the absence
		// is only as good as the substituters that answered. Without
		// `fallback`, the query raises what went wrong.
		if (failure !== undefined && !this.options.fallback) {
			throw failure;
		}

		return undefined;
	}

	private serves(substituter: Substituter): boolean {
		return substituter.storeDirectory === this.options.storeDirectory;
	}

	// The answers for `storePaths`, positionally: `undefined` where the
	// substituter does not hold the path.
	private ask(
		substituter: Substituter,
		storePaths: readonly StorePathString[]
	): Promise<readonly (SubstituterOffer | undefined)[]> {
		return mapWithConcurrency(
			storePaths,
			this.options.concurrency ?? defaultSubstituterConcurrency,
			(storePath) => this.offerFor(substituter, storePath)
		);
	}

	private async offerFor(
		substituter: Substituter,
		storePath: StorePathString
	): Promise<SubstituterOffer | undefined> {
		const target = new URL(
			`${canonicalHref(substituter.baseUrl)}/${StorePath.hash(storePath)}.narinfo`
		);
		const fetcher = this.options.fetch ?? fetch;

		let response: Response;

		try {
			response = await fetcher(target, { signal: this.options.signal });
		} catch (error) {
			throw new SubstituterUnreachableError(substituter.uri, undefined, {
				cause: error
			});
		}

		if (response.status === 404) {
			return undefined;
		}

		if (!response.ok) {
			throw new SubstituterUnreachableError(substituter.uri, response.status);
		}

		try {
			return offerFromNarInfo(
				await response.text(),
				storePath,
				this.options.storeDirectory
			);
		} catch (error) {
			throw new SubstituterAnswerUnreadableError(substituter.uri, {
				cause: error
			});
		}
	}

	/**
	 * The subset of the given paths some substituter offers, deduplicated and
	 * sorted. Only substituters advertising `WantMassQuery` are asked, since
	 * the others have declared that answering a batch is not something they
	 * want, and each is asked only about what its predecessors left over.
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

			const answers = await this.ask(substituter, remaining);

			for (const storePath of held(remaining, answers)) {
				found.add(storePath);
			}

			remaining = remaining.filter((storePath) => !found.has(storePath));
		}

		return [...found].toSorted(byStorePath);
	}

	/**
	 * What the first substituter holding each path offers for it, sorted by
	 * store path. A path no substituter offers has no entry, and substituters
	 * are asked in priority order so the answer is the one Nix would fetch
	 * from.
	 */
	async querySubstitutablePathInfos(
		storePaths: readonly StorePathString[]
	): Promise<readonly NixSubstitutablePathInfo[]> {
		if (!this.options.substitute) {
			return [];
		}

		const offers = await mapWithConcurrency(
			[...new Set(storePaths)],
			this.options.concurrency ?? defaultSubstituterConcurrency,
			(storePath) => this.firstOffer(storePath)
		);

		return offers
			.filter((offer) => offer !== undefined)
			.toSorted((left, right) => byStorePath(left.storePath, right.storePath));
	}
}

/** What a substituter reported for one path, without naming the path. */
type SubstituterOffer = Omit<NixSubstitutablePathInfo, 'storePath'>;

/** A narinfo that describes a path other than the one it was asked for. */
class MismatchedNarInfoPathError extends NixStoreError {
	constructor(public readonly storePath: StorePathString) {
		super(`The narinfo served does not describe ${storePath}`);
		this.name = 'MismatchedNarInfoPathError';
	}
}

// A served narinfo names the deriver and every reference by basename, while a
// substitutable-path answer names them the way the store does. Only the
// fields an answer carries are read, so a narinfo compressed any which way,
// or one omitting the sizes, is still readable.
function offerFromNarInfo(
	source: string,
	storePath: StorePathString,
	storeDirectory: StoreDirectory
): SubstituterOffer {
	const fields = parseFields(source);

	// The answer stands for the path it was asked about. A substituter naming
	// another path is describing something the caller did not ask for, and its
	// sizes and references belong to that other path.
	if (single(fields.StorePath) !== storePath) {
		throw new MismatchedNarInfoPathError(storePath);
	}

	const inStore = (basename: string): StorePathString =>
		storePathSchema.parse(`${storeDirectory}/${basename}`);
	const deriver = single(fields.Deriver);

	return {
		references: (single(fields.References) ?? '')
			.split(/\s+/u)
			.filter(Boolean)
			.map((basename) => inStore(basename)),
		...(deriver !== undefined &&
			deriver !== '' && { deriver: inStore(deriver) }),
		downloadSize: size(single(fields.FileSize)),
		narSize: size(single(fields.NarSize))
	};
}

function single(values: readonly string[] | undefined): string | undefined {
	return values?.at(-1);
}

// Nix reports zero for a size the substituter does not state.
function size(value: string | undefined): number {
	if (value === undefined || !/^\d+$/u.test(value)) {
		return 0;
	}

	const parsed = Number(value);

	return Number.isSafeInteger(parsed) ? parsed : 0;
}

// A substituter is configured as a store URI. Only the ones served over HTTP
// are opened here; a substituter of any other kind names a store this reader
// does not open, so it offers nothing.
function substituterUrl(uri: string): SubstituterUrl | undefined {
	let parsed: URL;

	try {
		parsed = new URL(uri);
	} catch {
		return;
	}

	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return;
	}

	const priority = configuredPriority(parsed);
	const baseUrl = new URL(parsed);
	baseUrl.search = '';
	baseUrl.hash = '';

	return { baseUrl, ...(priority !== undefined && { priority }) };
}

// A store URI's parameters configure the store. They are read here, and the
// address the substituter is asked at is the URI without them.
interface SubstituterUrl {
	readonly baseUrl: URL;
	readonly priority?: number;
}

async function describeSubstituter(
	baseUrl: URL,
	dependencies: SubstituterEnvironment
): Promise<SubstituterDescription | undefined> {
	const fetcher = dependencies.fetch ?? fetch;

	let response: Response;

	try {
		response = await fetcher(
			new URL(`${canonicalHref(baseUrl)}/${cacheInfoFile}`),
			{ signal: dependencies.signal }
		);
	} catch {
		return;
	}

	if (!response.ok) {
		return;
	}

	return parseCacheInfo(await response.text());
}

// The `?priority=` parameter a store URI may carry, which settles the priority
// whatever the substituter advertises.
function configuredPriority(url: URL): number | undefined {
	const configured = url.searchParams.get('priority');

	if (configured === null || !/^\d+$/u.test(configured)) {
		return;
	}

	const priority = Number(configured);

	return Number.isSafeInteger(priority) ? priority : undefined;
}

// Nix reads the document line by line and applies its own default to every
// field the document leaves out, so a cache publishing a partial one is
// usable.
function parseCacheInfo(source: string): SubstituterDescription {
	let storeDirectory = servedStoreDirectory;
	let hasMassQuery = false;
	let priority = defaultPriority;

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

		if (name === 'Priority' && /^\d+$/u.test(value)) {
			priority = Number(value);
		}
	}

	return { storeDirectory, hasMassQuery, priority };
}

// The paths a substituter answered for, which its answers name positionally.
function held(
	asked: readonly StorePathString[],
	answers: readonly (SubstituterOffer | undefined)[]
): readonly StorePathString[] {
	return asked.filter((_, index) => answers[index] !== undefined);
}

function byStorePath(left: StorePathString, right: StorePathString): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
