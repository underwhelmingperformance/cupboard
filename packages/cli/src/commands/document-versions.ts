import {
	type DocumentVersions,
	publishPlanVersion
} from '@cupboard/protocol/publish-plan';
import type { Command } from 'commander';

import { commandUi, type ProgramOptions } from '../cli.ts';

const documentVersions: DocumentVersions = {
	publishPlan: publishPlanVersion
};

export function registerDocumentVersionsCommand(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	program
		.command('document-versions')
		.description(
			'Print, as JSON, the version of each publish workflow document that this cupboard reads.'
		)
		.action(() => {
			commandUi(program, programOptions)
				.reporter()
				.data(JSON.stringify(documentVersions));
		});
}
