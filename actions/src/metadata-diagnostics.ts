import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { TenantDependencyDiagnostic } from '@cupboard/nix';
import {
	appendResultEvent,
	createGithubReporter,
	formatDuration,
	type Reporter,
	type ResultPayload
} from '@cupboard/reporter';

import type { Environment } from './inputs.ts';

export function metadataDiagnostics(
	environment: Environment,
	reporter: Reporter = createGithubReporter({ environment })
): {
	readonly onDiagnostic: (diagnostic: TenantDependencyDiagnostic) => void;
	readonly onDiagnosticError: () => void;
} {
	const directory = environment.RUNNER_TEMP;
	const file =
		directory === undefined || directory === ''
			? undefined
			: path.join(directory, `cupboard-result-metadata-${randomUUID()}.jsonl`);
	return {
		onDiagnostic(diagnostic) {
			const payload: ResultPayload = {
				kind: `dependency-metadata-${diagnostic.kind}`,
				data: diagnostic,
				rows: []
			};
			if (diagnostic.kind === 'source') {
				reporter.result({
					...payload,
					rows: [
						{ label: 'source', value: diagnostic.source },
						{ label: 'status', value: diagnostic.status },
						{
							label: 'checked',
							value: `${String(diagnostic.checked)}/${String(diagnostic.total)}`
						},
						{ label: 'found', value: String(diagnostic.found) },
						{ label: 'missing', value: String(diagnostic.missing) },
						{ label: 'requests', value: String(diagnostic.requests) },
						{ label: 'elapsed', value: formatDuration(diagnostic.elapsedMs) }
					]
				});
			}
			if (file !== undefined) {
				appendResultEvent(file, payload);
			}
		},
		onDiagnosticError() {
			reporter.warn('Dependency metadata diagnostics could not be recorded');
		}
	};
}
