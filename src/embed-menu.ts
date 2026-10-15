import { TFile, getLinkpath, type App } from 'obsidian';
import { isImageFile } from './vault';

/**
 * The vault image behind a right-clicked `![[embed]]` in reading view, or null.
 * Live preview needs none of this: Obsidian fires `file-menu` for its embeds.
 */
export function embeddedImageAt(app: App, evt: MouseEvent): TFile | null {
	if (!(evt.target instanceof HTMLImageElement)) {
		return null;
	}
	const embed = evt.target.closest('.markdown-preview-view .internal-embed');
	const linktext = embed?.getAttribute('src');
	if (!embed || !linktext) {
		return null;
	}
	// Links resolve relative to the note they sit in, so find the note's leaf.
	let sourcePath = '';
	app.workspace.iterateAllLeaves((leaf) => {
		const file = (leaf.view as { file?: TFile | null }).file;
		if (file && leaf.view.containerEl.contains(embed)) {
			sourcePath = file.path;
		}
	});
	const file = app.metadataCache.getFirstLinkpathDest(getLinkpath(linktext), sourcePath);
	return file && isImageFile(file) ? file : null;
}
