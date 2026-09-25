import { env } from 'node:process';

import { storePathSchema } from '@cupboard/nix-store/scalars';
import { formatCount, type ResultRow } from '@cupboard/reporter';
import type { ReadUser } from '@cupboard/shared/http';
import type { VerifyResult, VerifyTrust } from '@cupboard/shared/sigstore';
import type { SlsaProvenanceSummary } from '@cupboard/shared/slsa';
import type { Command } from 'commander';

import {
	readCommittedAttestationPathInfos,
	requireAttestationAttachClient,
	runAttestAttach
} from '../attest/attach.ts';
import {
	buildOriginStatement,
	describeBuildOrigin
} from '../attest/build-origin.ts';
import {
	verifyLocalAttestations,
	verifyRemoteAttestations
} from '../attest/verify.ts';
import { type Audience, audienceSchema, parseAudience } from '../audience.ts';
import { attestAttachAuthorizationDetails } from '../auth/attenuate.ts';
import { authenticateForPush } from '../auth/auth.ts';
import {
	cacheTargetFromUrl,
	resolveAuthorisedCachePositionals
} from '../cache-target.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { CupboardClient } from '../client/client.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { AttestAttachBundleRequiredError, CliUsageError } from '../errors.ts';
import { pushClientFor } from '../push/push-client.ts';
import { parseReadUser } from '../read-user.ts';
import { tenantUrlArgument } from '../url-argument.ts';

import { resolvePushPath } from './push.ts';

interface VerifyOptions {
	readonly narHash?: string;
	readonly url?: URL;
	readonly storePathHash?: string;
	readonly bundleDigest?: string;
	readonly readUser?: ReadUser;
	readonly readPassword?: string;
	readonly trustedPublicKey?: string;
	readonly trustCachePubkey?: boolean;
	readonly certificateIdentity?: string;
	readonly certificateIdentityRegex?: string;
	readonly certificateOidcIssuer?: string;
	readonly certificateOidcIssuerRegex?: string;
	readonly predicateType: string;
	readonly trustedRoot?: string;
	readonly tlogThreshold?: number;
	readonly ctlogThreshold?: number;
	readonly timestampThreshold?: number;
}

export class InvalidVerifierThresholdError extends CliUsageError {
	constructor(
		public readonly option: string,
		public readonly value: string,
		minimum: number
	) {
		super(
			`Invalid ${option} (expected a whole number of at least ${String(minimum)}): ${value}`
		);
		this.name = 'InvalidVerifierThresholdError';
	}
}

export class AttestVerifyModeError extends CliUsageError {
	constructor(detail: string) {
		super(detail);
		this.name = 'AttestVerifyModeError';
	}
}

export function parseVerifierThreshold(option: string, minimum = 1) {
	return (value: string): number => {
		if (!/^\d+$/.test(value)) {
			throw new InvalidVerifierThresholdError(option, value, minimum);
		}

		const parsed = Number(value);

		if (!Number.isSafeInteger(parsed) || parsed < minimum) {
			throw new InvalidVerifierThresholdError(option, value, minimum);
		}

		return parsed;
	};
}

interface AttachOptions {
	readonly githubOidc?: boolean;
	readonly audience?: Audience;
	readonly readUser?: ReadUser;
	readonly readPassword?: string;
	readonly attestation: readonly string[];
}

function collect(value: string, previous: readonly string[]): string[] {
	return [...previous, value];
}

export function registerAttestCommands(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	const attest = program
		.command('attest')
		.description(
			'Attach Sigstore attestations to published store paths, and verify them.'
		);

	attest
		.command('attach')
		.description(
			'Attach Sigstore attestation bundles to store paths that are already published to the cache.'
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('<paths...>', 'published store paths to attach the bundles to')
		.option(
			'--github-oidc',
			"sign in with the job's GitHub Actions OIDC token instead of your saved `cupboard login` session"
		)
		.option(
			'--audience <audience>',
			'OIDC audience to request with --github-oidc (default: the tenant URL)',
			parseAudience
		)
		.option(
			'--read-user <user>',
			'user name of the read credential for a private cache (default: $CUPBOARD_READ_USER)',
			parseReadUser
		)
		.option(
			'--read-password <password>',
			'password of the read credential for a private cache (default: $CUPBOARD_READ_PASSWORD)'
		)
		.option(
			'--attestation <bundle>',
			'a Sigstore bundle file to attach (repeatable). Every in-toto subject in the bundle must match one of the given store paths.',
			collect,
			[]
		)
		.addHelpText(
			'after',
			[
				'',
				'Examples:',
				'  # Attach a provenance bundle signed after the paths were published',
				'  cupboard attest attach --github-oidc https://cupboard.example.workers.dev/t/acme \\',
				'    /nix/store/...-app --attestation ./app.sigstore.json'
			].join('\n')
		)
		.action(async (url: URL, paths: string[], options: AttachOptions) => {
			if (options.attestation.length === 0) {
				throw new AttestAttachBundleRequiredError();
			}

			const resolved = await resolveAuthorisedCachePositionals(url, paths, {
				minimumPayload: 1,
				payloadDescription: 'a published store path',
				authorise: (target) =>
					authenticateForPush(
						CupboardClient.fromUrl(target.tenantUrl, {
							cache: target.cache,
							signal: programOptions.signal
						}),
						{
							githubOidc: options.githubOidc,
							audience:
								options.audience ?? audienceSchema.parse(target.tenantUrl),
							authorizationDetails: attestAttachAuthorizationDetails({
								cache: target.cache
							})
						}
					),
				signal: programOptions.signal
			});
			const reporter = commandUi(program, programOptions).reporter();
			const cache = resolved.target.cache;
			const resolvedPaths = resolved.payload.map((path) =>
				storePathSchema.parse(resolvePushPath(path))
			);
			const readUser =
				options.readUser ?? parseReadUser(env.CUPBOARD_READ_USER);
			const readPassword = options.readPassword ?? env.CUPBOARD_READ_PASSWORD;
			const pathInfos = await readCommittedAttestationPathInfos(
				resolvedPaths,
				{
					url: resolved.target.tenantUrl,
					cache,
					...(readUser !== undefined && { readUser }),
					...(readPassword !== undefined && { readPassword })
				},
				{
					...(programOptions.signal !== undefined && {
						signal: programOptions.signal
					})
				}
			);
			await runAttestAttach(resolvedPaths, reporter, {
				client: requireAttestationAttachClient(
					pushClientFor(resolved.target.tenantUrl, resolved.credential, {
						cache,
						signal: programOptions.signal
					})
				),
				attestations: options.attestation.map((path) => ({ path })),
				pathInfos
			});
		});

	attest
		.command('verify')
		.description(
			'Verify Sigstore attestation bundles, either from local files or from a cache.'
		)
		.argument('[bundles...]', 'local Sigstore bundle files to verify')
		.option(
			'--nar-hash <hash>',
			'NAR hash that every bundle must attest (required when verifying local files)'
		)
		.option(
			'--url <url>',
			'tenant or cache URL to fetch the bundles from, such as https://cupboard.example.workers.dev/t/<slug> (use with --store-path-hash)',
			parseWorkerUrl
		)
		.option(
			'--store-path-hash <hash>',
			'hash part of the store path whose bundles to fetch (use with --url)'
		)
		.option(
			'--bundle-digest <digest>',
			'verify only the bundle with this digest (needed when the cache has several bundles with the predicate type)'
		)
		.option(
			'--read-user <user>',
			'user name of the read credential for a private cache (default: $CUPBOARD_READ_USER)',
			parseReadUser
		)
		.option(
			'--read-password <password>',
			'password of the read credential for a private cache (default: $CUPBOARD_READ_PASSWORD)'
		)
		.option(
			'--trusted-public-key <key>',
			"require the store path's narinfo to be signed with this public key (cannot be used with --trust-cache-pubkey)"
		)
		.option(
			'--trust-cache-pubkey',
			"require the store path's narinfo to be signed with a key from the cache's /pubkey (cannot be used with --trusted-public-key)"
		)
		.requiredOption(
			'--predicate-type <type>',
			'in-toto predicate type that every bundle must have'
		)
		.option(
			'--trusted-root <path>',
			"file of Sigstore trusted roots to verify against, instead of the public Sigstore roots. For a bundle signed by GitHub's Sigstore instance, save the output of `gh attestation trusted-root` and pass it here. The file can contain one trusted root, or one per line."
		)
		.option(
			'--tlog-threshold <count>',
			"number of Rekor transparency-log entries to require (default: 1). Pass 0 for a bundle signed with GitHub's Sigstore instance, which creates no Rekor entry.",
			// Bundles signed without Rekor need a threshold of 0 here. They still
			// need a signed timestamp, because --timestamp-threshold can't go below
			// 1, so the signing time stays verified.
			parseVerifierThreshold('--tlog-threshold', 0)
		)
		.option(
			'--ctlog-threshold <count>',
			"number of certificate-transparency log entries to require (default: the Sigstore verifier's default)",
			parseVerifierThreshold('--ctlog-threshold')
		)
		.option(
			'--timestamp-threshold <count>',
			"number of verified signed timestamps to require (default: the Sigstore verifier's default)",
			parseVerifierThreshold('--timestamp-threshold')
		)
		.option(
			'--certificate-identity <identity>',
			'identity that the signing certificate must have exactly (cannot be used with --certificate-identity-regex)'
		)
		.option(
			'--certificate-identity-regex <regex>',
			"regular expression that the signing certificate's identity must match (cannot be used with --certificate-identity)"
		)
		.option(
			'--certificate-oidc-issuer <issuer>',
			'OIDC issuer that the signing certificate must have exactly (cannot be used with --certificate-oidc-issuer-regex)'
		)
		.option(
			'--certificate-oidc-issuer-regex <regex>',
			"regular expression that the signing certificate's OIDC issuer must match (cannot be used with --certificate-oidc-issuer)"
		)
		.addHelpText(
			'after',
			[
				'',
				'Examples:',
				'  # Verify local bundle files against an expected NAR hash',
				'  cupboard attest verify ./app.sigstore.json \\',
				'    --nar-hash sha256:... --predicate-type https://slsa.dev/provenance/v1',
				'',
				'  # Verify the bundles that a cache has for a store path',
				'  cupboard attest verify --url https://cupboard.example.workers.dev/t/acme \\',
				'    --store-path-hash <hash> --trust-cache-pubkey \\',
				'    --predicate-type https://slsa.dev/provenance/v1',
				'',
				"  # A bundle signed with GitHub's Sigstore instance has RFC 3161",
				"  # timestamps and no Rekor entry. Verify it against GitHub's trusted",
				'  # roots and require no transparency-log entries.',
				'  gh attestation trusted-root > github-trusted-root.json',
				'  cupboard attest verify ./app.sigstore.json --nar-hash sha256:... \\',
				'    --predicate-type https://slsa.dev/provenance/v1 \\',
				'    --trusted-root github-trusted-root.json --tlog-threshold 0'
			].join('\n')
		)
		.action(async (bundles: string[], options: VerifyOptions) => {
			const reporter = commandUi(program, programOptions).reporter();
			const readUser =
				options.readUser ?? parseReadUser(env.CUPBOARD_READ_USER);
			const readPassword = options.readPassword ?? env.CUPBOARD_READ_PASSWORD;
			const common = {
				certificateIdentity: options.certificateIdentity,
				certificateIdentityRegex: options.certificateIdentityRegex,
				certificateOidcIssuer: options.certificateOidcIssuer,
				certificateOidcIssuerRegex: options.certificateOidcIssuerRegex,
				predicateType: options.predicateType,
				trustedRoot: options.trustedRoot,
				tlogThreshold: options.tlogThreshold,
				ctlogThreshold: options.ctlogThreshold,
				timestampThreshold: options.timestampThreshold
			};

			const results = await reporter.phase('Verifying attestations', () => {
				if (options.url !== undefined || options.storePathHash !== undefined) {
					if (bundles.length > 0) {
						throw new AttestVerifyModeError(
							'Remote verification does not take bundle paths'
						);
					}

					if (
						options.url === undefined ||
						options.storePathHash === undefined
					) {
						throw new AttestVerifyModeError(
							'Remote verification requires --url and --store-path-hash'
						);
					}
					const target = cacheTargetFromUrl(options.url);

					return verifyRemoteAttestations({
						...common,
						url: target.tenantUrl,
						storePathHash: options.storePathHash,
						cache: target.cache,
						bundleDigest: options.bundleDigest,
						readUser,
						readPassword,
						trustedPublicKey: options.trustedPublicKey,
						trustCachePubkey: options.trustCachePubkey,
						signal: programOptions.signal
					});
				}

				if (options.narHash === undefined) {
					throw new AttestVerifyModeError(
						'Local verification requires --nar-hash'
					);
				}

				if (bundles.length === 0) {
					throw new AttestVerifyModeError(
						'Local verification requires at least one bundle'
					);
				}

				return verifyLocalAttestations({
					...common,
					bundles,
					narHash: options.narHash
				});
			});

			const predicateTypes = new Set(results.map((item) => item.predicateType));

			reporter.result({
				kind: 'attestation-verification',
				data: results,
				rows: [
					{ label: 'Verified bundles', value: formatCount(results.length) },
					{
						label: 'Predicate types',
						value: formatCount(predicateTypes.size)
					},
					...results.flatMap((result) => [
						{ label: '', value: '' },
						...bundleRows(result, options)
					])
				]
			});
		});
}

function optionalRow(label: string, value: string | undefined): ResultRow[] {
	return value === undefined ? [] : [{ label, value }];
}

function bundleRows(result: VerifyResult, options: VerifyOptions): ResultRow[] {
	return [
		{ label: 'Bundle', value: result.bundle },
		{ label: 'Predicate', value: result.predicateType },
		{ label: 'Subject', value: `sha256:${result.subjectDigest}` },
		{ label: 'Signer', value: result.signerIdentity ?? '(unknown signer)' },
		...optionalRow('Issuer', result.signerIssuer),
		...provenanceRows(result.provenance),
		...originRows(result),
		...trustRows(result.trust, options)
	];
}

// Verification covers the entire signed build-origin statement. Report every
// subject in that statement, including subjects other than the requested path.
function originRows(result: VerifyResult): ResultRow[] {
	const statement = buildOriginStatement(result);

	if (statement === undefined) {
		return [];
	}

	return statement.subjects.map((subject) => ({
		label: 'Origin',
		value: `${subject.storePath}: ${describeBuildOrigin(subject)}`
	}));
}

function provenanceRows(
	provenance: SlsaProvenanceSummary | undefined
): ResultRow[] {
	if (provenance === undefined) {
		return [];
	}

	return [
		...optionalRow('Source repo', provenance.sourceRepository),
		...optionalRow('Source ref', provenance.sourceRef),
		...optionalRow('Source commit', provenance.sourceRevision),
		...optionalRow('Workflow', provenance.workflow),
		...optionalRow('Build trigger', provenance.buildTrigger),
		...optionalRow('Builder', provenance.builder),
		...optionalRow('Run', provenance.invocationId)
	];
}

function trustRows(trust: VerifyTrust, options: VerifyOptions): ResultRow[] {
	const indexes = trust.tlogEntries.map((entry) => entry.logIndex).join(', ');

	return [
		...optionalRow('Rekor integration', trust.integratedAt),
		...optionalRow(
			'Rekor log',
			indexes === '' ? undefined : `index ${indexes}`
		),
		{
			label: 'Transparency',
			value: describeCount(
				trust.tlogEntries.length,
				'log entry',
				'log entries',
				options.tlogThreshold
			)
		},
		{
			label: 'Timestamps',
			value: describeCount(
				trust.timestampCount,
				'verified timestamp',
				'verified timestamps',
				options.timestampThreshold
			)
		}
	];
}

function describeCount(
	count: number,
	singular: string,
	plural: string,
	threshold: number | undefined
): string {
	const base = `${formatCount(count)} ${count === 1 ? singular : plural}`;

	return threshold === undefined
		? base
		: `${base} (threshold ${formatCount(threshold)})`;
}
