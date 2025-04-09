import {
    App,
    Editor,
    EditorPosition,
    EditorSuggest,
    EditorSuggestContext,
    EditorSuggestTriggerInfo,
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
}

const DEFAULT_SETTINGS: DateSelectorSettings = {
    outputFormat: 'MM/DD/YYYY' // Default to US format
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

// The main plugin class
export default class DateSelectorPlugin extends Plugin {
    settings: DateSelectorSettings;

    async onload() {
        console.log('Loading Date Selector Plugin');
        
        // Load settings first
        await this.loadSettings();

        // Add the settings tab
        this.addSettingTab(new DateSelectorSettingTab(this.app, this));

        // Register the EditorSuggest component for @ trigger
        this.registerEditorSuggest(new DateSuggester(this.app, this));

        // Command for Manual Trigger
        this.addCommand({
            id: 'insert-update-date-command',
            name: 'Insert or Update Date (Command)',
            editorCallback: (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
                const selectedText = editor.getSelection();
                this.openDateModal(editor, selectedText || null, editor.getCursor(), editor.getCursor());
            }
        });

        // Register click handler for dates in the document
        this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
            console.log('Click event detected');
            const target = evt.target as HTMLElement;
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);

            if (!view || !target) {
                console.log('No view or target found', { hasView: !!view, hasTarget: !!target });
                return;
            }

            const isEditorClick = target.closest('.cm-editor') !== null;
            console.log('Is editor click:', isEditorClick, 'Target:', target.tagName, target.className);

            if (isEditorClick) {
                const editor = view.editor;
                console.log('Got editor instance');
                
                try {
                    // Get the clicked element's text content
                    const clickedText = target.textContent || '';
                    console.log('Clicked element text:', clickedText);

                    // If we didn't click directly on text, don't proceed
                    if (!clickedText.trim()) {
                        console.log('No text content in clicked element');
                        return;
                    }

                    // Get the position from the editor's coordinate system
                    const cursor = editor.getCursor();
                    const pos = editor.posToOffset(cursor);
                    if (pos === null) {
                        console.log('Could not get position offset');
                        return;
                    }

                    const linePos = editor.offsetToPos(pos);
                    const line = editor.getLine(linePos.line);
                    
                    // Find the date in the clicked text first
                    const { foundDate, start, end } = this.findDateAtPosition(clickedText, clickedText.length/2);
                    console.log('Date search in clicked element:', { foundDate, start, end });

                    if (foundDate && clickedText.includes(foundDate)) {
                        console.log('Found date in clicked element, opening modal');
                        evt.preventDefault();
                        evt.stopPropagation();

                        // Find where this date is in the actual line
                        const dateStart = line.indexOf(foundDate);
                        if (dateStart >= 0) {
                            this.openDateModal(editor, foundDate, 
                                { line: linePos.line, ch: dateStart }, 
                                { line: linePos.line, ch: dateStart + foundDate.length }
                            );
                        }
                    }
                } catch (error) {
                    console.error('Error in click handler:', error);
                }
            }
        });

        console.log('Date Selector Plugin Loaded');
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
        new DateSelectorModal(this.app, currentDateString, this.settings.outputFormat, (newDate) => {
            editor.replaceRange(newDate, replaceStart, replaceEnd);
        }).open();
    }

    // Helper function to find a date at a given position in text
    findDateAtPosition(line: string, ch: number): { foundDate: string | null, start: number, end: number } {
        console.log('Finding date in line:', line, 'at position:', ch);
        
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
            console.log('Trying format:', format);
            const matches = Array.from(line.matchAll(new RegExp(format, 'g')));
            
            for (const match of matches) {
                const start = match.index!;
                const end = start + match[0].length;
                console.log('Found match:', { match: match[0], start, end, cursorAt: ch });
                
                if (ch >= start && ch <= end) {
                    console.log('Cursor is within match');
                    return { foundDate: match[0], start, end };
                }
            }
        }
        
        console.log('No date found at cursor position');
        return { foundDate: null, start: -1, end: -1 };
    }
}

// The EditorSuggest class to handle the '@' trigger
class DateSuggester extends EditorSuggest<DateSuggestion> {
    plugin: DateSelectorPlugin;

    constructor(app: App, plugin: DateSelectorPlugin) {
        super(app);
        this.plugin = plugin;
    }

    onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
        const currentLine = editor.getLine(cursor.line);
        const currentPos = cursor.ch;

        // Check if we just typed '@' or if we're right after an '@'
        if (currentLine[currentPos - 1] === '@') {
            return {
                start: { line: cursor.line, ch: currentPos - 1 },
                end: { line: cursor.line, ch: currentPos },
                query: '',
            };
        }

        // Also check if we're somewhere after an '@' (for when backspacing or moving cursor)
        const beforeCursor = currentLine.substring(0, currentPos);
        const lastAtPos = beforeCursor.lastIndexOf('@');
        if (lastAtPos >= 0) {
            return {
                start: { line: cursor.line, ch: lastAtPos },
                end: { line: cursor.line, ch: currentPos },
                query: beforeCursor.substring(lastAtPos + 1),
            };
        }

        return null;
    }

    getSuggestions(context: EditorSuggestContext): DateSuggestion[] {
        return [{ label: 'Pick a date...' }];
    }

    renderSuggestion(suggestion: DateSuggestion, el: HTMLElement): void {
        el.setText(suggestion.label);
    }

    selectSuggestion(suggestion: DateSuggestion, evt: MouseEvent | KeyboardEvent): void {
        const editor = this.context?.editor;
        const startPos = this.context?.start;
        const endPos = this.context?.end;

        if (!editor || !startPos || !endPos) {
            console.error("Editor context not available in selectSuggestion");
            return;
        }

        this.close();
        this.plugin.openDateModal(editor, null, startPos, endPos);
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
                // Add all format options
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
            
            if (this.currentDateString) {
                // Try to parse with moment using multiple formats
                const parsedDate = moment(this.currentDateString, formats, true);
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

        console.log('Creating date input...');
        const dateInput = contentEl.createEl('input', { 
            type: 'date', 
            cls: 'date-selector-input'
        });
        dateInput.value = this.selectedDate;
        console.log('Date input created:', dateInput);

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
                        // Use the selected format from settings
                        const formattedDate = moment(this.selectedDate).format(this.outputFormat);
                        this.onSubmit(formattedDate);
                    }));

        // Focus and open date picker with multiple attempts
        setTimeout(() => {
            console.log('Initial timeout fired');
            dateInput.focus();
            console.log('Input focused');

            // Try multiple selectors to find the calendar button
            const selectors = [
                '[title="show date picker"]',
                'input[type="date"]::-webkit-calendar-picker-indicator',
                '.calendar-button',
                'button.date-picker-button'
            ];

            console.log('Trying to find calendar button...');
            let calendarButton = null;

            for (const selector of selectors) {
                console.log('Trying selector:', selector);
                const element = dateInput.parentElement?.querySelector(selector);
                if (element) {
                    console.log('Found button with selector:', selector);
                    calendarButton = element;
                    break;
                }
            }

            if (calendarButton) {
                console.log('Calendar button found, attempting to click');
                try {
                    (calendarButton as HTMLElement).click();
                    console.log('Click attempted');
                } catch (e) {
                    console.error('Error clicking calendar button:', e);
                }
            } else {
                console.log('No calendar button found with any selector');
                // Try alternative approach - simulate keyboard event
                console.log('Trying keyboard event...');
                dateInput.dispatchEvent(new KeyboardEvent('keydown', { 
                    key: 'ArrowDown',
                    code: 'ArrowDown',
                    keyCode: 40,
                    which: 40,
                    altKey: true,
                    bubbles: true
                }));
            }
        }, 200); // Increased timeout
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
