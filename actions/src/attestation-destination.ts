import { withReadAuthentication } from '@cupboard/nix';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import type { CacheScope, StorePathString } from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { canonicalHref } from '@cupboard/nix-store/url';
import type { Reporter } from '@cupboard/reporter';
import { discardResponseBody } from '@cupboard/shared/cleanup';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import {
	basicAuthHeader,
	type BasicCredential,
	type ReadUser
} from '@cupboard/shared/http';
import { fetchWithProbeRetries } from '@cupboard/shared/paging';
import { readResponseText } from '@cupboard/shared/response-body';
import { retryingFetcher } from '@cupboard/shared/retry';

import {
	CommittedSubjectInvalidError,
	CommittedSubjectUnavailableError,
	MissingInputError,
	ReadPasswordRequiredError,
	ReadUserRequiredError,
	SubjectNarHashMovedError
} from './errors.ts';
import type { Environment } from './inputs.ts';
import {
	providedCacheSelection,
	providedReadUser,
	providedUrl
} from './options.ts';
import { cacheUrlFor } from './substituters.ts';

export interface AttestationDestinationOptions {
	readonly url?: string;
	readonly cache?: string;
	readonly readUser?: string;
	readonly readPassword?: string;
}

export interface AttestationDestination {
	readonly url: URL;
	readonly cache: CacheScope;
	readonly readUser: ReadUser | '';
	readonly readPassword: string;
}

export interface AttestationDestinationDependencies {
	readonly fetch?: typeof fetch;
}

export function resolveAttestationDestination(
	options: AttestationDestinationOptions,
	environment: Environment
): AttestationDestination {
	const url = providedUrl('url', options.url);

	if (url === undefined) {
		throw new MissingInputError('url');
	}

	const readUser = providedReadUser(options.readUser);
	const readPassword = options.readPassword ?? environment.READ_PASSWORD ?? '';

	if (readUser !== '' && readPassword === '') {
		throw new ReadPasswordRequiredError();
	}

	if (readPassword !== '' && readUser === '') {
		throw new ReadUserRequiredError();
	}

	return {
		url,
		cache: providedCacheSelection(options.cache),
		readUser,
		readPassword
	};
}

const publishedSubjectConcurrency = 6;
const maximumNarInfoBytes = 1024 * 1024;

export interface PublishedSubject {
	readonly storePath: StorePathString;
	readonly sha256: string;
}

/**
Requires the destination cache to serve committed narinfo whose store path
and NAR hash match each subject. The check rejects a subject when the narinfo
read fails, when the narinfo cannot be parsed, when it describes another store
path or when its NAR hash differs. It ignores the narinfo's deriver, which can
refer to another derivation of the same fixed-output path.

The build store may have garbage-collected a path since the build, so the
check reads the committed metadata from the destination cache, not from the
build store.
*/
export async function requirePublishedSubjects(
	subjects: readonly PublishedSubject[],
	destination: AttestationDestination,
	reporter: Reporter,
	dependencies: AttestationDestinationDependencies = {}
): Promise<void> {
	if (subjects.length === 0) {
		return;
	}

	const fetcher = retryingFetcher(
		withReadAuthentication(dependencies.fetch ?? fetch, {
			tenantUrl: destination.url
		}),
		'replay-safe',
		{ trustedOrigin: destination.url.origin }
	);
	const base = canonicalHref(cacheUrlFor(destination.url, destination.cache));
	const credential = readCredential(destination);

	await reporter.progress(
		'Checking published attestation subjects',
		{ total: subjects.length },
		(progress) =>
			mapWithConcurrency(
				subjects,
				publishedSubjectConcurrency,
				async (subject) => {
					const narInfo = await fetchCommittedNarInfo(
						fetcher,
						base,
						subject.storePath,
						credential
					);
					const held = narInfo.narHash.digestHex();

					if (held !== subject.sha256) {
						throw new SubjectNarHashMovedError(
							subject.storePath,
							subject.sha256,
							held
						);
					}

					progress.advance();
				}
			)
	);
}

function readCredential(
	destination: AttestationDestination
): BasicCredential | undefined {
	return destination.readUser === ''
		? undefined
		: { user: destination.readUser, password: destination.readPassword };
}

async function fetchCommittedNarInfo(
	fetcher: typeof fetch,
	base: string,
	storePath: StorePathString,
	credential: BasicCredential | undefined
): Promise<NarInfo> {
	const target = `${base}/${StorePath.hash(storePath)}.narinfo`;
	const source = await fetchWithProbeRetries(
		fetcher,
		target,
		{
			headers: {
				accept: 'text/x-nix-narinfo',
				...(credential !== undefined && basicAuthHeader(credential))
			}
		},
		async (response) => {
			if (!response.ok) {
				await discardResponseBody(response);
				throw new CommittedSubjectUnavailableError(storePath, response.status);
			}

			return readResponseText(response, {
				description: `narinfo for ${storePath}`,
				maximumBytes: maximumNarInfoBytes
			});
		}
	);
	let narInfo: NarInfo;

	try {
		narInfo = NarInfo.parse(source);
	} catch (error) {
		throw new CommittedSubjectInvalidError(storePath, error);
	}

	if (narInfo.storePath.value !== storePath) {
		throw new CommittedSubjectInvalidError(
			storePath,
			new Error(`narinfo is for ${narInfo.storePath.value}`)
		);
	}

	return narInfo;
}
