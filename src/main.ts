import {
	Menu,
	Notice,
	Plugin,
	TAbstractFile,
	TFile,
	TFolder,
	Vault,
	WorkspaceLeaf,
} from 'obsidian';
import { encodePreset } from './engine';
import type { OptimizePreset } from './engine';
import { parsePresets, presetOutputPath, resolvePresets } from './presets';
import { ImagePickerModal, PresetPickerModal } from './modals';
import { ImageMagickSettingTab } from './settings';
import { embeddedImageAt, imagesInNote } from './embed-menu';
import { describeSwaps, notesLinking, replaceLinks, type SwapResult } from './relink';
import { isImageFile, readBytes, writeBytes } from './vault';
import { EDITOR_VIEW_TYPE, EditorView } from './ui/EditorView';

export interface ImageMagickSettings {
	/** Empty means the three built-in presets are offered instead. */
	presets: OptimizePreset[];
	/** Optimizing from the file explorer also points every note at the new file. */
	updateAllNotes: boolean;
	/** After links are swapped, trash the original once nothing links to it. */
	trashOriginal: boolean;
}

export const DEFAULT_SETTINGS: ImageMagickSettings = {
	presets: [],
	updateAllNotes: false,
	trashOriginal: false,
};

export default class ImageMagickPlugin extends Plugin {
	settings: ImageMagickSettings = DEFAULT_SETTINGS;

	async onload() {
		await this.loadSettings();

		this.registerView(
			EDITOR_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new EditorView(leaf, this),
		);

		this.addRibbonIcon('image', 'Optimize image', () => {
			this.pickImage((file) => void this.openEditor([file]));
		});

		this.addCommand({
			id: 'open-image',
			name: 'Open image',
			callback: () => {
				this.pickImage((file) => void this.openEditor([file]));
			},
		});

		this.addCommand({
			id: 'optimize-with-preset',
			name: 'Optimize with preset',
			callback: () => {
				this.pickImage((file) => this.promptPreset([file]));
			},
		});

		this.addCommand({
			id: 'optimize-note-images',
			name: 'Optimize images in current note',
			checkCallback: (checking) =>
				this.withNoteImages(checking, (images, note) => void this.openEditor(images, note)),
		});

		this.addCommand({
			id: 'optimize-note-images-with-preset',
			name: 'Optimize images in current note with preset',
			checkCallback: (checking) =>
				this.withNoteImages(checking, (images, note) => this.promptPreset(images, note)),
		});

		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file, source) => {
				// A note's own menu (file explorer, tab, more options) acts on the
				// images it embeds. A link to a note inside another note does not.
				if (file instanceof TFile && file.extension === 'md') {
					if (source !== 'link-context-menu') {
						this.addMenuItems(menu, imagesInNote(this.app, file), file);
					}
					return;
				}
				// An embed right-clicked in live preview: the note is the active file.
				const active = this.app.workspace.getActiveFile();
				const note =
					source === 'link-context-menu' && active?.extension === 'md'
						? active
						: null;
				this.addMenuItems(menu, this.imagesIn([file]), note);
			}),
		);

		this.registerEvent(
			this.app.workspace.on('files-menu', (menu, files) => {
				this.addMenuItems(menu, this.imagesIn(files));
			}),
		);

		this.registerDomEvent(document, 'contextmenu', (evt) => {
			// A prevented event already has a menu (live preview), which got our
			// items through file-menu above.
			const hit = evt.defaultPrevented ? null : embeddedImageAt(this.app, evt);
			if (!hit) {
				return;
			}
			evt.preventDefault();
			const menu = new Menu();
			this.addMenuItems(menu, [hit.image], hit.note);
			menu.showAtMouseEvent(evt);
		});

		this.addSettingTab(new ImageMagickSettingTab(this.app, this));
	}

	/** The presets to offer: the user's saved ones, or the built-in defaults. */
	presets(): OptimizePreset[] {
		return resolvePresets(this.settings.presets);
	}

	async addPreset(preset: OptimizePreset): Promise<void> {
		// Saving the first preset while the defaults are in play starts the user's
		// own list with just this one, which is what "saved presets win" means.
		this.settings.presets.push(preset);
		await this.saveSettings();
		new Notice(`Saved preset "${preset.name}".`);
	}

	/**
	 * Points notes at `to` instead of `from` after an optimize. Which notes: every
	 * one that links to `from` with **Update links in every note** on, otherwise
	 * just `note`, the one it was optimized from. Neither means nothing changes.
	 */
	async swapLinks(note: TFile | null, from: TFile, to: TFile): Promise<SwapResult> {
		const notes = this.settings.updateAllNotes
			? notesLinking(this.app, from)
			: note
				? [note]
				: null;
		if (!notes) {
			return { notes: [], kept: false };
		}
		return replaceLinks(this.app, notes, from, to, this.settings.trashOriginal);
	}

	async openEditor(files: TFile[], note: TFile | null = null): Promise<void> {
		const { workspace } = this.app;
		const leaf =
			workspace.getLeavesOfType(EDITOR_VIEW_TYPE)[0] ?? workspace.getLeaf('tab');
		await leaf.setViewState({ type: EDITOR_VIEW_TYPE, active: true });
		await workspace.revealLeaf(leaf);
		if (leaf.view instanceof EditorView) {
			leaf.view.setFiles(files, note);
		}
	}

	/**
	 * Runs `preset` over `files`, writing each output into the vault. The picker
	 * is always shown first (see PresetPickerModal): this writes with no preview.
	 */
	private async runPreset(
		files: TFile[],
		preset: OptimizePreset,
		note: TFile | null,
	): Promise<void> {
		const notice = new Notice(`Optimizing with ${preset.name}…`, 0);
		let saved = 0;
		let failed = 0;
		const swaps: SwapResult[] = [];
		try {
			for (const [i, file] of files.entries()) {
				notice.setMessage(
					`${preset.name}: ${i + 1}/${files.length} ${file.name}`,
				);
				try {
					const out = await encodePreset(await readBytes(this.app, file), preset);
					const written = await writeBytes(
						this.app,
						presetOutputPath(file.path, preset),
						out,
					);
					saved++;
					swaps.push(await this.swapLinks(note, file, written));
				} catch (err) {
					failed++;
					console.error(`[ImageMagick] failed on ${file.path}`, err);
				}
			}
		} finally {
			notice.hide();
		}
		new Notice(
			(failed === 0
				? `Optimized ${saved} image${saved === 1 ? '' : 's'}.`
				: `Optimized ${saved}, ${failed} failed. See the console for details.`) +
				describeSwaps(swaps),
		);
	}

	private promptPreset(files: TFile[], note: TFile | null = null): void {
		new PresetPickerModal(this.app, this.presets(), files.length, (preset) => {
			void this.runPreset(files, preset, note);
		}).open();
	}

	/** The image open in the active tab, or else one picked from the vault. */
	private pickImage(onPick: (file: TFile) => void): void {
		const active = this.app.workspace.getActiveFile();
		if (active && isImageFile(active)) {
			onPick(active);
			return;
		}
		new ImagePickerModal(this.app, onPick).open();
	}

	/**
	 * For a command on the active note's images: available only when the active
	 * note embeds at least one, so the palette hides it otherwise.
	 */
	private withNoteImages(
		checking: boolean,
		run: (images: TFile[], note: TFile) => void,
	): boolean {
		const note = this.app.workspace.getActiveFile();
		const images = note?.extension === 'md' ? imagesInNote(this.app, note) : [];
		if (!note || images.length === 0) {
			return false;
		}
		if (!checking) {
			run(images, note);
		}
		return true;
	}

	/** The images in a selection. A folder counts as every image under it, subfolders included. */
	private imagesIn(files: TAbstractFile[]): TFile[] {
		// A Set, so a folder selected along with a file inside it lists it once.
		const images = new Set<TFile>();
		const add = (f: TAbstractFile) => {
			if (f instanceof TFile && isImageFile(f)) {
				images.add(f);
			}
		};
		for (const file of files) {
			if (file instanceof TFolder) {
				Vault.recurseChildren(file, add);
			} else {
				add(file);
			}
		}
		return [...images];
	}

	private addMenuItems(menu: Menu, images: TFile[], note: TFile | null = null): void {
		if (images.length === 0) {
			return;
		}
		menu.addItem((item) =>
			item
				.setTitle(
					images.length === 1 ? 'Optimize image' : `Optimize ${images.length} images`,
				)
				.setIcon('image')
				.onClick(() => void this.openEditor(images, note)),
		);
		menu.addItem((item) =>
			item
				.setTitle('Optimize with preset')
				.setIcon('wand')
				.onClick(() => this.promptPreset(images, note)),
		);
	}

	async loadSettings() {
		const data = (await this.loadData()) as Partial<ImageMagickSettings> | null;
		this.settings = {
			presets: parsePresets(data?.presets),
			updateAllNotes: data?.updateAllNotes === true,
			trashOriginal: data?.trashOriginal === true,
		};
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
