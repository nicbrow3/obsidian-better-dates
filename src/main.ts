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

// Interface for our suggestion item
interface DateSuggestion {
    label: string;
    isDate?: boolean; // Flag to indicate if this is a parsed date suggestion
    dateValue?: string; // Store the raw date value for insertion
}

// Add settings interface
interface DateSelectorSettings {
    dateFormat: string;
    enableClickDates: boolean;
    enableAtSuggest: boolean;
    debugLogging: boolean;
    useCustomCalendar: boolean; // New setting
}

const DEFAULT_SETTINGS: DateSelectorSettings = {
    dateFormat: 'MM/DD/YY',
    enableClickDates: true,
    enableAtSuggest: true,
    debugLogging: false,
    useCustomCalendar: false, // Default to false
};

// The main plugin class
export default class DateSelectorPlugin extends Plugin {
    settings: DateSelectorSettings;
    debugLog(...args: any[]) {
        if (this.settings?.debugLogging) {
            // eslint-disable-next-line no-console
            console.log('[DateSelector]', ...args);
        }
    }
    async onload() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        this.addSettingTab(new DateSelectorSettingTab(this.app, this));

        this.debugLog('Loading Date Selector Plugin (@ Trigger)');
        if (this.settings.enableAtSuggest) {
            this.registerEditorSuggest(new DateSuggester(this.app, this));
        }
        if (this.settings.enableClickDates) {
            this.registerDomEvent(document, 'click', this.handleClickEvent.bind(this), { capture: true });
            this.debugLog('Click listener registered');
        }
        this.debugLog('Date Selector Plugin (@ Trigger) Loaded');
    }

    onunload() {
        this.debugLog('Unloading Date Selector Plugin (@ Trigger)');
    }

    // Helper function to open the modal, used by suggester and command
    openDateModal(editor: Editor, initialDateYYYYMMDD: string | null, replaceStart: EditorPosition, replaceEnd: EditorPosition) {
        new DateSelectorModal(this.app, initialDateYYYYMMDD, (newDateYYYYMMDD) => {
            // Format the result from the modal into the chosen format and add a space after
            let formattedDate = moment(newDateYYYYMMDD, 'YYYY-MM-DD').format(this.settings.dateFormat);
            // Add asterisks if the format doesn't already include them
            if (!/^\*.*\*$/.test(formattedDate)) {
                formattedDate = `*${formattedDate}*`;
            }
            editor.replaceRange(formattedDate + ' ', replaceStart, replaceEnd);
        }).open();
    }


    async handleClickEvent(evt: MouseEvent) {
        const target = evt.target as HTMLElement;
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);

        if (!view || !target) return;

        const isEditorClick = target.closest('.cm-editor') !== null;

        if (isEditorClick) {
            const editor = view.editor;
            // @ts-ignore - Access internal CM6 editor instance
            const cmEditor = editor.cm;
            if (!cmEditor) {
                console.error("Date Selector Plugin: Could not access internal CM editor instance.");
                return;
            }

            try { // Add try-catch for safety
                const coords = { x: evt.clientX, y: evt.clientY };
                // Get the character offset position from coordinates
                // This internal method might return null or just an offset number
                const offset = cmEditor.posAtCoords(coords);
                this.debugLog("Date Selector Plugin: Click offset:", offset); // Log the raw value

                if (offset === null || offset === undefined) { // Check if offset is invalid
                    this.debugLog("Date Selector Plugin: Click position not found in editor.");
                    return;
                }

                // Convert the offset to a {line, ch} position using the public API
                const pos = editor.offsetToPos(offset);
                this.debugLog("Date Selector Plugin: Click position (line, ch):", pos); // Log the position

                // Verify the position object
                if (!pos || typeof pos.line !== 'number' || typeof pos.ch !== 'number') {
                    console.error("Date Selector Plugin: Invalid position object derived from offset:", pos);
                    return;
                }

                // Now safely get the line content
                const line = editor.getLine(pos.line);
                if (line === undefined) { // Add check for getLine returning undefined
                    console.error(`Date Selector Plugin: Could not get line content for line ${pos.line}`);
                    return;
                }

                const { foundDate, start, end } = this.findDateAtPosition(line, pos.ch);

                if (foundDate) {
                    this.debugLog(`Date Selector Plugin: Found date "${foundDate}" at [${start}-${end}] on line ${pos.line}`);
                    evt.preventDefault();
                    evt.stopPropagation();

                    // Convert MM/DD/YY back to YYYY-MM-DD for the modal
                    const initialDate = moment(foundDate, 'MM/DD/YY').format('YYYY-MM-DD');
                    this.openDateModal(editor, initialDate, { line: pos.line, ch: start }, { line: pos.line, ch: end });
                } else {
                    this.debugLog("Date Selector Plugin: No date found at click position.");
                }
            } catch (error) {
                console.error("Date Selector Plugin: Error during click handling:", error);
                // Consider adding a user-facing notice if this becomes common
                // new Notice("Date Selector Plugin: Error handling click.");
            }
        }
    }

   findDateAtPosition(line: string, ch: number): { foundDate: string | null, start: number, end: number } {
        // Regex for any asterisk-wrapped date string (greedy, but we'll validate with moment)
        const dateRegex = /\*([^*]+)\*/g;
        let match;

        // Supported formats (should match those in settings)
        const supportedFormats = [
            'MM/DD/YY', 'MM-DD-YY', 'YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY',
            'MMM D, YYYY', 'MMMM D, YYYY', 'MMM D, YY', 'MMMM D, YY'
        ];

        while ((match = dateRegex.exec(line)) !== null) {
            const start = match.index; // Start of the '*'
            const end = start + match[0].length; // End of the '*'
            const datePart = match[1];

            // Check if the click position (ch) is within this date match
            if (ch >= start && ch <= end) {
                // Validate the date part with moment against supported formats
                const parsed = moment(datePart, supportedFormats, true);
                if (parsed.isValid()) {
                    return {
                        foundDate: datePart, // Return the date part (without asterisks)
                        start: start,
                        end: end
                    };
                }
            }
        }

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

    onTrigger(
        cursor: EditorPosition,
        editor: Editor,
        file: TFile | null
    ): EditorSuggestTriggerInfo | null {
        const currentLine = editor.getLine(cursor.line);
        const sub = currentLine.substring(0, cursor.ch);
        this.plugin.debugLog(`DateSuggester: onTrigger: sub = "${sub}"`);

        const triggerCharPos = sub.lastIndexOf('@');

        if (triggerCharPos === -1) {
            this.plugin.debugLog("DateSuggester: onTrigger: '@' not found before cursor.");
            return null;
        }

        if (sub.length > triggerCharPos + 1 && sub[triggerCharPos + 1] === ' ') {
            this.plugin.debugLog("DateSuggester: onTrigger: Space found immediately after '@'.");
            return null;
        }

        const query = sub.substring(triggerCharPos + 1);

        // Check if a completed date (*MM/DD/YY*) appears after the last @ and before the cursor
        const completedDateRegex = /^\*(\d{1,2}\/\d{1,2}\/\d{2})\*/;
        if (completedDateRegex.test(query.trim())) {
            // There is a completed date after the last @, so do not suggest
            return null;
        }

        this.plugin.debugLog(`DateSuggester: onTrigger: sub = "${sub}"`);

        let finalQuery = query; // Default to raw query

        // ONLY Try strict parsing
        const strictParsedDate = moment(query, [
            'M/D/YY', 'MM/DD/YY', 'M-D-YY', 'MM-DD-YY',
            'M/D/YYYY', 'MM/DD/YYYY', 'M-D-YYYY', 'MM-DD-YYYY',
            'YYYY-MM-DD',
            'MMM D YY', 'MMM D YYYY',
            'MMMM D YY', 'MMMM D YYYY'
        ], true);

        if (strictParsedDate.isValid()) {
            this.plugin.debugLog(`DateSuggester: onTrigger: Strict parse succeeded for "${query}"`);
            finalQuery = strictParsedDate.format('*MM/DD/YY*');
        } else {
            // Try to match partial date (month-day or month/day)
            const partialDateMatch = query.match(/^(\d{1,2})[\/-](\d{1,2})$/);
            if (partialDateMatch) {
                const currentYear = moment().year();
                // Try parsing with current year
                const paddedMonth = partialDateMatch[1].padStart(2, '0');
                const paddedDay = partialDateMatch[2].padStart(2, '0');
                const fullDateStr = `${paddedMonth}/${paddedDay}/${currentYear}`;
                const parsed = moment(fullDateStr, 'MM/DD/YYYY', true);
                if (parsed.isValid()) {
                    finalQuery = parsed.format('*MM/DD/YY*');
                    this.plugin.debugLog(`DateSuggester: onTrigger: Partial date parse succeeded for "${query}" as "${finalQuery}"`);
                } else {
                    this.plugin.debugLog(`DateSuggester: onTrigger: Partial date parse failed for "${query}"`);
                }
            } else {
                this.plugin.debugLog(`DateSuggester: onTrigger: Strict parsing failed for "${query}". Passing raw query.`);
            }
        }

        const triggerInfo = {
            start: { line: cursor.line, ch: triggerCharPos },
            end: cursor,
            query: finalQuery // Pass formatted date or raw query
        };

        this.plugin.debugLog(`DateSuggester: onTrigger: returning triggerInfo =`, triggerInfo);
        return triggerInfo;
    }

     getSuggestions(
        context: EditorSuggestContext
    ): DateSuggestion[] | Promise<DateSuggestion[]> {
        const query = context.query;
        const suggestions: DateSuggestion[] = [];
        this.plugin.debugLog(`DateSuggester: getSuggestions: context.query = "${query}"`);

        // Case 1: Query is formatted (successfully parsed by onTrigger)
        if (query.startsWith('*') && query.endsWith('*')) {
            suggestions.push({ label: `Insert date: ${query}`, isDate: true, dateValue: query });
            this.plugin.debugLog("DateSuggester: getSuggestions (Case 1): Suggesting pre-parsed date:", suggestions);
        }
        // Case 2: Query is raw text (parsing failed in onTrigger)
        // No further parsing attempt here.

        // Always add the option to insert today's date if the query is empty (i.e., just '@')
        if (!query.trim()) {
            const todayRaw = moment().format(this.plugin.settings.dateFormat); // No asterisks for label
            let todayInsert = todayRaw;
            if (!/^\*.*\*$/.test(todayInsert)) {
                todayInsert = `*${todayInsert}*`;
            }
            suggestions.push({ label: `Today: ${todayRaw}`, isDate: true, dateValue: todayInsert });
        }

        // Always add the option to pick a date manually
        suggestions.push({ label: 'Pick a date...', isDate: false });
        this.plugin.debugLog("DateSuggester: getSuggestions (Final): Returning suggestions:", suggestions);
        return suggestions;
    }

    renderSuggestion(suggestion: DateSuggestion, el: HTMLElement): void {
        el.setText(suggestion.label);
    }

    selectSuggestion(
        suggestion: DateSuggestion,
        evt: MouseEvent | KeyboardEvent
    ): void {
        const editor = this.context?.editor;
        const startPos = this.context?.start;
        const endPos = this.context?.end;

        if (!editor || !startPos || !endPos) {
            console.error("Editor context not available in selectSuggestion");
            return;
        }

        this.close(); // Close the suggestion popup

        if (suggestion.isDate && suggestion.dateValue) {
            // Insert the formatted date directly, with a space after
            const dateWithSpace = suggestion.dateValue + ' ';
            editor.replaceRange(dateWithSpace, startPos, endPos);
             // Move cursor after the inserted date and space
            const newCursorPos = { line: startPos.line, ch: startPos.ch + dateWithSpace.length };
            editor.setCursor(newCursorPos);
        } else {
            // Open the date picker modal
            // Pass the original start/end of the trigger ('@' plus any typed text)
             this.plugin.openDateModal(editor, null, startPos, endPos);
        }
    }
}


// --- Date Selector Modal ---
class DateSelectorModal extends Modal {
    initialDateYYYYMMDD: string | null; // Expects YYYY-MM-DD or null
    onSubmit: (resultYYYYMMDD: string) => void; // Returns YYYY-MM-DD
    selectedDateYYYYMMDD: string; // Store the picked date internally as YYYY-MM-DD

    constructor(app: App, initialDateYYYYMMDD: string | null, onSubmit: (resultYYYYMMDD: string) => void) {
        super(app);
        this.initialDateYYYYMMDD = initialDateYYYYMMDD;
        this.onSubmit = onSubmit;

        // Use initial date if provided and valid, otherwise default to today
        this.selectedDateYYYYMMDD = moment(this.initialDateYYYYMMDD, 'YYYY-MM-DD', true).isValid()
            ? this.initialDateYYYYMMDD!
            : moment().format('YYYY-MM-DD'); // Default to today if invalid/null
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('date-selector-modal');
        contentEl.createEl('h2', { text: 'Select a Date' });

        const plugin = (this.app as any).plugins.plugins['obsidian-date-selector'] as DateSelectorPlugin | undefined;
        const useCustomCalendar = plugin?.settings?.useCustomCalendar;

        if (useCustomCalendar) {
            // --- Custom Calendar UI ---
            const calendarContainer = contentEl.createEl('div', { cls: 'custom-calendar-container' });
            let currentMonth = moment(this.selectedDateYYYYMMDD, 'YYYY-MM-DD', true).isValid()
                ? moment(this.selectedDateYYYYMMDD, 'YYYY-MM-DD')
                : moment();
            let focusedDate = moment(this.selectedDateYYYYMMDD, 'YYYY-MM-DD', true).isValid()
                ? moment(this.selectedDateYYYYMMDD, 'YYYY-MM-DD')
                : moment();

            // Show selected date in header
            const selectedDateHeader = contentEl.createEl('div', { cls: 'calendar-selected-date-header' });
            const updateSelectedDateHeader = () => {
                selectedDateHeader.setText('Selected: ' + moment(this.selectedDateYYYYMMDD, 'YYYY-MM-DD').format('MMM D, YYYY'));
            };
            updateSelectedDateHeader();

            const renderCalendar = () => {
                calendarContainer.empty();
                // Header with month and year, and navigation
                const header = calendarContainer.createEl('div', { cls: 'calendar-header' });
                const prevBtn = header.createEl('button', { text: '<', cls: 'calendar-nav-btn' });
                const monthYear = header.createEl('span', { text: currentMonth.format('MMMM YYYY'), cls: 'calendar-month-year' });
                const nextBtn = header.createEl('button', { text: '>', cls: 'calendar-nav-btn' });

                prevBtn.onclick = () => {
                    currentMonth = currentMonth.clone().subtract(1, 'month');
                    renderCalendar();
                };
                nextBtn.onclick = () => {
                    currentMonth = currentMonth.clone().add(1, 'month');
                    renderCalendar();
                };

                // Days of week
                const daysRow = calendarContainer.createEl('div', { cls: 'calendar-days-row' });
                const daysShort = moment.weekdaysShort();
                daysShort.forEach(day => {
                    daysRow.createEl('span', { text: day, cls: 'calendar-day-label' });
                });

                // Dates grid as table-like rows (7 columns per week)
                const datesGrid = calendarContainer.createEl('div', { cls: 'calendar-dates-grid' });
                const startOfMonth = currentMonth.clone().startOf('month');
                const endOfMonth = currentMonth.clone().endOf('month');
                const startDay = startOfMonth.day();
                const daysInMonth = currentMonth.daysInMonth();

                // Calculate the first day to display (may be in previous month)
                let gridStart = startOfMonth.clone().subtract(startDay, 'days');
                // Calculate the total number of days to display (6 weeks max, 42 days)
                let totalDays = 42;

                for (let week = 0; week < 6; week++) {
                    const weekRow = datesGrid.createEl('div', { cls: 'calendar-week-row' });
                    for (let day = 0; day < 7; day++) {
                        const date = gridStart.clone().add(week * 7 + day, 'days');
                        const dateStr = date.format('YYYY-MM-DD');
                        const isCurrentMonth = date.month() === currentMonth.month();
                        const dateBtn = weekRow.createEl('button', { text: String(date.date()), cls: 'calendar-date-btn' });
                        if (!isCurrentMonth) {
                            dateBtn.addClass('calendar-date-outside');
                        }
                        if (dateStr === this.selectedDateYYYYMMDD) {
                            dateBtn.addClass('calendar-date-selected');
                        }
                        if (date.isSame(moment(), 'day')) {
                            dateBtn.addClass('calendar-date-today');
                        }
                        if (dateStr === focusedDate.format('YYYY-MM-DD')) {
                            dateBtn.addClass('calendar-date-focused');
                        }
                        dateBtn.onclick = () => {
                            // Only re-render if the month changes
                            if (!date.isSame(currentMonth, 'month')) {
                                currentMonth = date.clone();
                                renderCalendar();
                            }
                            // Always update selected date and header
                            this.selectedDateYYYYMMDD = dateStr;
                            focusedDate = date.clone();
                            updateSelectedDateHeader();
                            // Visually highlight selection (handled by re-render if month changed)
                        };
                    }
                }
            };
            renderCalendar();

            // Keyboard navigation
            const handleKeyDown = (evt: KeyboardEvent) => {
                let handled = false;
                if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(evt.key)) {
                    let newFocus = focusedDate.clone();
                    if (evt.key === 'ArrowLeft') newFocus.subtract(1, 'day');
                    if (evt.key === 'ArrowRight') newFocus.add(1, 'day');
                    if (evt.key === 'ArrowUp') newFocus.subtract(7, 'day');
                    if (evt.key === 'ArrowDown') newFocus.add(7, 'day');
                    if (!newFocus.isSame(currentMonth, 'month')) {
                        currentMonth = newFocus.clone();
                    }
                    focusedDate = newFocus;
                    renderCalendar();
                    handled = true;
                } else if (evt.key === 'Enter') {
                    this.selectedDateYYYYMMDD = focusedDate.format('YYYY-MM-DD');
                    updateSelectedDateHeader();
                    renderCalendar();
                    handled = true;
                } else if (evt.key === 'Escape') {
                    this.close();
                    handled = true;
                }
                if (handled) {
                    evt.preventDefault();
                    evt.stopPropagation();
                }
            };
            this.scope.register([], 'ArrowLeft', handleKeyDown);
            this.scope.register([], 'ArrowRight', handleKeyDown);
            this.scope.register([], 'ArrowUp', handleKeyDown);
            this.scope.register([], 'ArrowDown', handleKeyDown);
            this.scope.register([], 'Enter', handleKeyDown);
            this.scope.register([], 'Escape', handleKeyDown);

            // Minimal styles for clarity and polish
            const style = document.createElement('style');
            style.textContent = `
                .custom-calendar-container { margin: 2em 0 1em 0; padding: 0.5em 1em 1em 1em; min-width: 420px; min-height: 340px; display: flex; flex-direction: column; align-items: center; }
                .calendar-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.2em; width: 100%; }
                .calendar-nav-btn { background: none; border: none; font-size: 1.6em; cursor: pointer; padding: 0 0.7em; color: #b3aaff; transition: color 0.15s; }
                .calendar-nav-btn:hover { color: #a48cff; }
                .calendar-month-year { font-weight: bold; font-size: 1.3em; letter-spacing: 0.02em; color: #fff; }
                .calendar-selected-date-header { margin-bottom: 1em; font-size: 1.1em; color: #6d7cff; width: 100%; text-align: left; }
                .calendar-days-row { display: flex; justify-content: space-between; margin-bottom: 0.3em; width: 100%; }
                .calendar-day-label { width: 2.8em; height: 2.2em; text-align: center; font-size: 1.1em; color: #b3b3c6; font-weight: 600; letter-spacing: 0.01em; display: flex; align-items: center; justify-content: center; }
                .calendar-dates-grid { display: flex; flex-direction: column; width: 100%; }
                .calendar-week-row { display: flex; width: 100%; }
                .calendar-date-blank { width: 2.8em; height: 2.8em; }
                .calendar-date-btn { width: 2.8em; height: 2.8em; margin: 2px; border: none; border-radius: 8px; background: none; cursor: pointer; transition: background 0.15s, color 0.15s, box-shadow 0.15s; font-size: 1.1em; color: #e3e3f7; font-weight: 500; display: flex; align-items: center; justify-content: center; }
                .calendar-date-btn:hover, .calendar-date-btn:focus { background: #e3f0ff22; color: #a48cff; outline: none; box-shadow: 0 0 0 2px #a48cff55; }
                .calendar-date-selected { background: #a48cff; color: #fff; font-weight: 700; }
                .calendar-date-today { border: 2px solid #a48cff; }
                .calendar-date-focused { box-shadow: 0 0 0 2px #a48cff99; }
                .calendar-date-outside { color: #bbb; background: #23232b; filter: brightness(0.85); }
            `;
            contentEl.appendChild(style);
        } else {
            const dateInput = contentEl.createEl('input', { type: 'date', cls: 'date-selector-input' });
            dateInput.value = this.selectedDateYYYYMMDD; // Use YYYY-MM-DD for input

            dateInput.addEventListener('change', (evt) => {
                // Keep storing as YYYY-MM-DD
                this.selectedDateYYYYMMDD = (evt.target as HTMLInputElement).value;
            });
        }

        contentEl.createEl('div', { attr: { style: 'margin-top: 1rem;' } });

        new Setting(contentEl)
            .addButton((btn) =>
                btn
                    .setButtonText('Confirm Date')
                    .setCta()
                    .onClick(() => {
                        // Basic validation: HTML5 date input usually ensures a valid format
                        if (!this.selectedDateYYYYMMDD || !moment(this.selectedDateYYYYMMDD, 'YYYY-MM-DD', true).isValid()) {
                            console.error("Invalid date selected in modal:", this.selectedDateYYYYMMDD);
                            // Optionally show a notice to the user here
                            return;
                        }
                        this.close();
                        // Submit the selected date in YYYY-MM-DD format
                        this.onSubmit(this.selectedDateYYYYMMDD);
                    }));

        setTimeout(() => {
            const input = contentEl.querySelector('input.date-selector-input') as HTMLInputElement;
            if (input) input.focus();
        }, 50);
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// Add the settings tab class
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
            .setDesc('Choose the format for inserted dates.')
            .addDropdown(drop => drop
                .addOption('MM/DD/YY', '02/25/25')
                .addOption('MM-DD-YY', '02-25-25')
                .addOption('YYYY-MM-DD', '2025-02-25')
                .addOption('DD/MM/YYYY', '25/02/2025')
                .addOption('MM/DD/YYYY', '02/25/2025')
                .addOption('MMM D, YYYY', 'Feb 25, 2025')
                .addOption('MMMM D, YYYY', 'February 25, 2025')
                .setValue(this.plugin.settings.dateFormat)
                .onChange(async (value) => {
                    this.plugin.settings.dateFormat = value;
                    await this.plugin.saveData(this.plugin.settings);
                })
            );
        new Setting(containerEl)
            .setName('Enable clicking on dates')
            .setDesc('Allow clicking on formatted dates in the editor to update them.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableClickDates)
                .onChange(async (value) => {
                    this.plugin.settings.enableClickDates = value;
                    await this.plugin.saveData(this.plugin.settings);
                    this.display();
                })
            );
        // Add reload note in red
        containerEl.createEl('div', {
            text: 'Requires plugin reload to take effect.',
            attr: { style: 'color: #d43a3a; margin-bottom: 1em; font-size: 0.95em;' }
        });
        new Setting(containerEl)
            .setName('Enable @ date suggestions')
            .setDesc('Show date suggestions when typing @ in the editor.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableAtSuggest)
                .onChange(async (value) => {
                    this.plugin.settings.enableAtSuggest = value;
                    await this.plugin.saveData(this.plugin.settings);
                    this.display();
                })
            );
        // Add reload note in red
        containerEl.createEl('div', {
            text: 'Requires plugin reload to take effect.',
            attr: { style: 'color: #d43a3a; margin-bottom: 1.5em; font-size: 0.95em;' }
        });
        new Setting(containerEl)
            .setName('Use custom calendar UI')
            .setDesc('Use a custom calendar UI for date picking (Notion-style).')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.useCustomCalendar)
                .onChange(async (value) => {
                    this.plugin.settings.useCustomCalendar = value;
                    await this.plugin.saveData(this.plugin.settings);
                })
            );
        new Setting(containerEl)
            .setName('Debug logging')
            .setDesc('Enable debug logging to the console for troubleshooting.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.debugLogging)
                .onChange(async (value) => {
                    this.plugin.settings.debugLogging = value;
                    await this.plugin.saveData(this.plugin.settings);
                })
            );
    }
} 