import type { Nix, PublicObjectAccess } from '@cupboard/nix';
import { contentAddressedStorePath } from '@cupboard/nix-store/content-address';
import { decodeNixHashField, toNixBase32 } from '@cupboard/nix-store/hash';
import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { z } from 'zod';

// Nix fetches these input types with one HTTP request. Every other type, such
// as `git` or `path`, is left out.
const cacheableTypes = new Set(['github', 'tarball', 'file']);

// An anonymous request to github.com sees only public repositories, and
// github.com is the same service from every network. A successful request
// therefore proves that the source is public, whatever networks the runner
// can reach. A request to any other host proves only that this runner can
// fetch it.
const githubHosts = new Set([
	'github.com',
	'codeload.github.com',
	'api.github.com'
]);

const maxConcurrentProbes = 8;

const lockedInputSchema = z.looseObject({
	type: z.string(),
	narHash: z.string().optional(),
	name: z.string().optional(),
	owner: z.string().optional(),
	repo: z.string().optional(),
	rev: z.string().optional(),
	host: z.string().optional(),
	url: z.string().optional()
});
type LockedInput = z.output<typeof lockedInputSchema>;

const lockNodeSchema = z.looseObject({
	locked: lockedInputSchema.optional()
});

const flakeLockSchema = z.looseObject({
	nodes: z.record(z.string(), z.unknown())
});

/**
Why an input's source is left out of the cache:

- `type`: the input type is not `github`, `tarball` or `file`.
- `unlocked`: the lock has no SHA-256 NAR hash for the input, so its store
  path is unknown.
- `malformed`: the lock entry has a field of an unexpected type, or a name
  that no store path can have.
- `origin`: the origin is not an HTTPS github.com URL without a query string.
  The runner cannot prove that another host is public, and a query string can
  contain a token.
- `shared`: another lock node that is not a candidate has the same source
  path, so the path can contain that node's source.
- `unused`: the source is not in the local store, so the evaluation did not
  use it.
- `substituted`: the source has a signature, which means that Nix copied it
  from a binary cache. That cache keeps serving it.
- `private`: the origin refused an anonymous request.
- `unavailable`: the origin gave no definite answer.
*/
export type FlakeInputSkipReason =
	| 'type'
	| 'unlocked'
	| 'malformed'
	| 'origin'
	| 'shared'
	| 'unused'
	| 'substituted'
	| 'private'
	| 'unavailable';

/**
A lock entry that is not a cache candidate and has the same source path as a
candidate. `origin` describes where the entry's source comes from, and is
absent when the entry's URL does not parse.
*/
export interface SourcePathCollision {
	readonly input: string;
	readonly origin?: string;
}

export interface SkippedFlakeInput {
	readonly input: string;
	readonly reason: FlakeInputSkipReason;
	/**
	The colliding entry, for the reason `shared`.
	*/
	readonly collidesWith?: SourcePathCollision;
}

export interface FlakeInputSources {
	readonly paths: readonly StorePathString[];
	readonly skipped: readonly SkippedFlakeInput[];
}

export interface FlakeInputSourceDependencies {
	readonly nix: Pick<Nix, 'storeDirectory' | 'queryValidPathsInfo'>;
	/**
	Sends an anonymous request for the URL and classifies the answer. An
	expired deadline counts as `unavailable`.
	*/
	readonly probeOrigin: (url: URL) => Promise<PublicObjectAccess>;
}

interface Candidate {
	readonly input: string;
	readonly storePath: StorePathString;
	readonly origin: URL;
}

// A source path and the distinct origins of its candidates. `input` is the
// first candidate, which a skip identifies when no probe decided the path.
interface CandidateSource {
	readonly input: string;
	readonly storePath: StorePathString;
	/**
	Each distinct origin, keyed by URL, with the first candidate that has it.
	*/
	readonly origins: Map<string, { readonly url: URL; readonly input: string }>;
}

/**
Selects the source paths of a flake's locked inputs that anyone can fetch
from github.com: inputs of the `github`, `tarball` and `file` types on
github.com that this job fetched from the origin for its evaluation, and
whose origin answers an anonymous request. `lock` is the parsed
`flake.lock`. A lock entry that does not parse skips only that input.
*/
export async function selectFlakeInputSources(
	lock: unknown,
	dependencies: FlakeInputSourceDependencies
): Promise<FlakeInputSources> {
	const { nodes } = flakeLockSchema.parse(lock);
	const { storeDirectory } = dependencies.nix;
	const skipped: SkippedFlakeInput[] = [];
	// The candidates for each source path. The probe proves only that a
	// candidate's URL is public, not that the path contains what that URL
	// serves, so every entry with the path has to be a candidate with a public
	// origin before the path is selected.
	const sources = new Map<StorePathString, CandidateSource>();
	const collisions = new Map<StorePathString, SourcePathCollision>();

	for (const [input, node] of Object.entries(nodes)) {
		const parsed = lockNodeSchema.safeParse(node);

		if (!parsed.success) {
			skipped.push({ input, reason: 'malformed' });
			continue;
		}

		const { locked } = parsed.data;

		if (locked === undefined) {
			continue;
		}

		const candidate = candidateOf(input, locked, storeDirectory);

		if ('reason' in candidate) {
			skipped.push(candidate);
			const storePath = lockedSourcePath(locked, storeDirectory);

			if (storePath !== undefined && !collisions.has(storePath)) {
				const origin = describeOrigin(locked);
				collisions.set(
					storePath,
					origin === undefined ? { input } : { input, origin }
				);
			}

			continue;
		}

		const source: CandidateSource = sources.get(candidate.storePath) ?? {
			input: candidate.input,
			storePath: candidate.storePath,
			origins: new Map()
		};

		if (!source.origins.has(candidate.origin.href)) {
			source.origins.set(candidate.origin.href, {
				url: candidate.origin,
				input: candidate.input
			});
		}

		sources.set(candidate.storePath, source);
	}

	const uncontested: CandidateSource[] = [];

	for (const source of sources.values()) {
		const collidesWith = collisions.get(source.storePath);

		if (collidesWith !== undefined) {
			skipped.push({ input: source.input, reason: 'shared', collidesWith });
			continue;
		}

		uncontested.push(source);
	}

	const valid = await dependencies.nix.queryValidPathsInfo(
		uncontested.map((source) => source.storePath)
	);
	const local = new Map(valid.map((info) => [info.storePath, info]));
	const paths: StorePathString[] = [];
	const decisions = await mapWithConcurrency(
		uncontested,
		maxConcurrentProbes,
		async (source) => ({
			source,
			skips: await sourceSkips(source, local, dependencies)
		})
	);

	for (const { source, skips } of decisions) {
		if (skips.length === 0) {
			paths.push(source.storePath);
			continue;
		}

		skipped.push(...skips);
	}

	return { paths, skipped };
}

// Decides one source path from all of its candidates, and returns no skips
// when the path is selected. Each distinct origin is probed in turn, so the
// number of requests in progress stays within `maxConcurrentProbes`, and the
// first refusal ends the probing, because no later answer can make the path
// public. A skip identifies the candidate whose origin gave the deciding
// answer.
async function sourceSkips(
	source: CandidateSource,
	local: ReadonlyMap<
		StorePathString,
		{ readonly signatures: readonly string[] }
	>,
	dependencies: FlakeInputSourceDependencies
): Promise<readonly SkippedFlakeInput[]> {
	const info = local.get(source.storePath);

	if (info === undefined) {
		return [{ input: source.input, reason: 'unused' }];
	}

	if (info.signatures.length > 0) {
		return [{ input: source.input, reason: 'substituted' }];
	}

	const unavailable: SkippedFlakeInput[] = [];

	for (const { url, input } of source.origins.values()) {
		const access = await dependencies.probeOrigin(url);

		if (access === 'private') {
			return [{ input, reason: 'private' }];
		}

		if (access === 'unavailable') {
			unavailable.push({ input, reason: 'unavailable' });
		}
	}

	return unavailable;
}

// Where a lock entry's source comes from, for a warning: the scheme, host and
// path of its URL, or the repository of a `github` entry. User information, a
// query string or a fragment can contain a token, so they are left out, and
// so is a URL that does not parse.
function describeOrigin(locked: LockedInput): string | undefined {
	if (locked.url !== undefined) {
		const url = URL.parse(locked.url);

		return url === null
			? undefined
			: `${url.protocol}//${url.host}${url.pathname}`;
	}

	if (locked.owner !== undefined && locked.repo !== undefined) {
		return `${locked.host ?? 'github.com'}/${locked.owner}/${locked.repo}`;
	}

	return `a ${locked.type} input`;
}

function candidateOf(
	input: string,
	locked: LockedInput,
	storeDirectory: string
): Candidate | SkippedFlakeInput {
	if (!cacheableTypes.has(locked.type)) {
		return { input, reason: 'type' };
	}

	if (sha256NarHashOf(locked) === undefined) {
		return { input, reason: 'unlocked' };
	}

	const origin = githubOriginOf(locked);

	if (origin === undefined) {
		return { input, reason: 'origin' };
	}

	const storePath = lockedSourcePath(locked, storeDirectory);

	if (storePath === undefined) {
		return { input, reason: 'malformed' };
	}

	return { input, storePath, origin };
}

/**
The fields of a lock entry's `locked` attributes that decide its source path.
*/
export interface LockedSourceFields {
	readonly narHash?: string | undefined;
	readonly name?: string | undefined;
}

function sha256NarHashOf(locked: LockedSourceFields): Uint8Array | undefined {
	const narHash =
		locked.narHash === undefined
			? undefined
			: decodeNixHashField(locked.narHash);

	return narHash?.algorithm === 'sha256' ? narHash.bytes : undefined;
}

/**
Computes the store path at which Nix keeps a locked input's source, as
`Input::computeStorePath` does: a NAR SHA-256 address of the lock's `narHash`
without references, named `source` unless the lock sets `name`. Every input
type that Nix fetches as a final input has this path, including `git` inputs.
Returns `undefined` when the lock has no SHA-256 `narHash`, or a name that no
store path can have.
*/
export function lockedSourcePath(
	locked: LockedSourceFields,
	storeDirectory: string
): StorePathString | undefined {
	const narHash = sha256NarHashOf(locked);

	if (narHash === undefined) {
		return undefined;
	}

	const storePath = storePathSchema.safeParse(
		contentAddressedStorePath({
			storeDirectory,
			name: locked.name ?? 'source',
			contentAddress: `fixed:r:sha256:${toNixBase32(narHash)}`,
			references: [],
			hasSelfReference: false
		})
	);

	return storePath.success ? storePath.data : undefined;
}

// The github.com URL from which Nix downloads the input without credentials:
// the public archive for a `github` input, as
// `GitHubInputScheme::getDownloadUrl` uses, or the locked HTTPS URL of a
// `tarball` or `file` input. A URL with a query string can contain a token:
// GitHub adds a `token` parameter to the download link of a private
// repository's archive. Such a URL, and any other origin, has none.
function githubOriginOf(locked: LockedInput): URL | undefined {
	if (locked.type !== 'github') {
		const url =
			locked.url === undefined
				? undefined
				: (URL.parse(locked.url) ?? undefined);

		return url?.protocol === 'https:' &&
			githubHosts.has(url.hostname) &&
			url.search === ''
			? url
			: undefined;
	}

	const { host = 'github.com', owner, repo, rev } = locked;

	if (
		host !== 'github.com' ||
		owner === undefined ||
		repo === undefined ||
		rev === undefined
	) {
		return undefined;
	}

	return (
		URL.parse(`https://github.com/${owner}/${repo}/archive/${rev}.tar.gz`) ??
		undefined
	);
}
