import { Menu, Notice, Plugin, TAbstractFile, TFile, WorkspaceLeaf } from 'obsidian';
import { encodePreset } from './engine';
import type { OptimizePreset } from './engine';
import { parsePresets, presetOutputPath, resolvePresets } from './presets';
import { ImagePickerModal, PresetPickerModal } from './modals';
import { ImageMagickSettingTab } from './settings';
import { embeddedImageAt } from './embed-menu';
import { isImageFile, readBytes, writeBytes } from './vault';
import { EDITOR_VIEW_TYPE, EditorView } from './ui/EditorView';

export interface ImageMagickSettings {
	/** Empty means the three built-in presets are offered instead. */
	presets: OptimizePreset[];
}

export const DEFAULT_SETTINGS: ImageMagickSettings = { presets: [] };

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

		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				this.addMenuItems(menu, this.imagesIn([file]));
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
			const image = evt.defaultPrevented ? null : embeddedImageAt(this.app, evt);
			if (!image) {
				return;
			}
			evt.preventDefault();
			const menu = new Menu();
			this.addMenuItems(menu, [image]);
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

	async openEditor(files: TFile[]): Promise<void> {
		const { workspace } = this.app;
		const leaf =
			workspace.getLeavesOfType(EDITOR_VIEW_TYPE)[0] ?? workspace.getLeaf('tab');
		await leaf.setViewState({ type: EDITOR_VIEW_TYPE, active: true });
		await workspace.revealLeaf(leaf);
		if (leaf.view instanceof EditorView) {
			leaf.view.setFiles(files);
		}
	}

	/**
	 * Runs `preset` over `files`, writing each output into the vault. The picker
	 * is always shown first (see PresetPickerModal): this writes with no preview.
	 */
	private async runPreset(files: TFile[], preset: OptimizePreset): Promise<void> {
		const notice = new Notice(`Optimizing with ${preset.name}…`, 0);
		let saved = 0;
		let failed = 0;
		try {
			for (const [i, file] of files.entries()) {
				notice.setMessage(
					`${preset.name}: ${i + 1}/${files.length} ${file.name}`,
				);
				try {
					const out = await encodePreset(await readBytes(this.app, file), preset);
					await writeBytes(this.app, presetOutputPath(file.path, preset), out);
					saved++;
				} catch (err) {
					failed++;
					console.error(`[ImageMagick] failed on ${file.path}`, err);
				}
			}
		} finally {
			notice.hide();
		}
		new Notice(
			failed === 0
				? `Optimized ${saved} image${saved === 1 ? '' : 's'}.`
				: `Optimized ${saved}, ${failed} failed. See the console for details.`,
		);
	}

	private promptPreset(files: TFile[]): void {
		new PresetPickerModal(this.app, this.presets(), files.length, (preset) => {
			void this.runPreset(files, preset);
		}).open();
	}

	private pickImage(onPick: (file: TFile) => void): void {
		new ImagePickerModal(this.app, onPick).open();
	}

	private imagesIn(files: TAbstractFile[]): TFile[] {
		return files.filter((f): f is TFile => f instanceof TFile && isImageFile(f));
	}

	private addMenuItems(menu: Menu, images: TFile[]): void {
		if (images.length === 0) {
			return;
		}
		menu.addItem((item) =>
			item
				.setTitle('Optimize image')
				.setIcon('image')
				.onClick(() => void this.openEditor(images)),
		);
		menu.addItem((item) =>
			item
				.setTitle('Optimize with preset')
				.setIcon('wand')
				.onClick(() => this.promptPreset(images)),
		);
	}

	async loadSettings() {
		const data = (await this.loadData()) as Partial<ImageMagickSettings> | null;
		this.settings = { presets: parsePresets(data?.presets) };
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
