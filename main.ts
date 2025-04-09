import {
    App,
    Editor,
    EditorPosition,
    EditorSuggest,
    EditorSuggestContext,
    EditorSuggestTriggerInfo,
    MarkdownFileInfo,
    MarkdownView,
    Modal,
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
    moment // Import moment for date handling
} from 'obsidian';

// Interface for our suggestion item (we only have one)
interface DateSuggestion {
    label: string;
}

// The main plugin class
export default class DateSelectorPlugin extends Plugin {
    async onload() {
        console.log('Loading Date Selector Plugin (@ Trigger)');

        // Register the EditorSuggest component
        // This handles the '@' trigger
        this.registerEditorSuggest(new DateSuggester(this.app, this));

        // --- Optional: Command for Manual Trigger (Good for testing/alternative access) ---
        this.addCommand({
            id: 'insert-update-date-command',
            name: 'Insert or Update Date (Command)',
            editorCallback: (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
                const selectedText = editor.getSelection();
                // Pass selected text (potential date) or null to the modal
                this.openDateModal(editor, selectedText || null, editor.getCursor(), editor.getCursor());
            }
        });

        // Register click handler for date selection
        this.registerDomEvent(document, 'click', this.handleClickEvent.bind(this), { capture: true });
        console.log('Click listener registered');

        console.log('Date Selector Plugin (@ Trigger) Loaded');
    }

    onunload() {
        console.log('Unloading Date Selector Plugin (@ Trigger)');
        // Obsidian automatically handles unregistering suggesters, commands registered with this.addCommand,
        // and listeners registered with this.registerDomEvent
    }

    // Helper function to open the modal, used by suggester and command
    openDateModal(editor: Editor, currentDateString: string | null, replaceStart: EditorPosition, replaceEnd: EditorPosition) {
        new DateSelectorModal(this.app, currentDateString, (newDate) => {
            editor.replaceRange(newDate, replaceStart, replaceEnd);
        }).open();
    }

    async handleClickEvent(evt: MouseEvent) {
        const target = evt.target as HTMLElement;
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);

        if (!view || !target) return;

        const isEditorClick = target.closest('.cm-editor') !== null;

        if (isEditorClick) {
            const editor = view.editor;
            // Get the precise position in the editor from the click coordinates
            // @ts-ignore - Access internal CM6 editor instance
            const cmEditor = editor.cm;
            if (!cmEditor) return;
            
            const pos = cmEditor.posAtCoords({ x: evt.clientX, y: evt.clientY });
            if (!pos) return;

            const line = editor.getLine(pos.line);
            const { foundDate, start, end } = this.findDateAtPosition(line, pos.ch);

            if (foundDate) {
                evt.preventDefault();
                evt.stopPropagation();
                this.openDateModal(editor, foundDate, { line: pos.line, ch: start }, { line: pos.line, ch: end });
            }
        }
    }

    findDateAtPosition(line: string, ch: number): { foundDate: string | null, start: number, end: number } {
        // More comprehensive date regex that matches various formats
        const dateRegexes = [
            /\b(\d{4}-\d{2}-\d{2})\b/g,  // YYYY-MM-DD
            /\b(\d{2}[-/]\d{2}[-/]\d{4})\b/g,  // DD-MM-YYYY or DD/MM/YYYY
            /\b(\d{2}[-/]\d{2}[-/]\d{2})\b/g,  // DD-MM-YY or DD/MM/YY
        ];

        for (const regex of dateRegexes) {
            let match;
            while ((match = regex.exec(line)) !== null) {
                const start = match.index;
                const end = start + match[1].length;
                
                // Check if the click position (ch) is within this date match
                if (ch >= start && ch <= end) {
                    // Try to parse and standardize the date format
                    try {
                        const parsedDate = moment(match[1], [
                            'YYYY-MM-DD',
                            'DD-MM-YYYY',
                            'DD/MM/YYYY',
                            'DD-MM-YY',
                            'DD/MM/YY'
                        ]);
                        
                        if (parsedDate.isValid()) {
                            return {
                                foundDate: parsedDate.format('YYYY-MM-DD'),
                                start,
                                end
                            };
                        }
                    } catch (e) {
                        console.error("Date parsing error:", e);
                    }
                }
            }
        }
        
        return { foundDate: null, start: -1, end: -1 };
    }
}

// The EditorSuggest class to handle the '@' trigger
class DateSuggester extends EditorSuggest<DateSuggestion> {
    plugin: DateSelectorPlugin; // Reference to the main plugin

    constructor(app: App, plugin: DateSelectorPlugin) {
        super(app);
        this.plugin = plugin;
    }

    // Determines if the suggester should open
    onTrigger(
        cursor: EditorPosition,
        editor: Editor,
        file: TFile | null
    ): EditorSuggestTriggerInfo | null {
        const currentLine = editor.getLine(cursor.line).substring(0, cursor.ch);

        // Simple trigger: Check if the last character is '@'
        if (currentLine.endsWith('@')) {
            return {
                start: { line: cursor.line, ch: cursor.ch - 1 }, // Position of '@'
                end: cursor, // Current cursor position
                query: '', // No query text needed after '@' for this simple case
            };
        }

        return null; // Trigger criteria not met
    }

    // Provides the suggestions to display
    getSuggestions(
        context: EditorSuggestContext
    ): DateSuggestion[] | Promise<DateSuggestion[]> {
        // In this case, we always show the same suggestion regardless of the query
        return [{ label: 'Pick a date...' }];
    }

    // Renders how a suggestion looks in the popup
    renderSuggestion(suggestion: DateSuggestion, el: HTMLElement): void {
        el.setText(suggestion.label);
    }

    // Called when a suggestion is selected
    selectSuggestion(
        suggestion: DateSuggestion,
        evt: MouseEvent | KeyboardEvent
    ): void {
        const editor = this.context?.editor; // Get editor from context saved by onTrigger
        const startPos = this.context?.start; // Get start position from context
        const endPos = this.context?.end;   // Get end position from context

        if (!editor || !startPos || !endPos) {
            console.error("Editor context not available in selectSuggestion");
            return;
        }

        // Close the suggestion popup explicitly (important!)
        this.close();

        // Here, instead of directly inserting text, we open our modal.
        // We pass null for currentDateString because we are inserting a new date.
        // We pass the start/end positions of the trigger ('@') so the modal knows what to replace.
        this.plugin.openDateModal(editor, null, startPos, endPos);
    }
}

// --- Date Selector Modal (Mostly Unchanged) ---
class DateSelectorModal extends Modal {
    currentDateString: string | null; // The date string we are modifying (if any)
    onSubmit: (result: string) => void;
    selectedDate: string; // Store the picked date (YYYY-MM-DD format)

    constructor(app: App, currentDateString: string | null, onSubmit: (result: string) => void) {
        super(app);
        this.currentDateString = currentDateString;
        this.onSubmit = onSubmit;

        // Try to parse the initial date using moment.js or default to today
        try {
             // Use moment's flexibility. If currentDateString is null/invalid, it defaults to now.
             this.selectedDate = moment(this.currentDateString).format('YYYY-MM-DD');
        } catch (e) {
             console.error("Moment.js parsing error or moment not available:", e);
             this.selectedDate = new Date().toISOString().split('T')[0]; // Fallback to native Date
        }
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('date-selector-modal'); // Add a class for potential styling
        contentEl.createEl('h2', { text: 'Select a Date' });

        // --- Date Input ---
        const dateInput = contentEl.createEl('input', { type: 'date', cls: 'date-selector-input' });
        dateInput.value = this.selectedDate; // Pre-fill with current/parsed date

        // Update selectedDate when the input changes
        dateInput.addEventListener('change', (evt) => {
            this.selectedDate = (evt.target as HTMLInputElement).value;
        });

        // Add some spacing before the button
        contentEl.createEl('div', { attr: { style: 'margin-top: 1rem;' } });

        // --- Submit Button ---
        new Setting(contentEl)
            .addButton((btn) =>
                btn
                    .setButtonText('Confirm Date')
                    .setCta() // Make button prominent
                    .onClick(() => {
                        if (!this.selectedDate) { // Basic validation
                            console.error("No date selected");
                            return;
                        }
                        this.close();
                        // Format the date consistently using moment before submitting
                        const formattedDate = moment(this.selectedDate).format('YYYY-MM-DD');
                        this.onSubmit(formattedDate);
                    }));

        // Focus the input field when the modal opens for better UX
        setTimeout(() => dateInput.focus(), 50);
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
} 