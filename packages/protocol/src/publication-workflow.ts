import { parseTenantCacheUrl } from '@cupboard/nix-store/cache-url';
import {
	cacheScopeSchema,
	rootNameSchema,
	sha256HexDigestSchema
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import {
	compactPublicationSetSchema,
	publicationCaptureBeginRequestSchema,
	publicationEnsureRequestSchema,
	publicationLookupRequestSchema,
	publicationLookupResponseSchema,
	publicationLookupTargetSchema,
	publicationManifestMaxMembers,
	publicationManifestMaxRequestBytes,
	publicationManifestPageMaxMembers,
	publicationOperationIdSchema,
	publicationOriginSchema,
	publicationPathVersionSchema,
	publicationRequestIdSchema,
	publicationResultIdentitySchema,
	recordedPublicationSchema
} from './publication-manifests.ts';
import { uploadAttachRootSchema } from './upload.ts';

// Internal CLI adapter transport, not an HTTP API. The adapter resolves exact
// identities, obtains the destination generation and packs bounded HTTP pages.
export const publicationWorkflowCaptureInputSchema = z.strictObject({
	result: publicationLookupTargetSchema,
	members: z
		.array(publicationLookupTargetSchema)
		.min(1)
		.max(publicationManifestMaxMembers),
	origin: publicationOriginSchema,
	requestId: publicationRequestIdSchema.optional()
});
export type PublicationWorkflowCaptureInput = z.output<
	typeof publicationWorkflowCaptureInputSchema
>;

// A durable owner creates this binding and an unresolved record atomically with
// its outer intent. The digest identifies public invocation data, not credentials.
const checkpointInputSchema = publicationWorkflowCaptureInputSchema.extend({
	requestId: publicationRequestIdSchema
});
const checkpointTenantUrlSchema = z.string().refine((value) => {
	try {
		const parsed = parseTenantCacheUrl(new URL(value));
		return parsed.cache.kind === 'default' && parsed.tenantUrl.href === value;
	} catch {
		return false;
	}
}, 'Expected a canonical credential-free tenant URL');
export const publicationCaptureBindingSchema = z.strictObject({
	invocation: sha256HexDigestSchema,
	tenantUrl: checkpointTenantUrlSchema,
	cache: cacheScopeSchema,
	input: checkpointInputSchema
});
export type PublicationCaptureBinding = z.output<
	typeof publicationCaptureBindingSchema
>;

const resolvedCaptureSchema = z.strictObject({
	result: publicationResultIdentitySchema,
	begin: publicationCaptureBeginRequestSchema,
	pages: z
		.array(
			z
				.array(publicationPathVersionSchema)
				.min(1)
				.max(publicationManifestPageMaxMembers)
		)
		.min(1)
		.max(publicationManifestMaxMembers)
});
export const publicationCaptureStateSchema = z.discriminatedUnion('phase', [
	z.strictObject({ phase: z.literal('unresolved') }),
	z.strictObject({
		phase: z.literal('shortcut'),
		publication: recordedPublicationSchema
	}),
	z.strictObject({
		phase: z.literal('resolved'),
		capture: resolvedCaptureSchema
	}),
	z.strictObject({
		phase: z.literal('begun'),
		capture: resolvedCaptureSchema,
		operationId: publicationOperationIdSchema
	}),
	z.strictObject({
		phase: z.literal('captured'),
		capture: resolvedCaptureSchema,
		operationId: publicationOperationIdSchema.optional(),
		publication: recordedPublicationSchema
	})
]);
export type PublicationCaptureState = z.output<
	typeof publicationCaptureStateSchema
>;

function isSameJson(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function isMatchingTarget(
	actual: z.output<typeof publicationPathVersionSchema>,
	target: z.output<typeof publicationLookupTargetSchema>
): boolean {
	return (
		actual.storePath === target.storePath &&
		(target.narHash === undefined || actual.narHash === target.narHash) &&
		(target.generation === undefined || actual.generation === target.generation)
	);
}

function serialisedBytes(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function isValidCaptureCheckpoint(checkpoint: {
	binding: PublicationCaptureBinding;
	state: PublicationCaptureState;
}): boolean {
	const { binding, state } = checkpoint;
	const targets = new Map<
		string,
		z.output<typeof publicationLookupTargetSchema>
	>();
	for (const target of binding.input.members) {
		const previous = targets.get(target.storePath);
		if (
			previous !== undefined &&
			((previous.narHash !== undefined &&
				target.narHash !== undefined &&
				previous.narHash !== target.narHash) ||
				(previous.generation !== undefined &&
					target.generation !== undefined &&
					previous.generation !== target.generation))
		) {
			return false;
		}
		targets.set(target.storePath, {
			storePath: target.storePath,
			narHash: previous?.narHash ?? target.narHash,
			generation: previous?.generation ?? target.generation
		});
	}
	const resultTarget = targets.get(binding.input.result.storePath);
	if (
		resultTarget === undefined ||
		(resultTarget.narHash !== undefined &&
			binding.input.result.narHash !== undefined &&
			resultTarget.narHash !== binding.input.result.narHash) ||
		(resultTarget.generation !== undefined &&
			binding.input.result.generation !== undefined &&
			resultTarget.generation !== binding.input.result.generation)
	) {
		return false;
	}
	if (state.phase === 'unresolved') {
		return true;
	}
	const result =
		'capture' in state ? state.capture.result : state.publication.result;
	if (
		!isMatchingTarget(result, binding.input.result) ||
		!isMatchingTarget(result, resultTarget) ||
		!isSameJson(result.cache, binding.cache)
	) {
		return false;
	}
	if (state.phase === 'shortcut') {
		return true;
	}
	const { begin, pages } = state.capture;
	if (
		!isSameJson(begin.result, {
			storePath: result.storePath,
			narHash: result.narHash,
			generation: result.generation
		}) ||
		begin.expectedCacheGeneration !== result.cacheGeneration ||
		begin.requestId !== binding.input.requestId ||
		begin.origin !== binding.input.origin
	) {
		return false;
	}
	const route =
		binding.cache.kind === 'named' ? { cacheName: binding.cache.name } : {};
	if (
		serialisedBytes({ ...begin, ...route }) > publicationManifestMaxRequestBytes
	) {
		return false;
	}
	const seen = new Set<string>();
	for (const [page, members] of pages.entries()) {
		// UUID operation IDs have fixed width, so pages can be bounded before begin.
		if (
			serialisedBytes({
				operationId: '00000000-0000-4000-8000-000000000000',
				page,
				members,
				...route
			}) > publicationManifestMaxRequestBytes
		) {
			return false;
		}
		for (const member of members) {
			const expected = targets.get(member.storePath);
			if (
				expected === undefined ||
				seen.has(member.storePath) ||
				!isMatchingTarget(member, expected)
			) {
				return false;
			}
			if (
				member.storePath === result.storePath &&
				!isMatchingTarget(member, result)
			) {
				return false;
			}
			seen.add(member.storePath);
		}
		if (seen.size > publicationManifestMaxMembers) {
			return false;
		}
	}
	if (seen.size !== targets.size || seen.size !== begin.memberCount) {
		return false;
	}
	return (
		state.phase !== 'captured' || isSameJson(state.publication.result, result)
	);
}

export const publicationCaptureCheckpointSchema = z
	.strictObject({
		version: z.literal(1),
		binding: publicationCaptureBindingSchema,
		state: publicationCaptureStateSchema
	})
	.refine(
		isValidCaptureCheckpoint,
		'Inconsistent capture checkpoint identity, members or request bounds'
	);
export type PublicationCaptureCheckpoint = z.output<
	typeof publicationCaptureCheckpointSchema
>;

export function initialPublicationCaptureCheckpoint(
	binding: PublicationCaptureBinding
): PublicationCaptureCheckpoint {
	return publicationCaptureCheckpointSchema.parse({
		version: 1,
		binding,
		state: { phase: 'unresolved' }
	});
}

// Both adapter and durable owner validate transitions. save must compare the
// entire expected record atomically and must not initialise an absent record.
export const publicationCaptureCheckpointUpdateSchema = z
	.strictObject({
		previous: publicationCaptureCheckpointSchema,
		next: publicationCaptureCheckpointSchema
	})
	.refine(({ previous, next }) => {
		if (!isSameJson(previous.binding, next.binding)) {
			return false;
		}
		const before = previous.state;
		const after = next.state;
		if (before.phase === 'unresolved') {
			return after.phase === 'resolved' || after.phase === 'shortcut';
		}
		if (
			!('capture' in before) ||
			!('capture' in after) ||
			!isSameJson(before.capture, after.capture)
		) {
			return false;
		}
		if (before.phase === 'resolved') {
			return (
				after.phase === 'begun' ||
				(after.phase === 'captured' && after.operationId === undefined)
			);
		}
		return (
			before.phase === 'begun' &&
			after.phase === 'captured' &&
			before.operationId === after.operationId
		);
	}, 'Invalid capture checkpoint transition');

export interface PublicationCaptureCheckpointStore {
	load(): Promise<unknown>;
	save(
		expected: PublicationCaptureCheckpoint,
		next: PublicationCaptureCheckpoint
	): Promise<void>;
}
export interface PublicationCaptureRecoveryContext {
	readonly binding: PublicationCaptureBinding;
	readonly store: PublicationCaptureCheckpointStore;
}
export interface PublicationWorkflowExecutionContext {
	readonly capture?: PublicationCaptureRecoveryContext;
}

export const publicationWorkflowEnsureInputSchema =
	publicationEnsureRequestSchema
		.omit({ expectedDestinationGeneration: true, requestId: true })
		.extend({ requestId: publicationRequestIdSchema.optional() });
export type PublicationWorkflowEnsureInput = z.output<
	typeof publicationWorkflowEnsureInputSchema
>;

export const publicationWorkflowRequestSchema = z.discriminatedUnion(
	'operation',
	[
		z.strictObject({
			operation: z.literal('prepare-run-root'),
			input: uploadAttachRootSchema
		}),
		z.strictObject({
			operation: z.literal('lookup'),
			input: publicationLookupRequestSchema
		}),
		z.strictObject({
			operation: z.literal('capture'),
			input: publicationWorkflowCaptureInputSchema
		}),
		z.strictObject({
			operation: z.literal('ensure'),
			input: publicationWorkflowEnsureInputSchema
		})
	]
);
export type PublicationWorkflowRequest = z.output<
	typeof publicationWorkflowRequestSchema
>;
export type PublicationWorkflowRequestInput = z.input<
	typeof publicationWorkflowRequestSchema
>;

// Private file transport for a single owned capture; never an HTTP request.
export const publicationCaptureEnvelopeSchema = z
	.strictObject({
		version: z.literal(1),
		request: z.strictObject({
			operation: z.literal('capture'),
			input: checkpointInputSchema
		}),
		checkpoint: publicationCaptureCheckpointSchema
	})
	.refine(
		({ request, checkpoint }) =>
			isSameJson(request.input, checkpoint.binding.input),
		'Capture envelope input changed'
	);
export type PublicationCaptureEnvelope = z.output<
	typeof publicationCaptureEnvelopeSchema
>;

const prepareRunRootResponseSchema = z.discriminatedUnion('supported', [
	z.strictObject({
		operation: z.literal('prepare-run-root'),
		supported: z.literal(false)
	}),
	z.strictObject({
		operation: z.literal('prepare-run-root'),
		supported: z.literal(true),
		output: z.strictObject({ name: rootNameSchema })
	})
]);
const lookupResponseSchema = z.discriminatedUnion('supported', [
	z.strictObject({
		operation: z.literal('lookup'),
		supported: z.literal(false)
	}),
	z.strictObject({
		operation: z.literal('lookup'),
		supported: z.literal(true),
		output: publicationLookupResponseSchema
	})
]);
const captureResponseSchema = z.discriminatedUnion('supported', [
	z.strictObject({
		operation: z.literal('capture'),
		supported: z.literal(false)
	}),
	z.strictObject({
		operation: z.literal('capture'),
		supported: z.literal(true),
		output: recordedPublicationSchema
	})
]);
const ensureResponseSchema = z.discriminatedUnion('supported', [
	z.strictObject({
		operation: z.literal('ensure'),
		supported: z.literal(false)
	}),
	z.strictObject({
		operation: z.literal('ensure'),
		supported: z.literal(true),
		output: compactPublicationSetSchema
	})
]);
export const publicationWorkflowResponseSchema = z.discriminatedUnion(
	'operation',
	[
		prepareRunRootResponseSchema,
		lookupResponseSchema,
		captureResponseSchema,
		ensureResponseSchema
	]
);
export type PublicationWorkflowResponse = z.output<
	typeof publicationWorkflowResponseSchema
>;
export type PublicationWorkflowResponseInput = z.input<
	typeof publicationWorkflowResponseSchema
>;
