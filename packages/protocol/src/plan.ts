import {
	hasControlCharacter,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

// When `cupboard plan cohort` finds more paths with unknown availability
// than the ceiling permits, it reports a structured refusal. The GitHub
// action parses that refusal and renders the same explanation in its own
// error. This module defines the refusal schemas and the functions that
// render its message in one place, so both sides use the same
// definitions. The action may
// run an older or newer cupboard binary than the one it was released with,
// so the schemas give the newer fields defaults and a payload from an older
// binary still parses.

export const planStoreSchema = z.object({
	kind: z.enum(['local-filesystem', 'daemon', 'ssh-ng']),
	uri: z.string().min(1).optional()
});
export type PlanStore = z.output<typeof planStoreSchema>;

const attributeSchema = z
	.string()
	.min(1)
	.refine(
		(value) => !hasControlCharacter(value),
		'attr must not contain control characters'
	);

// A store path optionally followed by `^` and a non-empty output selection.
// The selection is free-form ("out", "out,dev", "*"), but it is rendered into
// operator diagnostics, so it must not contain control characters.
const derivedPathStringSchema = z.string().refine((value) => {
	const selection = value.indexOf('^');
	const basePath = selection === -1 ? value : value.slice(0, selection);
	const outputs = selection === -1 ? undefined : value.slice(selection + 1);

	return (
		storePathSchema.safeParse(basePath).success &&
		(outputs === undefined ||
			(outputs.length > 0 && !hasControlCharacter(outputs)))
	);
}, 'must name a Nix store path, optionally followed by a non-empty output selection');

export const unknownPathTargetSchema = z.object({
	attr: attributeSchema,
	installable: derivedPathStringSchema
});
export type UnknownPathTarget = z.output<typeof unknownPathTargetSchema>;

export const unknownPathCauseSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('missing-derivation') }),
	z.object({ kind: z.literal('not-in-store-or-substituters') }),
	z.object({
		kind: z.literal('substituter-result-not-refreshed'),
		reason: z.string().min(1)
	})
]);
export type UnknownPathCause = z.output<typeof unknownPathCauseSchema>;

/**
 * `targets` contains cohort targets that refer to the path directly through an
 * installable, expected output path, or planned derivation. Dependencies
 * reached only through closure traversal have no target entry.
 */
export const unknownPathDetailSchema = z.object({
	path: storePathSchema,
	cause: unknownPathCauseSchema,
	targets: z.array(unknownPathTargetSchema)
});
export type UnknownPathDetail = z.output<typeof unknownPathDetailSchema>;

/**
 * `source` identifies either the configured limit or the fallback used when
 * Cupboard could not trust that limit.
 */
export const availabilityCeilingSchema = z.object({
	value: z.number(),
	source: z.enum(['configured', 'untrusted-fallback']),
	fallbackReason: z.string().optional()
});
export type AvailabilityCeiling = z.output<typeof availabilityCeilingSchema>;

/**
 * An older cupboard reports only the count, the ceiling and the byte totals.
 * The newer fields therefore default to empty so that payload still parses.
 */
export const unknownPathsCeilingRefusalSchema = z.object({
	reason: z.literal('unknown-paths-ceiling'),
	unknownCount: z.number(),
	unknownPaths: z.array(unknownPathDetailSchema).default([]),
	store: planStoreSchema.optional(),
	unreachableSubstituters: z.array(z.string()).default([]),
	ceiling: availabilityCeilingSchema,
	downloadSize: z.number(),
	narSize: z.number()
});
export type UnknownPathsCeilingRefusal = z.output<
	typeof unknownPathsCeilingRefusalSchema
>;

export interface UnknownPathsRefusalDescription {
	readonly unknownPaths: readonly UnknownPathDetail[];
	readonly ceiling: {
		readonly value: number;
		readonly source: 'configured' | 'untrusted-fallback';
		readonly fallbackReason?: string;
	};
	readonly store?: PlanStore | undefined;
	readonly unreachableSubstituters: readonly string[];
}

// A URI is rendered into logs and error annotations, so a password in its
// userinfo must not survive. Everything else is kept verbatim: rebuilding the
// URI through the URL class would normalise more than it redacts.
function withoutPassword(uri: string): string {
	let url: URL;

	try {
		url = new URL(uri);
	} catch {
		return uri;
	}

	if (url.password === '') {
		return uri;
	}

	url.password = '';

	return url.href;
}

function planStorePhrase(store: PlanStore | undefined): string {
	if (store === undefined) {
		return 'the selected Nix store';
	}

	if (store.kind === 'daemon') {
		return "the local Nix daemon's store";
	}

	if (store.kind === 'local-filesystem') {
		return 'the local Nix store';
	}

	return store.uri === undefined
		? 'the remote Nix store'
		: `the remote Nix store at ${withoutPassword(store.uri)}`;
}

function sentenceInitial(phrase: string): string {
	return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

function describeUnknownPathCause(
	cause: UnknownPathCause,
	store: PlanStore | undefined
): string {
	const subject = sentenceInitial(planStorePhrase(store));

	if (cause.kind === 'missing-derivation') {
		return `${subject} does not contain this derivation. Nix therefore cannot inspect its outputs or dependencies.`;
	}

	if (cause.kind === 'substituter-result-not-refreshed') {
		return `${subject} does not contain this path. Cupboard could not refresh Nix's cached substituter result because ${cause.reason}.`;
	}

	return `${subject} does not contain this path. The plan queried the available substituters, but none provided it.`;
}

export function describeUnknownPath(
	detail: UnknownPathDetail,
	store: PlanStore | undefined
): string {
	const identity =
		detail.targets.length === 0
			? detail.path
			: `${detail.path}; ${detail.targets.length === 1 ? 'target' : 'targets'} ${detail.targets.map((target) => `${target.attr} (${target.installable})`).join(', ')}`;
	const cause = describeUnknownPathCause(detail.cause, store);

	return `${identity}\n${cause}`;
}

// Keep the internal `source` and trust names off the operator surface. Explain
// why a fallback replaced the configured limit without implying that the
// fallback is stricter.
function limitSentence(
	ceiling: UnknownPathsRefusalDescription['ceiling']
): string {
	const rule =
		ceiling.value === 0
			? 'The plan refuses if Nix cannot obtain any required path.'
			: `The plan refuses when the count of required paths that Nix cannot obtain exceeds ${String(ceiling.value)}.`;

	if (ceiling.source === 'configured') {
		return rule;
	}

	const reason =
		ceiling.fallbackReason ??
		"Nix's cached substituter results could not be refreshed";

	return `${rule} That limit applied because ${reason}.`;
}

export function describeUnknownPathsRefusal(
	refusal: UnknownPathsRefusalDescription
): string {
	const count = refusal.unknownPaths.length;
	const unavailable =
		count === 1
			? 'Nix cannot obtain 1 required store path'
			: `Nix cannot obtain ${String(count)} required store paths`;
	const heading = count === 1 ? 'Unavailable path' : 'Unavailable paths';
	const details = refusal.unknownPaths
		.map(
			(detail) =>
				`- ${describeUnknownPath(detail, refusal.store).replaceAll('\n', '\n  ')}`
		)
		.join('\n');
	const unreachable =
		refusal.unreachableSubstituters.length === 0
			? ''
			: 'The plan could not query these configured substituters. A path ' +
				'available only from one of them therefore counts as unavailable: ' +
				`${refusal.unreachableSubstituters.join(', ')}.\n\n`;

	return (
		'Cupboard cannot calculate the build and download work for this ' +
		`cohort because ${unavailable}.\n\n` +
		`${heading}:\n${details}\n\n` +
		unreachable +
		`${limitSentence(refusal.ceiling)} Make the missing ` +
		`${count === 1 ? 'path' : 'paths'} available in ` +
		`${planStorePhrase(refusal.store)}, then retry.`
	);
}
