import { readFile } from 'node:fs/promises';

import {
	publicationCaptureEnvelopeSchema,
	type PublicationWorkflowExecutionContext,
	type PublicationWorkflowRequest,
	publicationWorkflowRequestSchema
} from '@cupboard/protocol/publication-workflow';
import { type Command } from 'commander';

import { type Audience, audienceSchema, parseAudience } from '../audience.ts';
import { authenticateForPush } from '../auth/auth.ts';
import { cacheTargetFromUrl } from '../cache-target.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { CupboardClient } from '../client/client.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import {
	PublicationCaptureEnvelopeError,
	withCaptureEnvelopeFile
} from '../publication/capture-envelope-file.ts';
import {
	publicationWorkflowAuthorizationDetails,
	publicationWorkflowFor
} from '../publication/publication-client.ts';
import { tenantUrlArgument } from '../url-argument.ts';

import { cacheAccessFetcher } from './github.ts';

interface PublicationResultOptions {
	readonly requestFile: string;
	readonly githubOidc?: boolean;
	readonly audience?: Audience;
}

interface PublicationResultCommandDependencies {
	readonly authenticate?: typeof authenticateForPush;
	readonly fetchCacheAccess?: ReturnType<typeof cacheAccessFetcher>;
	readonly workflowFor?: typeof publicationWorkflowFor;
}

export function registerPublicationResultCommand(
	program: Command,
	programOptions: ProgramOptions = {},
	dependencies: PublicationResultCommandDependencies = {}
): void {
	program
		.command('publication-result', { hidden: true })
		.description(
			'Run an internal recorded-publication workflow without transferring NAR bytes.'
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.requiredOption(
			'--request-file <path>',
			'JSON recorded-publication workflow request'
		)
		.option(
			'--github-oidc',
			"sign in with the job's GitHub Actions OIDC token instead of your saved `cupboard login` session"
		)
		.option(
			'--audience <audience>',
			'OIDC audience to request with --github-oidc (default: the tenant URL)',
			parseAudience
		)
		.action(async (url: URL, options: PublicationResultOptions) => {
			const json: unknown = JSON.parse(
				await readFile(options.requestFile, 'utf8')
			);
			const target = cacheTargetFromUrl(url);
			const execute = async (
				request: PublicationWorkflowRequest,
				context?: PublicationWorkflowExecutionContext
			) => {
				const authorizationDetails =
					await publicationWorkflowAuthorizationDetails(
						request,
						target,
						dependencies.fetchCacheAccess ??
							cacheAccessFetcher({ signal: programOptions.signal })
					);
				const credential = await (
					dependencies.authenticate ?? authenticateForPush
				)(
					CupboardClient.fromUrl(target.tenantUrl, {
						cache: target.cache,
						signal: programOptions.signal
					}),
					{
						githubOidc: options.githubOidc,
						audience:
							options.audience ?? audienceSchema.parse(target.tenantUrl),
						authorizationDetails
					}
				);
				const reporter = commandUi(program, programOptions).reporter();
				const response = await reporter.phase(
					'Resolving recorded publication',
					() =>
						(dependencies.workflowFor ?? publicationWorkflowFor)(
							target.tenantUrl,
							credential,
							{ cache: target.cache, signal: programOptions.signal }
						).execute(request, ...(context === undefined ? [] : [context]))
				);
				reporter.result({
					kind: 'publication-result',
					title: 'Recorded publication',
					data: response,
					rows: [
						{
							label: request.operation,
							value: response.supported
								? request.operation === 'capture'
									? 'captured'
									: 'complete'
								: 'not supported'
						}
					]
				});
			};
			if (publicationCaptureEnvelopeSchema.safeParse(json).success) {
				return withCaptureEnvelopeFile(
					options.requestFile,
					target,
					(envelope, context) => execute(envelope.request, context),
					programOptions.signal
				);
			}
			const request = publicationWorkflowRequestSchema.parse(json);
			if (request.operation === 'capture') {
				throw new PublicationCaptureEnvelopeError(
					'Bare capture transport has no durable checkpoint. Preserve unfinished publication state; capture requires its original private envelope.'
				);
			}
			return execute(request);
		});
}
