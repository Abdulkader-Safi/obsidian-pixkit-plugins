import { TFile, getLinkpath, type App } from 'obsidian';
import { isImageFile } from './vault';

/**
 * The vault image behind a right-clicked `![[embed]]` in reading view, and the
 * note it sits in, or null. Live preview needs none of this: Obsidian fires
 * `file-menu` for its embeds.
 */
export function embeddedImageAt(
	app: App,
	evt: MouseEvent,
): { image: TFile; note: TFile | null } | null {
	if (!(evt.target instanceof HTMLImageElement)) {
		return null;
	}
	const embed = evt.target.closest('.markdown-preview-view .internal-embed');
	const linktext = embed?.getAttribute('src');
	if (!embed || !linktext) {
		return null;
	}
	// Links resolve relative to the note they sit in, so find the note's leaf.
	let note: TFile | null = null;
	app.workspace.iterateAllLeaves((leaf) => {
		const file = (leaf.view as { file?: TFile | null }).file;
		if (file && leaf.view.containerEl.contains(embed)) {
			note = file;
		}
	});
	const image = app.metadataCache.getFirstLinkpathDest(
		getLinkpath(linktext),
		(note as TFile | null)?.path ?? '',
	);
	return image && isImageFile(image) ? { image, note } : null;
}

/** The images `note` embeds, each once, in the order they first appear. */
export function imagesInNote(app: App, note: TFile): TFile[] {
	const images = new Set<TFile>();
	for (const embed of app.metadataCache.getFileCache(note)?.embeds ?? []) {
		const file = app.metadataCache.getFirstLinkpathDest(getLinkpath(embed.link), note.path);
		if (file && isImageFile(file)) {
			images.add(file);
		}
	}
	return [...images];
}
