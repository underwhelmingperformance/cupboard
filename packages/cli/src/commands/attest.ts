import { env } from 'node:process';

import { selectorForCache, storePathSchema } from '@cupboard/nix-store/scalars';
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
import { commandUi, type ProgramOptions } from '../cli.ts';
import { CupboardClient, storedCacheFor } from '../client/client.ts';
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
	readonly cache?: string;
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
		public readonly value: string
	) {
		super(`Invalid ${option} (expected a positive integer): ${value}`);
		this.name = 'InvalidVerifierThresholdError';
	}
}

export class AttestVerifyModeError extends CliUsageError {
	constructor(detail: string) {
		super(detail);
		this.name = 'AttestVerifyModeError';
	}
}

export function parseVerifierThreshold(option: string) {
	return (value: string): number => {
		if (!/^\d+$/.test(value)) {
			throw new InvalidVerifierThresholdError(option, value);
		}

		const parsed = Number(value);

		// A threshold of zero would tell the Sigstore verifier to require no
		// transparency-log, certificate-transparency or timestamp entries, which
		// silently disables that part of verification.
		if (!Number.isSafeInteger(parsed) || parsed < 1) {
			throw new InvalidVerifierThresholdError(option, value);
		}

		return parsed;
	};
}

interface AttachOptions {
	readonly githubOidc?: boolean;
	readonly audience?: Audience;
	readonly cache?: string;
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
			'Work with the Sigstore attestation bundles attached to store paths.'
		);

	attest
		.command('attach')
		.description(
			'Attach Sigstore attestation bundles to store paths the cache already serves.'
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument(
			'<paths...>',
			'published Nix store paths to attach attestations to'
		)
		.option(
			'--github-oidc',
			'authenticate with a GitHub Actions OIDC token (default: the cached owner login)'
		)
		.option(
			'--audience <audience>',
			'OIDC audience to request with --github-oidc (default: the tenant URL)',
			parseAudience
		)
		.option('--cache <name>', 'attach on a named cache rather than the default')
		.option('--read-user <user>', 'private-read username', parseReadUser)
		.option('--read-password <password>', 'private-read password')
		.option(
			'--attestation <bundle>',
			'Sigstore bundle containing a DSSE envelope; every in-toto subject must match a given store path',
			collect,
			[]
		)
		.addHelpText(
			'after',
			[
				'',
				'Examples:',
				'  # Attach a provenance bundle signed after the paths were published',
				'  cupboard attest attach --github-oidc https://cache.example.workers.dev/t/acme \\',
				'    /nix/store/...-app --attestation ./app.sigstore.json'
			].join('\n')
		)
		.action(async (url: URL, paths: string[], options: AttachOptions) => {
			if (options.attestation.length === 0) {
				throw new AttestAttachBundleRequiredError();
			}

			const reporter = commandUi(program, programOptions).reporter();
			const raw = CupboardClient.fromUrl(url, {
				cache: options.cache,
				signal: programOptions.signal
			});
			const cacheSelector = selectorForCache(storedCacheFor(options.cache));
			const resolvedPaths = paths.map((path) =>
				storePathSchema.parse(resolvePushPath(path))
			);
			const readUser =
				options.readUser ?? parseReadUser(env.CUPBOARD_READ_USER);
			const readPassword = options.readPassword ?? env.CUPBOARD_READ_PASSWORD;
			const pathInfos = await readCommittedAttestationPathInfos(
				resolvedPaths,
				{
					url,
					cache: storedCacheFor(options.cache),
					...(readUser !== undefined && { readUser }),
					...(readPassword !== undefined && { readPassword })
				},
				{
					...(programOptions.signal !== undefined && {
						signal: programOptions.signal
					})
				}
			);
			const token = await authenticateForPush(raw, {
				githubOidc: options.githubOidc,
				audience: options.audience ?? audienceSchema.parse(url),
				authorizationDetails: attestAttachAuthorizationDetails({
					cacheSelector
				})
			});

			await runAttestAttach(resolvedPaths, reporter, {
				client: requireAttestationAttachClient(
					pushClientFor(url, token, {
						cache: options.cache,
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
			'Verify Sigstore attestation bundles against a Sigstore trust root and threshold policy.'
		)
		.argument('[bundles...]', 'local Sigstore bundle files')
		.option('--nar-hash <hash>', 'expected NAR hash for local bundle mode')
		.option(
			'--url <url>',
			'remote tenant URL to verify against (e.g. https://cupboard.example.workers.dev/t/<slug>)',
			parseWorkerUrl
		)
		.option('--store-path-hash <hash>', 'remote store-path hash to inspect')
		.option('--cache <name>', 'remote named cache')
		.option('--bundle-digest <digest>', 'remote bundle digest to verify')
		.option('--read-user <user>', 'private-read username', parseReadUser)
		.option('--read-password <password>', 'private-read password')
		.option('--trusted-public-key <key>', 'trusted narinfo public key')
		.option(
			'--trust-cache-pubkey',
			'fetch /pubkey from the cache and use it as the narinfo trust source'
		)
		.requiredOption(
			'--predicate-type <type>',
			'required in-toto predicate type for each verified bundle'
		)
		.option(
			'--trusted-root <path>',
			'Sigstore trusted_root.json file; defaults to the public Sigstore root'
		)
		.option(
			'--tlog-threshold <count>',
			'minimum Rekor transparency-log entries required; default is Sigstore verifier policy',
			parseVerifierThreshold('--tlog-threshold')
		)
		.option(
			'--ctlog-threshold <count>',
			'minimum certificate-transparency log entries required; default is Sigstore verifier policy',
			parseVerifierThreshold('--ctlog-threshold')
		)
		.option(
			'--timestamp-threshold <count>',
			'minimum signed timestamps required; default is Sigstore verifier policy',
			parseVerifierThreshold('--timestamp-threshold')
		)
		.option('--certificate-identity <identity>', 'expected signing identity')
		.option(
			'--certificate-identity-regex <regex>',
			'regular expression for the signing identity'
		)
		.option(
			'--certificate-oidc-issuer <issuer>',
			'expected signing OIDC issuer'
		)
		.option(
			'--certificate-oidc-issuer-regex <regex>',
			'regular expression for the signing OIDC issuer'
		)
		.addHelpText(
			'after',
			[
				'',
				'Examples:',
				'  # Local mode: verify bundle files against an expected NAR hash',
				'  cupboard attest verify ./app.sigstore.json \\',
				'    --nar-hash sha256:... --predicate-type https://slsa.dev/provenance/v1',
				'',
				'  # Remote mode: verify what a cache holds for a store path',
				'  cupboard attest verify --url https://cache.example.workers.dev/t/acme \\',
				'    --store-path-hash <hash> --trust-cache-pubkey \\',
				'    --predicate-type https://slsa.dev/provenance/v1'
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

					return verifyRemoteAttestations({
						...common,
						url: options.url,
						storePathHash: options.storePathHash,
						cache: storedCacheFor(options.cache),
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
		...optionalRow('Signed at', trust.signedAt),
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
				'signed',
				'signed',
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
