import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { AttestOptions } from '@actions/attest';
import { verifyBundle } from '@cupboard/shared/sigstore';
import {
	githubInstanceBundle,
	signerIdentity,
	signerIssuer
} from '@cupboard/shared/sigstore-bundle-fixture';
import { type Bundle, bundleFromJSON, bundleToJSON } from '@sigstore/bundle';
import { DSSEBundleBuilder } from '@sigstore/sign';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type {
	AttestationStatement,
	AttestationSubject,
	BundleEvidence
} from './attestation-signing.ts';
import {
	AttestationBundleUnverifiedError,
	AttestationEvidenceShapeError,
	AttestationStoreWriteError
} from './errors.ts';
import {
	actionsIdentityPolicy,
	type AttestationStoreWriter,
	type BundleBuilderFor,
	bundleBuilderFor,
	type BundleSelfCheck,
	type CheckedBundle,
	checkEvidenceShape,
	type ClientSignedProfile,
	expectedEvidence,
	publicGoodFulcioUrl,
	publicGoodRekorUrl,
	publicGoodTimestampUrl,
	selfCheckBundle,
	type SigstoreComposition,
	sigstoreComposition,
	sigstoreStatementSigner,
	statementSignerFor,
	writeToAttestationStore
} from './sigstore-signing.ts';

const mocks = vi.hoisted(() => ({
	attest: vi.fn<(options: AttestOptions) => Promise<unknown>>()
}));

vi.mock('@actions/attest', () => ({
	attest: mocks.attest,
	buildSLSAProvenancePredicate: vi.fn()
}));

const subjectDigest = '11'.repeat(32);
const otherDigest = '22'.repeat(32);
const predicateType = 'https://slsa.dev/provenance/v1';
const subjectName = 'abcdefghijklmnopqrstuvwxyz012345-app';

const subjects: readonly AttestationSubject[] = [
	{ name: subjectName, sha256: subjectDigest }
];

const statement: AttestationStatement = {
	predicateType,
	predicate: { buildDefinition: {} }
};

const clientSignedProfiles = ['tsa-only', 'rekor-and-tsa'] as const;

describe('sigstoreComposition', () => {
	it.each([
		{
			profile: 'tsa-only',
			expected: {
				fulcioUrl: publicGoodFulcioUrl,
				timestampUrl: publicGoodTimestampUrl
			}
		},
		{
			profile: 'rekor-and-tsa',
			expected: {
				fulcioUrl: publicGoodFulcioUrl,
				rekorUrl: publicGoodRekorUrl,
				timestampUrl: publicGoodTimestampUrl
			}
		}
	] as const)(
		'composes $profile from the public-good services',
		({ profile, expected }) => {
			expect(sigstoreComposition(profile)).toStrictEqual(expected);
		}
	);

	it.each(clientSignedProfiles)(
		'builds a DSSE bundle builder for %s',
		(profile) => {
			expect(bundleBuilderFor(sigstoreComposition(profile))).toBeInstanceOf(
				DSSEBundleBuilder
			);
		}
	);
});

describe('expectedEvidence', () => {
	it.each([
		{
			profile: 'tsa-only',
			expected: { tlogEntries: 'none', timestamps: 'at-least-one' }
		},
		{
			profile: 'rekor-and-tsa',
			expected: { tlogEntries: 'at-least-one', timestamps: 'at-least-one' }
		}
	] as const)(
		'promises $expected.tlogEntries log entries for $profile',
		({ profile, expected }) => {
			expect(expectedEvidence(profile)).toStrictEqual(expected);
		}
	);
});

interface ShapeCase {
	readonly profile: ClientSignedProfile;
	readonly evidence: BundleEvidence;
	readonly accepted: boolean;
}

const shapeCases: readonly ShapeCase[] = [
	{
		profile: 'tsa-only',
		evidence: { tlogEntryCount: 0, timestampCount: 1 },
		accepted: true
	},
	{
		profile: 'tsa-only',
		evidence: { tlogEntryCount: 1, timestampCount: 1 },
		accepted: false
	},
	{
		profile: 'tsa-only',
		evidence: { tlogEntryCount: 0, timestampCount: 0 },
		accepted: false
	},
	{
		profile: 'rekor-and-tsa',
		evidence: { tlogEntryCount: 1, timestampCount: 1 },
		accepted: true
	},
	{
		profile: 'rekor-and-tsa',
		evidence: { tlogEntryCount: 0, timestampCount: 1 },
		accepted: false
	},
	{
		profile: 'rekor-and-tsa',
		evidence: { tlogEntryCount: 1, timestampCount: 0 },
		accepted: false
	}
];

function shapeError(
	profile: ClientSignedProfile,
	evidence: BundleEvidence
): AttestationEvidenceShapeError {
	try {
		checkEvidenceShape(profile, evidence);
	} catch (error: unknown) {
		if (error instanceof AttestationEvidenceShapeError) {
			return error;
		}

		throw error;
	}

	throw new Error('checkEvidenceShape was expected to fail');
}

describe('checkEvidenceShape', () => {
	it.each(shapeCases)(
		'accepts $accepted for $profile carrying $evidence.tlogEntryCount log entries and $evidence.timestampCount timestamps',
		({ profile, evidence, accepted }) => {
			if (accepted) {
				expect(() => {
					checkEvidenceShape(profile, evidence);
				}).not.toThrow();

				return;
			}

			const error = shapeError(profile, evidence);

			expect({
				name: error.name,
				profile: error.profile,
				tlogEntryCount: error.tlogEntryCount,
				timestampCount: error.timestampCount
			}).toStrictEqual({
				name: 'AttestationEvidenceShapeError',
				profile,
				tlogEntryCount: evidence.tlogEntryCount,
				timestampCount: evidence.timestampCount
			});
		}
	);
});

const base64 = (text: string): string => Buffer.from(text).toString('base64');

const logEntry = {
	logIndex: '1',
	logId: { keyId: base64('log') },
	kindVersion: { kind: 'dsse', version: '0.0.1' },
	integratedTime: '1750000000',
	inclusionPromise: { signedEntryTimestamp: base64('signed-entry-timestamp') },
	inclusionProof: {
		logIndex: '1',
		rootHash: base64('root'),
		treeSize: '2',
		hashes: [base64('hash')],
		checkpoint: { envelope: 'checkpoint' }
	},
	canonicalizedBody: base64('{}')
};

interface BundleFixture {
	readonly bundle: string;
	readonly trustedRoot: string;
}

/**
 * A bundle from the shared fixture generator and the trusted root that
 * verifies it. Each call generates its own throwaway keys, so a bundle from one
 * call never verifies against the trusted root of another.
 */
function bundleFixture(
	options: {
		readonly subjectDigest?: string;
		readonly predicateType?: string;
	} = {}
): BundleFixture {
	const fixture = githubInstanceBundle({
		subjectDigest: options.subjectDigest ?? subjectDigest,
		predicateType: options.predicateType ?? predicateType,
		predicate: statement.predicate
	});

	return {
		bundle: `${new TextDecoder().decode(fixture.bundle)}\n`,
		trustedRoot: fixture.trustedRoot
	};
}

interface BundleShape {
	readonly logEntries?: number;
	readonly timestamps?: number;
}

const optionalUnknown = z.unknown().optional();
const verificationMaterialSchema = z.looseObject({
	tlogEntries: z.array(z.unknown()),
	timestampVerificationData: optionalUnknown
});
const bundleDocumentSchema = z.looseObject({
	verificationMaterial: verificationMaterialSchema
});

/**
 * Creates a fixture with one RFC 3161 timestamp. Options can add transparency
 * log entries or remove the timestamp. These mutations invalidate the bundle,
 * so the tests use them only for evidence checks that run before signature
 * verification.
 */
function shapedBundle(shape: BundleShape = {}): Bundle {
	const fixture: unknown = JSON.parse(bundleFixture().bundle);
	const document = bundleDocumentSchema.parse(fixture);
	const { timestampVerificationData, ...material } =
		document.verificationMaterial;

	return bundleFromJSON({
		...document,
		verificationMaterial: {
			...material,
			tlogEntries: Array.from(
				{ length: shape.logEntries ?? 0 },
				() => logEntry
			),
			...(shape.timestamps !== 0 && { timestampVerificationData })
		}
	});
}

interface SigningRecord {
	readonly composition: SigstoreComposition;
	readonly payload: unknown;
	readonly payloadType?: string;
}

interface SignerHarness {
	readonly records: SigningRecord[];
	readonly checked: CheckedBundle[];
	readonly uploaded: string[];
	readonly builderFor: BundleBuilderFor;
	readonly selfCheck: BundleSelfCheck;
	readonly writeAttestation: AttestationStoreWriter;
}

const uploadedAttestationId = '42';

function signerHarness(bundle: Bundle): SignerHarness {
	const records: SigningRecord[] = [];
	const checked: CheckedBundle[] = [];
	const uploaded: string[] = [];

	return {
		records,
		checked,
		uploaded,
		builderFor: (composition) => ({
			create: (artifact) => {
				records.push({
					composition,
					payload: JSON.parse(artifact.data.toString('utf8')),
					...(artifact.type !== undefined && { payloadType: artifact.type })
				});

				return Promise.resolve(bundle);
			}
		}),
		selfCheck: (given) => {
			checked.push(given);

			return Promise.resolve();
		},
		writeAttestation: (write) => {
			uploaded.push(write.bundle);

			return Promise.resolve(uploadedAttestationId);
		}
	};
}

const signedStatement = {
	_type: 'https://in-toto.io/Statement/v1',
	subject: [{ name: subjectName, digest: { sha256: subjectDigest } }],
	predicateType,
	predicate: statement.predicate
};

describe('sigstoreStatementSigner', () => {
	it.each([
		{
			profile: 'tsa-only',
			shape: { timestamps: 1 },
			evidence: { tlogEntryCount: 0, timestampCount: 1 }
		},
		{
			profile: 'rekor-and-tsa',
			shape: { logEntries: 1, timestamps: 1 },
			evidence: { tlogEntryCount: 1, timestampCount: 1 }
		}
	] as const)(
		'signs $profile through its own composition',
		async ({ profile, shape, evidence }) => {
			const bundle = shapedBundle(shape);
			const harness = signerHarness(bundle);
			const serialised = `${JSON.stringify(bundleToJSON(bundle))}\n`;
			const signed = await sigstoreStatementSigner(
				{ subjects, profile, githubToken: 'token', uploadToGithub: false },
				harness
			)(statement);

			expect({
				signed,
				records: harness.records,
				checked: harness.checked,
				uploaded: harness.uploaded
			}).toStrictEqual({
				signed: { bundle: serialised, evidence },
				records: [
					{
						composition: sigstoreComposition(profile),
						payload: signedStatement,
						payloadType: 'application/vnd.in-toto+json'
					}
				],
				checked: [
					{ profile, statement, subjects, bundle: serialised, evidence }
				],
				uploaded: []
			});
		}
	);

	it.each([
		{ uploadToGithub: true, uploads: 1, attestationId: uploadedAttestationId },
		{ uploadToGithub: false, uploads: 0, attestationId: undefined }
	])(
		'records $uploads bundles with upload-to-github $uploadToGithub',
		async ({ uploadToGithub, uploads, attestationId }) => {
			const harness = signerHarness(shapedBundle({ timestamps: 1 }));
			const signed = await sigstoreStatementSigner(
				{
					subjects,
					profile: 'tsa-only',
					githubToken: 'token',
					uploadToGithub
				},
				harness
			)(statement);

			expect({
				attestationId: signed.attestationId,
				uploads: harness.uploaded.length
			}).toStrictEqual({ attestationId, uploads });
		}
	);

	it('records nothing when the self-check refuses the evidence', async () => {
		const harness = signerHarness(
			shapedBundle({ logEntries: 1, timestamps: 1 })
		);
		const sign = sigstoreStatementSigner(
			{
				subjects,
				profile: 'tsa-only',
				githubToken: 'token',
				uploadToGithub: true
			},
			{ ...harness, selfCheck: selfCheckBundle }
		);

		await expect(sign(statement)).rejects.toBeInstanceOf(
			AttestationEvidenceShapeError
		);
		expect(harness.uploaded).toStrictEqual([]);
	});
});

describe('statementSignerFor', () => {
	it.each([
		{ profile: 'sigstore-default', delegated: 1, composed: [] },
		{
			profile: 'tsa-only',
			delegated: 0,
			composed: [sigstoreComposition('tsa-only')]
		},
		{
			profile: 'rekor-and-tsa',
			delegated: 0,
			composed: [sigstoreComposition('rekor-and-tsa')]
		}
	] as const)(
		'delegates $delegated statements for $profile',
		async ({ profile, delegated, composed }) => {
			const bundle = shapedBundle({ logEntries: 1, timestamps: 1 });
			const harness = signerHarness(bundle);

			mocks.attest.mockReset();
			mocks.attest.mockResolvedValue({ bundle: bundleToJSON(bundle) });

			await statementSignerFor(
				{
					subjects,
					githubToken: 'token',
					policy: { profile, uploadToGithub: false, grouping: 'run' }
				},
				harness
			)(statement);

			expect({
				delegated: mocks.attest.mock.calls.length,
				composed: harness.records.map((record) => record.composition)
			}).toStrictEqual({ delegated, composed });
		}
	);
});

function isMatchingIdentity(
	identity: string | RegExp,
	candidate: string
): boolean {
	return identity instanceof RegExp && identity.test(candidate);
}

describe('actionsIdentityPolicy', () => {
	it.each([
		{
			server: undefined,
			issuer: 'https://token.actions.githubusercontent.com',
			accepted: signerIdentity,
			refused: 'https://acme.ghe.com/acme/app/.github/workflows/ci.yml@main'
		},
		{
			server: 'https://github.com',
			issuer: 'https://token.actions.githubusercontent.com',
			accepted: signerIdentity,
			refused: 'https://github.example/acme/app/.github/workflows/ci.yml@main'
		},
		{
			server: 'https://acme.ghe.com',
			issuer: 'https://token.actions.acme.ghe.com',
			accepted: 'https://acme.ghe.com/acme/app/.github/workflows/ci.yml@main',
			refused: signerIdentity
		}
	])(
		'reads the identity policy of $server',
		({ server, issuer, accepted, refused }) => {
			const policy = actionsIdentityPolicy(
				server === undefined ? {} : { GITHUB_SERVER_URL: server }
			);

			expect({
				issuer: policy.issuer,
				accepted: isMatchingIdentity(policy.identity, accepted),
				refused: isMatchingIdentity(policy.identity, refused)
			}).toStrictEqual({ issuer, accepted: true, refused: false });
		}
	);

	it('accepts the issuer the fixture certificate carries', () => {
		expect(actionsIdentityPolicy({}).issuer).toBe(signerIssuer);
	});
});

/**
 * Verifies against the given trusted root instead of the public-good one, so
 * the self-check runs its real signature, certificate and timestamp checks
 * without contacting a service. The fixture certificate carries no signed
 * certificate timestamp, which the public-good Fulcio embeds, so the fixture
 * verifier asks for none.
 */
async function fixtureVerifier(
	trustedRoot: string
): Promise<typeof verifyBundle> {
	const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-self-check-'));
	const trustedRootFile = path.join(directory, 'trusted-root.json');

	await writeFile(trustedRootFile, trustedRoot);

	return (bytes, policy, options) =>
		verifyBundle(bytes, policy, {
			...options,
			ctlogThreshold: 0,
			trustedRoot: trustedRootFile
		});
}

describe('selfCheckBundle', () => {
	it.each([
		{ difference: 'nothing', signed: {}, accepted: true },
		{
			difference: 'the predicate type',
			signed: { predicateType: 'https://cupboard.example/origin/v1' },
			accepted: false
		},
		{
			difference: 'the subject digest',
			signed: { subjectDigest: otherDigest },
			accepted: false
		}
	])(
		'accepts $accepted when the bundle differs in $difference',
		async ({ signed, accepted }) => {
			const fixture = bundleFixture(signed);
			const checked: CheckedBundle = {
				profile: 'tsa-only',
				statement,
				subjects,
				bundle: fixture.bundle,
				evidence: { tlogEntryCount: 0, timestampCount: 1 }
			};
			const dependencies = {
				environment: {},
				verify: await fixtureVerifier(fixture.trustedRoot)
			};

			if (accepted) {
				await expect(
					selfCheckBundle(checked, dependencies)
				).resolves.toBeUndefined();

				return;
			}

			await expect(
				selfCheckBundle(checked, dependencies)
			).rejects.toBeInstanceOf(AttestationBundleUnverifiedError);
		}
	);

	it('refuses a bundle that another trusted root would verify', async () => {
		const fixture = bundleFixture();
		const unrelated = bundleFixture();
		const verify = await fixtureVerifier(unrelated.trustedRoot);

		await expect(
			selfCheckBundle(
				{
					profile: 'tsa-only',
					statement,
					subjects,
					bundle: fixture.bundle,
					evidence: { tlogEntryCount: 0, timestampCount: 1 }
				},
				{ environment: {}, verify }
			)
		).rejects.toBeInstanceOf(AttestationBundleUnverifiedError);
	});
});

describe('writeToAttestationStore', () => {
	const environment = {
		GITHUB_REPOSITORY: 'acme/app',
		GITHUB_API_URL: 'https://api.github.example'
	};

	it('posts the bundle to the attestation store of the run repository', async () => {
		const requests: { url: string; body: unknown }[] = [];

		vi.stubGlobal(
			'fetch',
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const request = new Request(input, init);

				requests.push({
					url: request.url,
					body: JSON.parse(await request.text())
				});

				return Response.json({ id: 7 }, { status: 201 });
			}
		);

		try {
			const attestationId = await writeToAttestationStore({
				bundle: '{"mediaType":"test"}\n',
				githubToken: 'token',
				environment
			});

			expect({ attestationId, requests }).toStrictEqual({
				attestationId: '7',
				requests: [
					{
						url: 'https://api.github.example/repos/acme/app/attestations',
						body: { bundle: { mediaType: 'test' } }
					}
				]
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('fails when the repository is not an owner and name pair', async () => {
		await expect(
			writeToAttestationStore({
				bundle: '{}',
				githubToken: 'token',
				environment: { GITHUB_REPOSITORY: 'acme' }
			})
		).rejects.toBeInstanceOf(AttestationStoreWriteError);
	});
});
