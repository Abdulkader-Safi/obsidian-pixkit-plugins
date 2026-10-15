import { TFile, getLinkpath, type App, type ReferenceCache } from 'obsidian';

/** What swapping one image's links did. */
export interface SwapResult {
	/** Paths of the notes whose text changed. */
	notes: string[];
	/** The original was wanted in the trash but something still links to it. */
	kept: boolean;
}

/** Every note that links to or embeds `file`. */
export function notesLinking(app: App, file: TFile): TFile[] {
	return Object.entries(app.metadataCache.resolvedLinks)
		.filter(([, links]) => (links[file.path] ?? 0) > 0)
		.map(([path]) => app.vault.getFileByPath(path))
		.filter((f): f is TFile => f !== null);
}

/**
 * Points every link and embed of `from` in `notes` at `to`. With
 * `trashOriginal`, `from` then goes to the trash, unless a link the swap did
 * not reach (another note, or text that changed underneath) still uses it.
 */
export async function replaceLinks(
	app: App,
	notes: TFile[],
	from: TFile,
	to: TFile,
	trashOriginal: boolean,
): Promise<SwapResult> {
	// Overwrite with the same format writes to the same path: links are right.
	if (from === to) {
		return { notes: [], kept: false };
	}
	const { metadataCache } = app;
	// Read before editing: the cache lags behind the writes below.
	const total = Object.values(metadataCache.resolvedLinks).reduce(
		(sum, links) => sum + (links[from.path] ?? 0),
		0,
	);

	let replaced = 0;
	const changed: string[] = [];
	for (const note of notes) {
		const cache = metadataCache.getFileCache(note);
		const refs: ReferenceCache[] = [...(cache?.embeds ?? []), ...(cache?.links ?? [])]
			.filter(
				(r) => metadataCache.getFirstLinkpathDest(getLinkpath(r.link), note.path) === from,
			)
			// Back to front, so earlier offsets stay valid as lengths change.
			.sort((a, b) => b.position.start.offset - a.position.start.offset);
		if (refs.length === 0) {
			continue;
		}
		let hits = 0;
		await app.vault.process(note, (data) => {
			for (const r of refs) {
				const { start, end } = r.position;
				// The note changed since the cache was built: leave this one alone.
				if (data.slice(start.offset, end.offset) !== r.original) {
					continue;
				}
				data =
					data.slice(0, start.offset) +
					relink(r.original, r.link, linkFor(app, r.link, note, from, to)) +
					data.slice(end.offset);
				hits++;
			}
			return data;
		});
		replaced += hits;
		if (hits > 0) {
			changed.push(note.path);
		}
	}

	if (!trashOriginal) {
		return { notes: changed, kept: false };
	}
	if (total - replaced > 0) {
		return { notes: changed, kept: true };
	}
	await app.fileManager.trashFile(from);
	return { notes: changed, kept: false };
}

/** One line for the end of a run, e.g. " Updated 3 notes." Empty when nothing happened. */
export function describeSwaps(results: SwapResult[]): string {
	// One note can hold several of the images, so count each note once.
	const notes = new Set(results.flatMap((r) => r.notes)).size;
	const kept = results.filter((r) => r.kept).length;
	let out = '';
	if (notes > 0) {
		out += ` Updated ${notes} note${notes === 1 ? '' : 's'}.`;
	}
	if (kept > 0) {
		out += ` Kept ${kept} original${kept === 1 ? '' : 's'} that other links still use.`;
	}
	return out;
}

/**
 * The link text for `to`, written the way `oldLink` wrote `from`. Outputs land
 * beside their source, so swapping the file name keeps a full path a full path.
 * If that name would resolve to some other file, Obsidian's shortest link wins.
 */
function linkFor(app: App, oldLink: string, note: TFile, from: TFile, to: TFile): string {
	const path = getLinkpath(oldLink);
	if (to.parent === from.parent && path.endsWith(from.name)) {
		const kept = oldLink.slice(0, path.length - from.name.length) + to.name;
		if (app.metadataCache.getFirstLinkpathDest(kept, note.path) === to) {
			return kept;
		}
	}
	return app.metadataCache.fileToLinktext(to, note.path);
}

/** `original` with its link target swapped. */
function relink(original: string, oldLink: string, newLink: string): string {
	if (/^!?\[\[/.test(original)) {
		return original.replace(oldLink, newLink);
	}
	// Markdown: only touch the target in the final (...), since the alt text may
	// repeat the name. It is URL-encoded unless wrapped in <angle brackets>.
	const cut = original.lastIndexOf('](') + 2;
	if (cut === 1) {
		return original;
	}
	const target = original.slice(cut);
	return (
		original.slice(0, cut) +
		(target.includes(oldLink)
			? target.replace(oldLink, newLink)
			: target.replace(encodeURI(oldLink), encodeURI(newLink)))
	);
}
