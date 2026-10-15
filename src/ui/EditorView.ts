import { ItemView, TFile, WorkspaceLeaf } from 'obsidian';
import { mount, unmount } from 'svelte';
import Editor from './Editor.svelte';
import type ImageMagickPlugin from '../main';

export const EDITOR_VIEW_TYPE = 'imagemagick-editor';

export class EditorView extends ItemView {
	private component: ReturnType<typeof mount> | undefined;
	private files: TFile[] = [];
	/** The note the image was opened from, if any. Saving swaps the image in it. */
	private note: TFile | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: ImageMagickPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return EDITOR_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.files[0]?.name ?? 'ImageMagick';
	}

	getIcon(): string {
		return 'image';
	}

	/** Opens a new set of files. Remounts, so every edit starts from a clean pipeline. */
	setFiles(files: TFile[], note: TFile | null = null): void {
		this.files = files;
		this.note = note;
		this.remount();
	}

	async onOpen(): Promise<void> {
		this.remount();
	}

	async onClose(): Promise<void> {
		this.destroy();
	}

	private remount(): void {
		this.destroy();
		this.component = mount(Editor, {
			target: this.contentEl,
			props: { plugin: this.plugin, files: this.files, note: this.note },
		});
	}

	private destroy(): void {
		if (this.component) {
			void unmount(this.component);
			this.component = undefined;
		}
		this.contentEl.empty();
	}
}
