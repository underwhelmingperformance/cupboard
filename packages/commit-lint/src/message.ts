/**
 * A parsed commit message whose body can be checked separately from git
 * trailers.
 */
export class CommitMessageDocument {
	private constructor(
		public readonly subject: string,
		public readonly body: string,
		public readonly trailers: readonly string[],
		public readonly separatorMissing: boolean
	) {}

	static parse(message: string): CommitMessageDocument {
		const lines = normaliseLineEndings(message).split('\n');
		const subject = lines[0] ?? '';
		const bodyLines = lines.slice(1);

		while (bodyLines[0] === '') {
			bodyLines.shift();
		}

		while (bodyLines.at(-1) === '') {
			bodyLines.pop();
		}

		const trailerStart = trailerBlockStart(bodyLines);
		const trailers =
			trailerStart === undefined ? [] : bodyLines.slice(trailerStart);
		const proseLines =
			trailerStart === undefined ? bodyLines : bodyLines.slice(0, trailerStart);
		const separatorMissing =
			trailerStart !== undefined &&
			trailerStart > 0 &&
			bodyLines[trailerStart - 1] !== '';

		while (proseLines.at(-1) === '') {
			proseLines.pop();
		}

		return new CommitMessageDocument(
			subject,
			proseLines.length === 0 ? '' : `${proseLines.join('\n')}\n`,
			trailers,
			separatorMissing
		);
	}

	withBody(body: string): string {
		const sections = [this.subject];
		const trimmedBody = body.trimEnd();

		if (trimmedBody !== '') {
			sections.push('', trimmedBody);
		}

		if (this.trailers.length > 0) {
			sections.push('', this.trailers.join('\n'));
		}

		return sections.join('\n');
	}
}

export function normaliseLineEndings(value: string): string {
	return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

export function commitSubject(message: string): string {
	return normaliseLineEndings(message).split('\n', 1)[0] ?? '';
}

export function stripCommitMessageComments(message: string): string {
	return normaliseLineEndings(message)
		.split('\n')
		.filter((line) => !line.startsWith('#'))
		.join('\n')
		.trimEnd();
}

/**
 * Trailers Git produces itself. They let a trailer run glued to the body be
 * recognised without a separating blank line, mirroring the 25% rule in git's
 * own `find_trailer_block_start`.
 */
const gitGeneratedTrailerPrefixes = [
	'Signed-off-by: ',
	'(cherry picked from commit '
];

function trailerBlockStart(lines: readonly string[]): number | undefined {
	if (lines.length === 0) {
		return undefined;
	}

	let paragraphStart = lines.length - 1;

	while (paragraphStart > 0 && lines[paragraphStart - 1] !== '') {
		paragraphStart -= 1;
	}

	const paragraph = lines.slice(paragraphStart);

	if (isTrailerBlock(paragraph)) {
		return paragraphStart;
	}

	const runStart = trailerSuffixStart(paragraph);

	if (runStart === undefined) {
		return undefined;
	}

	if (!containsRecognisedTrailer(paragraph.slice(runStart))) {
		return undefined;
	}

	return paragraphStart + runStart;
}

function trailerSuffixStart(lines: readonly string[]): number | undefined {
	for (let start = 1; start < lines.length; start += 1) {
		if (isTrailerBlock(lines.slice(start))) {
			return start;
		}
	}

	return undefined;
}

function containsRecognisedTrailer(lines: readonly string[]): boolean {
	return lines.some((line) => isGitGeneratedTrailer(line));
}

function isTrailerBlock(lines: readonly string[]): boolean {
	let sawTrailer = false;

	for (const line of lines) {
		if (/^[ \t]+\S/u.test(line)) {
			if (!sawTrailer) {
				return false;
			}

			continue;
		}

		if (!isTrailerLine(line) && !isGitGeneratedTrailer(line)) {
			return false;
		}

		sawTrailer = true;
	}

	return sawTrailer;
}

function isTrailerLine(line: string): boolean {
	return /^[^\s:]+(?:[ \t]*:)[ \t]*\S.*$/u.test(line);
}

function isGitGeneratedTrailer(line: string): boolean {
	return gitGeneratedTrailerPrefixes.some((prefix) => line.startsWith(prefix));
}
