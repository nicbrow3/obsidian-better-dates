import {
    App,
    Editor,
    EditorPosition,
    EditorSuggest,
    EditorSuggestContext,
    EditorSuggestTriggerInfo,
    EventRef,
    MarkdownView,
    MarkdownFileInfo,
    Modal,
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
    moment
} from 'obsidian';

interface DateSelectorSettings {
    outputFormat: string;
    enableAtTrigger: boolean;
}

const DEFAULT_SETTINGS: DateSelectorSettings = {
    outputFormat: 'MM/DD/YYYY', // Default to US format
    enableAtTrigger: true // Enable @ trigger by default
};

const DATE_FORMATS = {
    'US Format (MM/DD/YYYY)': 'MM/DD/YYYY',
    'International (YYYY-MM-DD)': 'YYYY-MM-DD',
    'UK Format (DD/MM/YYYY)': 'DD/MM/YYYY',
    'Short US (MM/DD/YY)': 'MM/DD/YY',
    'With Month Name (MMM DD, YYYY)': 'MMM DD, YYYY',
    'Long Date (D MMMM YYYY)': 'D MMMM YYYY'
};

// Interface for our suggestion item
interface DateSuggestion {
    label: string;
}

const LAST_UPDATED = '2025-04-10T12:00:00Z'; // Update this manually when changes are made

// The main plugin class
export default class DateSelectorPlugin extends Plugin {
    settings: DateSelectorSettings;
    dateSuggester: DateSuggester | null = null;
    private editorChangeRef: EventRef | null = null;

    async onload() {
        console.log('Loading Date Selector Plugin');
        
        await this.loadSettings();
        this.addSettingTab(new DateSelectorSettingTab(this.app, this));
        
        // Only create and register if enabled
        if (this.settings.enableAtTrigger) {
            this.setupAtTrigger();
        }

        this.addCommand({
            id: 'insert-update-date-command',
            name: 'Insert or Update Date (Command)',
            editorCallback: (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
                const selectedText = editor.getSelection();
                this.openDateModal(editor, selectedText || null, editor.getCursor(), editor.getCursor());
            }
        });

        this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
            this.handleClickEvent(evt);
        });

        const currentTime = new Date().toISOString();
        console.log(`Date Selector Plugin Loaded - Timestamp: ${currentTime}`);
        console.log(`Date Selector Plugin Loaded - Last Updated: ${LAST_UPDATED}`);
        // Define BUILD_TIMESTAMP or remove this line if unnecessary
                const BUILD_TIMESTAMP = new Date().toISOString();
                console.log(`Date Selector Plugin Loaded - Build Timestamp: ${BUILD_TIMESTAMP}`);
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        console.log('Loaded settings:', this.settings);
    }

    async saveSettings() {
        await this.saveData(this.settings);
        console.log('Saved settings:', this.settings);
    }

    // Helper function to open the modal
    openDateModal(editor: Editor, currentDateString: string | null, replaceStart: EditorPosition, replaceEnd: EditorPosition) {
        new DateSelectorModal(
            this.app,
            currentDateString,
            this.settings.outputFormat,
            (newDate) => {
                // Always add asterisks around the date
                const formattedDate = `*${newDate}*`;
                editor.replaceRange(formattedDate, replaceStart, replaceEnd);

                // Move the cursor to the far right of the date, outside the asterisks
                const cursorPosition = {
                    line: replaceStart.line,
                    ch: replaceStart.ch + formattedDate.length
                };
                editor.setCursor(cursorPosition);
            }
        ).open();
    }

    // Helper function to find a date at a given position in text
    findDateAtPosition(line: string, ch: number): { foundDate: string | null, start: number, end: number } {
        // Match common date formats - order matters, more specific first
        const dateFormats = [
            /\b\d{4}-\d{2}-\d{2}\b/, // YYYY-MM-DD
            /\b\d{2}[-/]\d{2}[-/]\d{4}\b/, // MM-DD-YYYY or MM/DD/YYYY
            /\b\d{2}[-/]\d{2}[-/]\d{2}\b/, // MM-DD-YY or MM/DD/YY
            /\b\d{1,2}\s(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s\d{4}\b/i, // 1 Jan 2024
            /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s\d{1,2},?\s\d{4}\b/i, // Jan 1, 2024
            /\b\d{2}\.\d{2}\.\d{4}\b/ // DD.MM.YYYY or MM.DD.YYYY
        ];

        for (const format of dateFormats) {
            const matches = Array.from(line.matchAll(new RegExp(format, 'g')));
            
            for (const match of matches) {
                const dateStart = match.index!;
                const dateEnd = dateStart + match[0].length;
                
                // Check if cursor is strictly inside the date (not at boundaries)
                if (ch > dateStart && ch < dateEnd) {
                    // Check for surrounding asterisks
                    const hasStartAsterisk = dateStart > 0 && line[dateStart - 1] === '*';
                    const hasEndAsterisk = dateEnd < line.length && line[dateEnd] === '*';
                    
                    // Adjust start and end positions to include asterisks if they exist
                    const start = hasStartAsterisk ? dateStart - 1 : dateStart;
                    const end = hasEndAsterisk ? dateEnd + 1 : dateEnd;
                    
                    // Include asterisks in the found date if they exist
                    const foundDate = line.substring(start, end);
                    
                    return { foundDate, start, end };
                }
            }
        }
        
        return { foundDate: null, start: -1, end: -1 };
    }

    async handleClickEvent(evt: MouseEvent) {
        try {
            const target = evt.target as HTMLElement;
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);

            if (!view || !target) return;

            const isEditorClick = target.closest('.cm-editor') !== null;

            if (isEditorClick) {
                const editor = view.editor;
                if (!editor) {
                    console.log('No editor instance available');
                    return;
                }

                // Safer approach - use the editor's current cursor position
                // which should be updated on click
                const pos = editor.getCursor();
                if (!pos) {
                    console.log('Could not get cursor position');
                    return;
                }

                // Make sure we can get the line
                try {
                    const line = editor.getLine(pos.line);
                    if (!line) {
                        console.log('No line content at position', pos.line);
                        return;
                    }

                    const { foundDate, start, end } = this.findDateAtPosition(line, pos.ch);

                    if (foundDate) {
                        evt.preventDefault();
                        evt.stopPropagation();
                        this.openDateModal(editor, foundDate, { line: pos.line, ch: start }, { line: pos.line, ch: end });
                    }
                } catch (lineError) {
                    console.error('Error getting line content:', lineError);
                }
            }
        } catch (error) {
            console.error('Error in click handler:', error);
        }
    }

    private setupAtTrigger() {
        // Create new suggester instance
        this.dateSuggester = new DateSuggester(this.app, this);
        this.registerEditorSuggest(this.dateSuggester);
    }

    private cleanupAtTrigger() {
        // Ensure the problematic listener cleanup is removed
        if (this.editorChangeRef) {
            this.app.workspace.offref(this.editorChangeRef);
            this.editorChangeRef = null;
        }

        // Clean up suggester
        if (this.dateSuggester) {
            // Unregister the suggester from the workspace
            const editorSuggest = (this.app.workspace as any).editorSuggest;
            if (editorSuggest?.suggests) {
                const index = editorSuggest.suggests.indexOf(this.dateSuggester);
                if (index > -1) {
                    editorSuggest.suggests.splice(index, 1);
                }
            }
            
            // Close any open suggestions
            this.dateSuggester.close();
            this.dateSuggester = null;
        }
    }

    // Method to update @ trigger functionality based on settings
    updateAtTriggerState() {
        // Clean up existing
        this.cleanupAtTrigger();

        // Setup new if enabled
        if (this.settings.enableAtTrigger) {
            this.setupAtTrigger();
        }
    }

    onunload() {
        console.log('Unloading Date Selector Plugin');
        // Clean up all event listeners and suggesters
        this.cleanupAtTrigger();
        // Ensure any remaining event listeners are cleaned up
        this.app.workspace.trigger('editor-change');
    }

    // Removed the call to `this.trigger` as it is undefined and unnecessary
    checkForTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): void {
        const triggerInfo = this.dateSuggester?.onTrigger(cursor, editor, file);
        if (triggerInfo) {
            console.log('Trigger info:', triggerInfo);
        }
    }
}

// Define the structure of your suggestion items
interface DateSuggestion {
    display: string; // Text to show in the suggestion list
    value: string;   // Value to insert when suggestion is selected
}

// Refactor the DateSuggester class to follow the recommended implementation
class DateSuggester extends EditorSuggest<DateSuggestion> {
    plugin: DateSelectorPlugin;

    constructor(app: App, plugin: DateSelectorPlugin) {
        super(app);
        this.plugin = plugin;
    }

    // Determines if the suggestion modal should open
    onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
        const line = editor.getLine(cursor.line);

        // Trigger when the character just typed is '@'
        // Check cursor position first to avoid negative index
        if (cursor.ch > 0 && line[cursor.ch - 1] === '@') {
            return {
                start: { line: cursor.line, ch: cursor.ch - 1 }, // Start before the '@'
                end: { line: cursor.line, ch: cursor.ch },      // End after the '@'
                query: ''
            };
        }

        return null;
    }

    // Provides the list of suggestions based on the current context
    async getSuggestions(context: EditorSuggestContext): Promise<DateSuggestion[]> {
        const query = context.query.toLowerCase();

        // Example: Static list of date suggestions
        const allSuggestions: DateSuggestion[] = [
            { display: 'Today', value: moment().format(this.plugin.settings.outputFormat), label: 'Today' },
            { display: 'Tomorrow', value: moment().add(1, 'day').format(this.plugin.settings.outputFormat), label: 'Tomorrow' },
            { display: 'Yesterday', value: moment().subtract(1, 'day').format(this.plugin.settings.outputFormat), label: 'Yesterday' },
            { display: 'Pick a date...', value: '', label: 'PICKER' } // Special suggestion
        ];

        // Filter suggestions based on the query
        return allSuggestions.filter(suggestion =>
            suggestion.display.toLowerCase().includes(query)
        );
    }

    // Renders how each suggestion item looks in the list
    renderSuggestion(suggestion: DateSuggestion, el: HTMLElement): void {
        el.empty();
        el.createEl('div', { text: suggestion.display });
    }

    // Called when the user selects a suggestion
    selectSuggestion(suggestion: DateSuggestion, evt: MouseEvent | KeyboardEvent): void {
        if (!this.context) return;

        // Check if it's the special "Pick a date..." suggestion
        if (suggestion.label === 'PICKER') {
            // We need the context *before* closing
            const editor = this.context.editor;
            const start = this.context.start;
            const end = this.context.end;
            
            // Open the date modal using the captured context
            this.plugin.openDateModal(
                editor,
                null, // No current date string to pass
                start, // Replace the '@' trigger
                end
            );
            
            // Now it's safe to close the suggester
            this.close(); 
            return; // Don't proceed with the default insertion
        }

        // --- Default behavior for other suggestions ---

        // Add asterisks around the selected date value
        const formattedDate = `*${suggestion.value}*`;

        this.context.editor.replaceRange(
            formattedDate, // Use the asterisk-wrapped date
            this.context.start,
            this.context.end
        );

        // Optional: Move cursor after the inserted text and the closing asterisk
        const newCursorPos = { 
            line: this.context.start.line, 
            ch: this.context.start.ch + formattedDate.length 
        };
        this.context.editor.setCursor(newCursorPos);

        // Close the suggestion modal
        this.close();
    }
}

// Settings tab class
class DateSelectorSettingTab extends PluginSettingTab {
    plugin: DateSelectorPlugin;

    constructor(app: App, plugin: DateSelectorPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Date Selector Settings' });

        new Setting(containerEl)
            .setName('Date Format')
            .setDesc('Choose the format for dates when inserting or updating')
            .addDropdown(dropdown => {
                Object.entries(DATE_FORMATS).forEach(([name, format]) => {
                    dropdown.addOption(format, name);
                });
                
                dropdown
                    .setValue(this.plugin.settings.outputFormat)
                    .onChange(async (value) => {
                        this.plugin.settings.outputFormat = value;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName('Enable @ Symbol Trigger')
            .setDesc('When enabled, typing @ will show a date picker suggestion. When disabled, you can only use the date picker by clicking on existing dates.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableAtTrigger)
                .onChange(async (value) => {
                    this.plugin.settings.enableAtTrigger = value;
                    await this.plugin.saveSettings();
                    this.plugin.updateAtTriggerState();
                }));
    }
}

// The Modal for selecting dates
class DateSelectorModal extends Modal {
    currentDateString: string | null;
    onSubmit: (result: string) => void;
    selectedDate: string;
    outputFormat: string;

    constructor(app: App, currentDateString: string | null, outputFormat: string, onSubmit: (result: string) => void) {
        super(app);
        this.currentDateString = currentDateString;
        this.onSubmit = onSubmit;
        this.outputFormat = outputFormat;

        try {
            // Try to parse the date with multiple formats
            const formats = [
                'YYYY-MM-DD',
                'MM-DD-YYYY',
                'MM/DD/YYYY',
                'DD/MM/YYYY',
                'DD.MM.YYYY',
                'MMM DD YYYY',
                'MMM DD, YYYY',
                'D MMM YYYY',
                'MM-DD-YY',
                'MM/DD/YY'
            ];
            
            // Remove asterisks for parsing if they exist
            const dateStr = this.currentDateString?.replace(/^\*|\*$/g, '') || null;
            
            if (dateStr) {
                // Try to parse with moment using multiple formats
                const parsedDate = moment(dateStr, formats, true);
                if (parsedDate.isValid()) {
                    // Store internally as YYYY-MM-DD for the input element
                    this.selectedDate = parsedDate.format('YYYY-MM-DD');
                } else {
                    this.selectedDate = moment().format('YYYY-MM-DD');
                }
            } else {
                this.selectedDate = moment().format('YYYY-MM-DD');
            }
        } catch (e) {
            console.error('Error parsing date:', e);
            this.selectedDate = moment().format('YYYY-MM-DD');
        }
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('date-selector-modal');
        contentEl.createEl('h2', { text: 'Select a Date' });

        const dateInput = contentEl.createEl('input', { 
            type: 'date', 
            cls: 'date-selector-input'
        });
        dateInput.value = this.selectedDate;

        dateInput.addEventListener('change', (evt) => {
            this.selectedDate = (evt.target as HTMLInputElement).value;
        });

        contentEl.createEl('div', { cls: 'date-selector-spacing' });

        new Setting(contentEl)
            .addButton((btn) =>
                btn
                    .setButtonText('Confirm Date')
                    .setCta()
                    .onClick(() => {
                        if (!this.selectedDate) {
                            console.error("No date selected");
                            return;
                        }
                        this.close();
                        
                        // Format the date according to settings
                        const formattedDate = moment(this.selectedDate).format(this.outputFormat);
                        this.onSubmit(formattedDate);
                    }));

        // Focus the date input
        dateInput.focus();
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

