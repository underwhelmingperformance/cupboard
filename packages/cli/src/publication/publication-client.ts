import {
	cacheUrl,
	parseTenantCacheUrl,
	reuseViewUrl
} from '@cupboard/nix-store/cache-url';
import {
	type CacheAccessMode,
	type CacheScope
} from '@cupboard/nix-store/scalars';
import { tenantContract } from '@cupboard/protocol/contract';
import { type AuthorizationDetails } from '@cupboard/protocol/grants';
import { publicationManifestsCapability } from '@cupboard/protocol/publication-manifests';
import {
	publicationCaptureBindingSchema,
	type PublicationWorkflowExecutionContext,
	type PublicationWorkflowRequest,
	publicationWorkflowRequestSchema,
	type PublicationWorkflowResponse,
	publicationWorkflowResponseSchema
} from '@cupboard/protocol/publication-workflow';
import {
	acceptCapabilitiesHeader,
	type PushId,
	uploadCapabilitiesHeader,
	uploadNegotiateResponseSchema
} from '@cupboard/protocol/upload';
import { requestWithDeadline } from '@cupboard/shared/paging';

import {
	contentReadAuthorizationDetails,
	pushAuthorizationDetails
} from '../auth/attenuate.ts';
import { type CacheTarget } from '../cache-target.ts';
import { callInCache } from '../client/cache-scoped.ts';
import { type AccessCredential } from '../client/credentials.ts';
import { procedureDeadline, tenantRpc } from '../client/orpc.ts';
import { referenceSourceReadIntents } from '../push/reference-source-read.ts';

import {
	createPublicationWorkflow,
	PublicationWorkflowError,
	type PublicationWorkflowOptions
} from './publication-workflow.ts';

export async function publicationWorkflowAuthorizationDetails(
	request: PublicationWorkflowRequest,
	destination: CacheTarget,
	fetchCacheAccess: (url: URL) => Promise<CacheAccessMode>
): Promise<AuthorizationDetails> {
	const source =
		request.operation === 'lookup'
			? request.input.source
			: request.operation === 'ensure'
				? {
						cache: request.input.source.result.cache,
						selector: request.input.sourceSelector
					}
				: undefined;
	// A selected view supplies read authority; the concrete cache is only a fence.
	const sources =
		source === undefined
			? []
			: source.selector === undefined
				? source.cache === undefined
					? []
					: [cacheUrl(destination.tenantUrl, source.cache)]
				: [reuseViewUrl(destination.tenantUrl, source.selector.view)];
	const reads = await referenceSourceReadIntents(
		sources,
		destination,
		fetchCacheAccess
	);
	return [
		...pushAuthorizationDetails({
			cache: destination.cache,
			attest: false,
			runRoot:
				request.operation === 'prepare-run-root'
					? request.input.name
					: request.operation === 'ensure'
						? request.input.runRoot
						: undefined
		}),
		...reads.intents.flatMap((intent) =>
			contentReadAuthorizationDetails(intent)
		)
	];
}

export interface PublicationClientOptions extends Omit<
	PublicationWorkflowOptions,
	'pushId'
> {
	readonly cache: CacheScope;
	readonly fetcher?: typeof fetch;
}

/**
Negotiates once through the existing credential exchange; errors are never non-support.
*/
export function publicationWorkflowFor(
	url: URL,
	credential: AccessCredential,
	options: PublicationClientOptions
) {
	const destinationTenantUrl = parseTenantCacheUrl(new URL(url)).tenantUrl.href;
	options = { ...options, cache: structuredClone(options.cache) };
	let isSupported = false;
	let pushId: PushId | undefined;
	let capability: Promise<boolean> | undefined;
	const rpc = tenantRpc(url, {
		credential,
		signal: options.signal,
		fetcher: async (input, init) => {
			const request = new Request(input, init);
			const headers = new Headers(request.headers);
			headers.set(acceptCapabilitiesHeader, publicationManifestsCapability);
			const response = await (options.fetcher ?? fetch)(
				new Request(request, { headers })
			);
			if (
				response.ok &&
				new URL(request.url).pathname.endsWith('/uploads/credential')
			) {
				isSupported =
					response.headers
						.get(uploadCapabilitiesHeader)
						?.split(',')
						.some((value) => value.trim() === publicationManifestsCapability) ??
					false;
			}
			return response;
		}
	});
	const hasSupport = (): Promise<boolean> =>
		(capability ??= requestWithDeadline(
			async (signal) => {
				const issued = await callInCache(
					rpc.uploads.credential,
					options.cache,
					{},
					{ signal }
				);
				signal.throwIfAborted();
				pushId = issued.pushId;
				return isSupported;
			},
			procedureDeadline(
				'uploads.credential',
				tenantContract.uploads.credential.inDefaultCache,
				{
					signal: options.signal,
					...(options.requestDeadlineMs !== undefined && {
						deadlineMs: options.requestDeadlineMs
					})
				}
			)
		));
	const getPushId = async (): Promise<PushId> => {
		await hasSupport();
		if (pushId === undefined) {
			throw new Error('The publication credential omitted its push ID.');
		}
		return pushId;
	};
	const workflow = createPublicationWorkflow(
		options.cache,
		{ publication: rpc.publication, plan: rpc.uploads.plan },
		{
			...options,
			pushId: getPushId
		}
	);
	return {
		async execute(
			input: PublicationWorkflowRequest,
			context?: PublicationWorkflowExecutionContext
		): Promise<PublicationWorkflowResponse> {
			const request = publicationWorkflowRequestSchema.parse(input);
			if (context?.capture !== undefined) {
				const binding = publicationCaptureBindingSchema.parse(
					context.capture.binding
				);
				if (
					request.operation !== 'capture' ||
					binding.tenantUrl !== destinationTenantUrl ||
					JSON.stringify(binding.cache) !== JSON.stringify(options.cache) ||
					JSON.stringify(binding.input) !== JSON.stringify(request.input)
				) {
					throw new PublicationWorkflowError(
						'The capture checkpoint binding does not match this execution.'
					);
				}
				context = { capture: { binding, store: context.capture.store } };
			}
			if (!(await hasSupport())) {
				if (context?.capture !== undefined) {
					throw new PublicationWorkflowError(
						'Recorded publication support changed during capture recovery.'
					);
				}
				return publicationWorkflowResponseSchema.parse({
					operation: request.operation,
					supported: false
				});
			}
			switch (request.operation) {
				case 'prepare-run-root': {
					// This existing write API registers the destination and binds/extends
					// retention without replacing targets already attached by other cohorts.
					const preparedPushId = await getPushId();
					const output = uploadNegotiateResponseSchema.parse(
						await requestWithDeadline(
							(signal) =>
								callInCache(
									rpc.uploads.negotiate,
									options.cache,
									{
										pushId: preparedPushId,
										paths: [],
										attachRoot: request.input
									},
									{ signal }
								),
							procedureDeadline(
								'uploads.negotiate',
								tenantContract.uploads.negotiate.inDefaultCache,
								{
									signal: options.signal,
									...(options.requestDeadlineMs !== undefined && {
										deadlineMs: options.requestDeadlineMs
									})
								}
							)
						)
					);
					if (output.uploads.length > 0) {
						throw new PublicationWorkflowError(
							'Run root preparation returned unexpected uploads.'
						);
					}
					return publicationWorkflowResponseSchema.parse({
						operation: 'prepare-run-root',
						supported: true,
						output: { name: request.input.name }
					});
				}
				case 'lookup': {
					return publicationWorkflowResponseSchema.parse({
						operation: 'lookup',
						supported: true,
						output: await workflow.lookup(request.input)
					});
				}
				case 'capture': {
					return publicationWorkflowResponseSchema.parse({
						operation: 'capture',
						supported: true,
						output: await workflow.capture(request.input, context)
					});
				}
				case 'ensure': {
					return publicationWorkflowResponseSchema.parse({
						operation: 'ensure',
						supported: true,
						output: await workflow.ensure(request.input)
					});
				}
			}
		}
	};
}
