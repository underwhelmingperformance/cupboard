import {
	formatCount,
	ResultLink,
	type ResultPayload,
	ResultTable
} from '@cupboard/reporter';
import { z } from 'zod';

import {
	type AttestationSubject,
	producedInstance,
	type SignedAttestation,
	type SigningProfile
} from './attestation-signing.ts';
import type { Environment } from './inputs.ts';

export interface SignedSubjectBundle {
	readonly file: string;
	readonly subjects: readonly AttestationSubject[];
	readonly signed: SignedAttestation;
}

const transparencyEntrySchema = z.object({
	logIndex: z.string().regex(/^\d+$/u)
});
const verificationMaterialSchema = z.object({
	tlogEntries: z.array(transparencyEntrySchema).default([])
});
const materialSchema = z.object({
	verificationMaterial: verificationMaterialSchema.optional()
});

const displayedBundleLimit = 20;

/**
Summarises the subjects and evidence in the bundles produced by signing.
*/
export function signingSummary(
	profile: SigningProfile,
	signed: readonly SignedSubjectBundle[],
	environment: Environment
): ResultPayload {
	const bundles = signed.map(({ file, subjects, signed: bundle }) => {
		const material = materialSchema.parse(JSON.parse(bundle.bundle));
		const attestationUrl =
			bundle.attestationId === undefined ||
			environment.GITHUB_REPOSITORY === undefined
				? undefined
				: new URL(
						`/${environment.GITHUB_REPOSITORY}/attestations/${encodeURIComponent(bundle.attestationId)}`,
						environment.GITHUB_SERVER_URL ?? 'https://github.com'
					).href;
		return {
			file,
			subjects: subjects.map((subject) => subject.name),
			instance: producedInstance(profile, bundle.evidence) ?? 'unknown',
			rekorIndices:
				material.verificationMaterial?.tlogEntries.map(
					(entry) => entry.logIndex
				) ?? [],
			timestampCount: bundle.evidence.timestampCount,
			...(attestationUrl !== undefined && { attestationUrl })
		};
	});
	const subjectCount = new Set(
		signed.flatMap((bundle) =>
			bundle.subjects.map((subject) => `${subject.name}:${subject.sha256}`)
		)
	).size;
	return {
		kind: 'attestation-signing',
		title: 'Signed attestations',
		jobSummary: true,
		data: { subjectCount, bundles },
		rows: [
			{ label: 'Signed subjects', value: formatCount(subjectCount) },
			{ label: 'Bundles', value: formatCount(bundles.length) }
		],
		table: ResultTable.of(
			[
				{ key: 'bundle', label: 'Attestation' },
				{ key: 'subjects', label: 'Subjects' },
				{ key: 'instance', label: 'Sigstore instance' },
				{ key: 'rekor', label: 'Rekor log index' },
				{ key: 'timestamps', label: 'Timestamps' }
			],
			bundles.slice(0, displayedBundleLimit).map((bundle) => ({
				bundle:
					bundle.attestationUrl === undefined
						? bundle.file
						: new ResultLink(
								'GitHub attestation',
								new URL(bundle.attestationUrl)
							),
				subjects: formatCount(bundle.subjects.length),
				instance: bundle.instance,
				rekor: bundle.rekorIndices.join(', ') || 'None',
				timestamps: formatCount(bundle.timestampCount)
			}))
		),
		...(bundles.length > displayedBundleLimit && {
			note: [
				`Showing ${String(displayedBundleLimit)} of ${formatCount(bundles.length)} bundles. The bundle manifest contains every file.`
			]
		})
	};
}
