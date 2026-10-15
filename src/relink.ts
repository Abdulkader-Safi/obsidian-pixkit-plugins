import { Notice, TFile, getLinkpath, type App } from 'obsidian';

/**
 * Points every embed of `from` in `note` at `to`, so optimizing an image from
 * inside a note swaps it in place. With `trashOriginal`, `from` then goes to the
 * trash, unless something other than those embeds still links to it.
 */
export async function replaceInNote(
	app: App,
	note: TFile,
	from: TFile,
	to: TFile,
	trashOriginal: boolean,
): Promise<void> {
	// Overwrite with the same format writes to the same path: the link is right.
	if (from === to) {
		return;
	}
	const { metadataCache } = app;
	const embeds = (metadataCache.getFileCache(note)?.embeds ?? []).filter(
		(e) => metadataCache.getFirstLinkpathDest(getLinkpath(e.link), note.path) === from,
	);
	if (embeds.length === 0) {
		return;
	}
	// Read before editing: the cache lags behind the write below.
	const linksElsewhere = Object.entries(metadataCache.resolvedLinks).reduce(
		(sum, [path, links]) => sum + (path === note.path ? 0 : (links[from.path] ?? 0)),
		0,
	);
	const plainLinksHere =
		(metadataCache.resolvedLinks[note.path]?.[from.path] ?? 0) - embeds.length;

	const newLink = metadataCache.fileToLinktext(to, note.path);
	await app.vault.process(note, (data) => {
		// Back to front, so earlier offsets stay valid as lengths change.
		for (const e of [...embeds].reverse()) {
			const { start, end } = e.position;
			// The note changed since the cache was built: leave this one alone.
			if (data.slice(start.offset, end.offset) !== e.original) {
				continue;
			}
			data =
				data.slice(0, start.offset) +
				relink(e.original, e.link, newLink) +
				data.slice(end.offset);
		}
		return data;
	});
	new Notice(`Updated ${note.basename} to use ${to.name}.`);

	if (!trashOriginal) {
		return;
	}
	if (linksElsewhere + plainLinksHere > 0) {
		new Notice(`Kept ${from.name}: other links still point to it.`);
		return;
	}
	await app.fileManager.trashFile(from);
}

/** `original` with its link target swapped. */
function relink(original: string, oldLink: string, newLink: string): string {
	if (original.startsWith('![[')) {
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
