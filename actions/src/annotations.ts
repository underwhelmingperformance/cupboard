import process from 'node:process';

// GitHub Actions turns a workflow command written on its own line into an
// annotation in the run summary and on the changed files; outside Actions the
// same call prints the plain message. The data after the `::level::` separator
// must escape the characters the command syntax reserves.
// https://docs.github.com/actions/reference/workflow-commands-for-github-actions
type AnnotationLevel = 'debug' | 'notice' | 'warning' | 'error';

function escapeData(message: string): string {
	return message
		.replaceAll('%', '%25')
		.replaceAll('\r', '%0D')
		.replaceAll('\n', '%0A');
}

function annotate(level: AnnotationLevel, message: string): void {
	if (process.env.GITHUB_ACTIONS === 'true') {
		process.stdout.write(`::${level}::${escapeData(message)}\n`);
		return;
	}

	const stream = level === 'error' ? process.stderr : process.stdout;
	stream.write(`${message}\n`);
}

/**
 * Reports diagnostic detail: a `debug` command under Actions, shown in the run
 * log only when step debugging is enabled. Outside Actions it prints plainly.
 */
export function debug(message: string): void {
	annotate('debug', message);
}

/** Reports an informational message: a `notice` annotation under Actions. */
export function notice(message: string): void {
	annotate('notice', message);
}

/** Reports a non-fatal problem: a `warning` annotation under Actions. */
export function warning(message: string): void {
	annotate('warning', message);
}

/** Reports a failure: an `error` annotation under Actions. */
export function error(message: string): void {
	annotate('error', message);
}
