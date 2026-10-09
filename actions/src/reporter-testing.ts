import { Writable } from 'node:stream';

import { createGithubReporter, type Reporter } from '@cupboard/reporter';

export const jobSummaryFile =
	'/runner/_temp/_runner_file_commands/step_summary';

export interface JobSummaryAppend {
	readonly path: string;
	readonly text: string;
}

export interface RecordingGithubReporter {
	readonly reporter: Reporter;
	/**
	Everything that the reporter wrote to the job log so far.
	*/
	readonly log: () => string;
	/**
	Every append to the job summary file so far.
	*/
	readonly summary: readonly JobSummaryAppend[];
}

/**
 * A GitHub reporter for tests. It records the job log and the job summary in
 * memory, so a test never writes to the runner's real `GITHUB_STEP_SUMMARY`.
 */
export function recordingGithubReporter(): RecordingGithubReporter {
	const chunks: string[] = [];
	const summary: JobSummaryAppend[] = [];
	const stream = new Writable({
		write(chunk: Buffer | string, _encoding, callback) {
			chunks.push(String(chunk));
			callback();
		}
	});

	return {
		reporter: createGithubReporter({
			stream,
			out: stream,
			now: () => 0,
			environment: { GITHUB_STEP_SUMMARY: jobSummaryFile },
			appendFile: (path, text) => {
				summary.push({ path, text });
			}
		}),
		log: () => chunks.join(''),
		summary
	};
}
