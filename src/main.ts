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
        new DateSelectorModal(this, this.app, initialDateYYYYMMDD, (newDateYYYYMMDD) => {
            // Format the result from the modal into the chosen format and add a space after
            let formattedDate = moment(newDateYYYYMMDD, 'YYYY-MM-DD').format(this.settings.dateFormat);
            // Add asterisks if the format doesn't already include them
            if (!/^\*.*\*$/.test(formattedDate)) {
                formattedDate = `*${formattedDate}*`;
            }
            
            // Check if there's already a space after the insertion point
            const line = editor.getLine(replaceEnd.line);
            const hasSpaceAfter = line.length > replaceEnd.ch && line[replaceEnd.ch] === ' ';
            
            const dateWithSpace = formattedDate + (hasSpaceAfter ? '' : ' ');
            editor.replaceRange(dateWithSpace, replaceStart, replaceEnd);
            
            // Set cursor position after the date and space (one more character to the right)
            const newCursorPos = { 
                line: replaceStart.line, 
                // When editing, ensure cursor is after the space, not on it
                ch: replaceStart.ch + dateWithSpace.length + (hasSpaceAfter ? 1 : 0)
            };
            editor.setCursor(newCursorPos);
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
                    
                    // Create exact position to ensure cursor positioning works properly when editing
                    const replaceStart = { line: pos.line, ch: start };
                    const replaceEnd = { line: pos.line, ch: end };
                    
                    this.openDateModal(editor, initialDate, replaceStart, replaceEnd);
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
            
            // Calculate the bounds of just the date text itself (excluding asterisks completely)
            const dateTextStart = start + 1;  // Position immediately after the first asterisk
            const dateTextEnd = end - 1;      // Position immediately before the last asterisk

            // Check if the click position (ch) is strictly within the date text only
            // This will be very restrictive - must click directly on the date text
            if (ch > dateTextStart && ch < dateTextEnd) {
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

        // Cancel suggestion if query exceeds 20 characters as it's likely not a date
        if (query.length > 20) {
            this.plugin.debugLog(`DateSuggester: onTrigger: Query exceeds 20 characters (${query.length}), canceling suggestion.`);
            return null;
        }

        // Cancel suggestion if query contains more than 2 spaces (no date format has more than 2 spaces)
        const spaceCount = (query.match(/ /g) || []).length;
        if (spaceCount > 2) {
            this.plugin.debugLog(`DateSuggester: onTrigger: Query contains more than 2 spaces (${spaceCount}), canceling suggestion.`);
            return null;
        }

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
            // Try to match month day year abbreviation pattern (e.g., "sep 02 23" or "sep 2 2023")
            const monthDayYearPattern = /^([a-zA-Z]+)\s+(\d{1,2})\s+(\d{2}|\d{4})$/i;
            const monthDayYearMatch = query.match(monthDayYearPattern);

            if (monthDayYearMatch) {
                // Handle Month Day YY / YYYY
                const monthText = monthDayYearMatch[1].toLowerCase();
                const day = parseInt(monthDayYearMatch[2], 10);
                let year = parseInt(monthDayYearMatch[3], 10);
                if (monthDayYearMatch[3].length === 2) year += 2000;

                const monthMap: {[key: string]: number} = { 'jan': 1, 'january': 1, 'feb': 2, 'february': 2, 'mar': 3, 'march': 3, 'apr': 4, 'april': 4, 'may': 5, 'jun': 6, 'june': 6, 'jul': 7, 'july': 7, 'aug': 8, 'august': 8, 'sep': 9, 'sept': 9, 'september': 9, 'oct': 10, 'october': 10, 'nov': 11, 'november': 11, 'dec': 12, 'december': 12 };
                let monthNum = -1;
                // Find the best match (prefer exact match over prefix)
                let bestMatchKey = "";
                for (const key in monthMap) {
                    if (monthText === key) { // Exact match
                        bestMatchKey = key;
                        break;
                    } else if (monthText.startsWith(key) && key.length > bestMatchKey.length) { // Prefix match
                        bestMatchKey = key;
                    }
                }
                if (bestMatchKey) {
                    monthNum = monthMap[bestMatchKey];
                }

                if (monthNum > 0 && day >= 1 && day <= 31 && year > 1900) {
                    const dateObj = moment({ year: year, month: monthNum - 1, day: day });
                    if (dateObj.isValid()) {
                        let formattedDate = dateObj.format(this.plugin.settings.dateFormat);
                        if (!/^\*.*\*$/.test(formattedDate)) formattedDate = `*${formattedDate}*`;
                        finalQuery = formattedDate;
                        this.plugin.debugLog(`MDY parse succeeded: "${query}" -> "${finalQuery}"`);
                    } else { this.plugin.debugLog(`MDY constructed invalid date: "${query}"`); }
                } else { this.plugin.debugLog(`MDY parse failed (invalid parts): "${query}"`); }
            
            } else { // Not Month Day YY / YYYY, try Month Day Y
                 const monthDaySingleDigitYearPattern = /^([a-zA-Z]+)\s+(\d{1,2})\s+(\d{1})$/i;
                 const monthDaySingleDigitYearMatch = query.match(monthDaySingleDigitYearPattern);

                 if (monthDaySingleDigitYearMatch) {
                     // Handle Month Day Y (only if digit matches current year's last digit)
                     const monthText = monthDaySingleDigitYearMatch[1].toLowerCase();
                     const day = parseInt(monthDaySingleDigitYearMatch[2], 10);
                     const yearDigit = parseInt(monthDaySingleDigitYearMatch[3], 10);
                     const currentMoment = moment();
                     const currentYear = currentMoment.year();
                     const lastDigitCurrentYear = currentYear % 10;

                     if (yearDigit === lastDigitCurrentYear) {
                         const targetYear = currentYear;
                         this.plugin.debugLog(`MDY(1) matched current year: ${yearDigit}=>${targetYear}`);
                         const monthMap: {[key: string]: number} = { 'jan': 1, 'january': 1, 'feb': 2, 'february': 2, 'mar': 3, 'march': 3, 'apr': 4, 'april': 4, 'may': 5, 'jun': 6, 'june': 6, 'jul': 7, 'july': 7, 'aug': 8, 'august': 8, 'sep': 9, 'sept': 9, 'oct': 10, 'nov': 11, 'dec': 12 };
                         let monthNum = -1;
                         // Find the best match (prefer exact match over prefix)
                         let bestMatchKey = "";
                         for (const key in monthMap) {
                             if (monthText === key) { // Exact match
                                 bestMatchKey = key;
                                 break;
                             } else if (monthText.startsWith(key) && key.length > bestMatchKey.length) { // Prefix match
                                 bestMatchKey = key;
                             }
                         }
                         if (bestMatchKey) {
                             monthNum = monthMap[bestMatchKey];
                         }

                         if (monthNum > 0 && day >= 1 && day <= 31) {
                             const dateObj = moment({ year: targetYear, month: monthNum - 1, day: day });
                             if (dateObj.isValid()) {
                                 let formattedDate = dateObj.format(this.plugin.settings.dateFormat);
                                 if (!/^\*.*\*$/.test(formattedDate)) formattedDate = `*${formattedDate}*`;
                                 finalQuery = formattedDate;
                                 this.plugin.debugLog(`MDY(1) parse succeeded: "${query}" -> "${finalQuery}"`);
                             } else { this.plugin.debugLog(`MDY(1) constructed invalid date: "${query}"`); }
                         } else { this.plugin.debugLog(`MDY(1) parse failed (invalid parts): "${query}"`); }
                     } else {
                         this.plugin.debugLog(`MDY(1) digit ${yearDigit} != current year last digit ${lastDigitCurrentYear}. Passing raw.`);
                     }
                 
                 } else { // Not Month Day YY/YYYY and not Month Day Y, THEN try Month Day / Month only
                     const monthAbbrevPattern = /^([a-zA-Z]+)(?:\s+(\d{1,2}))?$/;
                     const monthAbbrevMatch = query.match(monthAbbrevPattern);
                     
                     if (monthAbbrevMatch) {
                        // Handle Month Day / Month only (using current year)
                        const monthText = monthAbbrevMatch[1].toLowerCase();
                        const day = monthAbbrevMatch[2] ? parseInt(monthAbbrevMatch[2], 10) : 1;
                        // *** Ensure this map includes full names ***
                        const monthMap: {[key: string]: number} = { 'jan': 1, 'january': 1, 'feb': 2, 'february': 2, 'mar': 3, 'march': 3, 'apr': 4, 'april': 4, 'may': 5, 'jun': 6, 'june': 6, 'jul': 7, 'july': 7, 'aug': 8, 'august': 8, 'sep': 9, 'sept': 9, 'september': 9, 'oct': 10, 'october': 10, 'nov': 11, 'november': 11, 'dec': 12, 'december': 12 };
                        let monthNum = -1;
                        // Find the best match (prefer exact match over prefix)
                        let bestMatchKey = "";
                        for (const key in monthMap) {
                            if (monthText === key) { // Exact match
                                bestMatchKey = key;
                                break;
                            } else if (monthText.startsWith(key) && key.length > bestMatchKey.length) { // Prefix match
                                bestMatchKey = key;
                            }
                        }
                        if (bestMatchKey) {
                            monthNum = monthMap[bestMatchKey];
                        }
                        // *** Corrected logic using monthNum ***
                        if (monthNum > 0 && day >= 1 && day <= 31) {
                            const dateObj = moment(); 
                            dateObj.month(monthNum - 1); dateObj.date(day);
                            let formattedDate = dateObj.format(this.plugin.settings.dateFormat);
                            if (!/^\*.*\*$/.test(formattedDate)) formattedDate = `*${formattedDate}*`;
                            finalQuery = formattedDate;
                            this.plugin.debugLog(`MD/M parse succeeded: "${query}" -> "${finalQuery}"`);
                        } else { this.plugin.debugLog(`MD/M parse failed: "${query}"`); }
                     } else {
                         this.plugin.debugLog(`No abbreviation pattern matched: "${query}". Passing raw.`);
                     }
                 } // End else for monthAbbrevPattern check
             } // End else for monthDaySingleDigitYearPattern check
        } // End else for monthDayYearPattern check

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

        // Case 1: Query is formatted (successfully parsed by onTrigger, includes asterisks)
        if (query.startsWith('*') && query.endsWith('*')) {
            const labelValue = query.slice(1, -1); // Remove asterisks for the label
            suggestions.push({ label: `Insert date: ${labelValue}`, isDate: true, dateValue: query });
            this.plugin.debugLog("DateSuggester: getSuggestions (Case 1): Suggesting pre-parsed date:", suggestions);
        } else {
            // --- Robust numeric date parsing for all supported formats ---
            const supportedFormats = [
                'MM/DD/YY', 'MM-DD-YY', 'YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY',
                'MMM D, YYYY', 'MMMM D, YYYY', 'MMM D, YY', 'MMMM D, YY',
                'M/D/YY', 'M-D-YY', 'M/D/YYYY', 'M-D-YYYY',
                'YYYY/M/D', 'YYYY-M-D', 'D/M/YYYY', 'D-M-YYYY',
            ];
            let parsedDate = null;
            for (const fmt of supportedFormats) {
                const m = moment(query, fmt, true);
                if (m.isValid()) {
                    parsedDate = m;
                    break;
                }
            }
            // Fallback: handle short numeric dates like '3-3-3', '3-3', '3'
            if (!parsedDate) {
                const numericParts = query.split(/[-\/]/).map(s => s.trim()).filter(Boolean);
                const now = moment();
                if (numericParts.length === 1 && /^\d{1,2}$/.test(numericParts[0])) {
                    // '@3' => March 1, current year
                    const month = parseInt(numericParts[0], 10);
                    if (month >= 1 && month <= 12) {
                        parsedDate = moment({ year: now.year(), month: month - 1, day: 1 });
                    }
                } else if (numericParts.length === 2 && /^\d{1,2}$/.test(numericParts[0]) && /^\d{1,2}$/.test(numericParts[1])) {
                    // '@3-3' => March 3, current year
                    const month = parseInt(numericParts[0], 10);
                    const day = parseInt(numericParts[1], 10);
                    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
                        parsedDate = moment({ year: now.year(), month: month - 1, day: day });
                    }
                } else if (numericParts.length === 3) {
                    // Try MM-DD-YY, MM-DD-YYYY, DD-MM-YY, etc.
                    const [a, b, c] = numericParts.map(x => parseInt(x, 10));
                    // MM-DD-YY (2-digit year)
                    if (a >= 1 && a <= 12 && b >= 1 && b <= 31 && c >= 0 && c <= 99) {
                        parsedDate = moment({ year: 2000 + c, month: a - 1, day: b });
                    }
                    // MM-DD-YYYY
                    else if (a >= 1 && a <= 12 && b >= 1 && b <= 31 && c > 1900 && c < 3000) {
                        parsedDate = moment({ year: c, month: a - 1, day: b });
                    }
                    // DD-MM-YY
                    else if (b >= 1 && b <= 12 && a >= 1 && a <= 31 && c >= 0 && c <= 99) {
                        parsedDate = moment({ year: 2000 + c, month: b - 1, day: a });
                    }
                    // DD-MM-YYYY
                    else if (b >= 1 && b <= 12 && a >= 1 && a <= 31 && c > 1900 && c < 3000) {
                        parsedDate = moment({ year: c, month: b - 1, day: a });
                    }
                }
            }
            if (parsedDate && parsedDate.isValid()) {
                let formattedDateValue = parsedDate.format(this.plugin.settings.dateFormat);
                let labelDate = formattedDateValue;
                if (!/^\*.*\*$/.test(formattedDateValue)) {
                    formattedDateValue = `*${formattedDateValue}*`;
                }
                suggestions.push({
                    label: `Insert date: ${labelDate}`,
                    isDate: true,
                    dateValue: formattedDateValue
                });
            }
            // Check if this might be a month abbreviation (Month Day or Month only)
            const monthAbbrevPattern = /^([a-zA-Z]+)(?:\s+(\d{1,2}))?$/;
            const trimmedQuery = query.trim(); 
            const monthAbbrevMatch = trimmedQuery.match(monthAbbrevPattern);

            const monthMap: {[key: string]: {name: string, num: number}} = {
                'jan': {name: 'January', num: 1}, 'january': {name: 'January', num: 1},
                'feb': {name: 'February', num: 2}, 'february': {name: 'February', num: 2},
                'mar': {name: 'March', num: 3}, 'march': {name: 'March', num: 3},
                'apr': {name: 'April', num: 4}, 'april': {name: 'April', num: 4},
                'may': {name: 'May', num: 5},
                'jun': {name: 'June', num: 6}, 'june': {name: 'June', num: 6},
                'jul': {name: 'July', num: 7}, 'july': {name: 'July', num: 7},
                'aug': {name: 'August', num: 8}, 'august': {name: 'August', num: 8},
                'sep': {name: 'September', num: 9}, 'sept': {name: 'September', num: 9}, 'september': {name: 'September', num: 9},
                'oct': {name: 'October', num: 10}, 'october': {name: 'October', num: 10},
                'nov': {name: 'November', num: 11}, 'november': {name: 'November', num: 11},
                'dec': {name: 'December', num: 12}, 'december': {name: 'December', num: 12}
            };

            // Always suggest all matching months for partial input
            if (monthAbbrevMatch) {
                const monthText = monthAbbrevMatch[1].toLowerCase();
                const day = monthAbbrevMatch[2] ? parseInt(monthAbbrevMatch[2], 10) : 1;
                // Find all matching months (prefix match)
                let matchedMonths: {info: {name: string, num: number}, key: string}[] = [];
                for (const key in monthMap) {
                    if (key.startsWith(monthText)) {
                        matchedMonths.push({info: monthMap[key], key: key});
                    }
                }
                // Remove duplicates by month number (so 'dec' and 'december' don't both show)
                const uniqueMonths: {[num: number]: {name: string, num: number}} = {};
                for (const match of matchedMonths) {
                    uniqueMonths[match.info.num] = match.info;
                }
                for (const num in uniqueMonths) {
                    const info = uniqueMonths[num];
                    const dateObj = moment();
                    dateObj.month(info.num - 1);
                    dateObj.date(day);
                    let formattedDateValue = dateObj.format(this.plugin.settings.dateFormat);
                    let labelDate = formattedDateValue;
                    if (!/^\*.*\*$/.test(formattedDateValue)) {
                        formattedDateValue = `*${formattedDateValue}*`;
                    }
                    suggestions.push({
                        label: `Insert date: ${labelDate}`,
                        isDate: true,
                        dateValue: formattedDateValue
                    });
                }
            }
            // Handle raw query that looks like Month Day Y (e.g., 'december 2 2')
            const monthDaySingleDigitYearPattern = /^([a-zA-Z]+)\s+(\d{1,2})\s+(\d{1})$/i;
            const singleDigitMatch = trimmedQuery.match(monthDaySingleDigitYearPattern);
            if (singleDigitMatch) {
                const monthText = singleDigitMatch[1].toLowerCase();
                const day = parseInt(singleDigitMatch[2], 10);
                // Always use current year for single digit year
                const currentYear = moment().year();
                let monthNum = null;
                for (const key in monthMap) {
                    if (key.startsWith(monthText)) {
                        monthNum = monthMap[key].num;
                        break;
                    }
                }
                if (monthNum && day >= 1 && day <= 31) {
                    const dateObj = moment({ year: currentYear, month: monthNum - 1, day: day });
                    if (dateObj.isValid()) {
                        let formattedDateValue = dateObj.format(this.plugin.settings.dateFormat);
                        let labelDate = formattedDateValue;
                        if (!/^\*.*\*$/.test(formattedDateValue)) {
                            formattedDateValue = `*${formattedDateValue}*`;
                        }
                        suggestions.push({
                            label: `Insert date: ${labelDate}`,
                            isDate: true,
                            dateValue: formattedDateValue
                        });
                    }
                }
            }
            // If it wasn't any abbreviation pattern we handle here, 
            // BUT onTrigger *did* format it (meaning it was a strictly parsed date like MM/DD/YY), show that.
            else if (context.query !== query && context.query.startsWith('*') && context.query.endsWith('*')) {
                const labelValue = context.query.slice(1, -1); // Remove asterisks for label
                suggestions.push({ label: `Insert date: ${labelValue}`, isDate: true, dateValue: context.query });
                this.plugin.debugLog("DateSuggester: getSuggestions (Case 1.5 - onTrigger parsed): Suggesting pre-parsed date:", suggestions);
            }
        }

        // Always add the option to insert today's date if the query is empty (i.e., just '@')
        if (!query.trim()) {
            const todayRaw = moment().format(this.plugin.settings.dateFormat); // Raw format for label
            let todayInsert = todayRaw;
            if (!/^\*.*\*$/.test(todayInsert)) {
                todayInsert = `*${todayInsert}*`; // Add asterisks for insertion value
            }
            // Use todayRaw (no asterisks) for the label
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
            // Check if there's already a space after the insertion point
            const line = editor.getLine(endPos.line);
            const hasSpaceAfter = line.length > endPos.ch && line[endPos.ch] === ' ';
            
            // Insert the formatted date directly, with a space after (if needed)
            const dateWithSpace = suggestion.dateValue + (hasSpaceAfter ? '' : ' ');
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
    plugin: DateSelectorPlugin; // Store the plugin instance
    initialDateYYYYMMDD: string | null; // Expects YYYY-MM-DD or null
    onSubmit: (resultYYYYMMDD: string) => void; // Returns YYYY-MM-DD
    selectedDateYYYYMMDD: string; // Store the picked date internally as YYYY-MM-DD
    focusedDate: moment.Moment; // Store the focused date for keyboard navigation
    suppressFocus: boolean = false; // New flag to control focus styling

    constructor(plugin: DateSelectorPlugin, app: App, initialDateYYYYMMDD: string | null, onSubmit: (resultYYYYMMDD: string) => void) {
        super(app);
        this.plugin = plugin;
        this.initialDateYYYYMMDD = initialDateYYYYMMDD;
        this.onSubmit = onSubmit;

        // Use initial date if provided and valid, otherwise default to today
        this.selectedDateYYYYMMDD = moment(this.initialDateYYYYMMDD, 'YYYY-MM-DD', true).isValid()
            ? this.initialDateYYYYMMDD!
            : moment().format('YYYY-MM-DD'); // Default to today if invalid/null
        // Initialize focusedDate to the selected date (or today)
        this.focusedDate = moment(this.selectedDateYYYYMMDD, 'YYYY-MM-DD', true).isValid()
            ? moment(this.selectedDateYYYYMMDD, 'YYYY-MM-DD')
            : moment();
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('date-selector-modal');
        contentEl.createEl('h2', { text: 'Select a Date', cls: 'calendar-modal-title' });

        // Use the plugin instance passed in
        const useCustomCalendar = this.plugin.settings.useCustomCalendar;

        if (useCustomCalendar) {
            // --- Custom Calendar UI ---
            const calendarContainer = contentEl.createEl('div', { cls: 'custom-calendar-container' });
            let currentMonth = moment(this.selectedDateYYYYMMDD, 'YYYY-MM-DD', true).isValid()
                ? moment(this.selectedDateYYYYMMDD, 'YYYY-MM-DD')
                : moment();
            // Use this.focusedDate instead of local focusedDate

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
                    // Set focus to startOf month but suppress the visible focus highlighting
                    this.focusedDate = currentMonth.clone().startOf('month');
                    this.suppressFocus = true; // Suppress focus highlighting after month change
                    renderCalendar();
                };
                nextBtn.onclick = () => {
                    currentMonth = currentMonth.clone().add(1, 'month');
                    // Set focus to startOf month but suppress the visible focus highlighting
                    this.focusedDate = currentMonth.clone().startOf('month');
                    this.suppressFocus = true; // Suppress focus highlighting after month change
                    renderCalendar();
                };

                // Days of week
                const daysRow = calendarContainer.createEl('div', { cls: 'calendar-days-row' });
                const daysShort = moment.weekdaysShort();
                daysShort.forEach((day, index) => {
                    const dayLabel = daysRow.createEl('span', { text: day, cls: 'calendar-day-label' });
                    // Add weekend class to Saturday (6) and Sunday (0)
                    if (index === 0 || index === 6) {
                        dayLabel.addClass('calendar-day-label-weekend');
                    }
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
                        const isWeekend = day === 0 || day === 6; // Determine if it's a weekend
                        const isSelected = dateStr === this.selectedDateYYYYMMDD;
                        const isInitial = this.initialDateYYYYMMDD && dateStr === this.initialDateYYYYMMDD;
                        const isToday = date.isSame(moment(), 'day');
                        const isFocused = dateStr === this.focusedDate.format('YYYY-MM-DD');

                        const dateBtn = weekRow.createEl('button', { text: String(date.date()), cls: 'calendar-date-btn' });

                        // Add base weekend class regardless of month, CSS handles the difference
                        if (isWeekend) {
                            dateBtn.addClass('calendar-date-weekend');
                        }

                        // Remove focus attribute initially, will be added back if needed
                        dateBtn.removeAttribute('data-focused-date');

                        if (isCurrentMonth) {
                            // Apply status classes only for dates within the current month
                            if (isSelected) {
                                dateBtn.addClass('calendar-date-selected');
                            }
                            if (isInitial) {
                                dateBtn.addClass('calendar-date-initial');
                            }
                            if (isToday) {
                                dateBtn.addClass('calendar-date-today');
                            }
                            // Only add focus class if suppressFocus is false
                            if (isFocused && !this.suppressFocus) {
                                dateBtn.addClass('calendar-date-focused');
                                dateBtn.setAttr('data-focused-date', 'true');
                            }
                        } else {
                            // Apply only the 'outside' class for dates not in the current month
                            dateBtn.addClass('calendar-date-outside');
                            // Note: The weekend class added earlier will combine with 'outside' via CSS
                            // No selected, initial, today, or focused styles/attributes for outside dates.
                        }

                        dateBtn.onclick = () => {
                            // When any date is clicked, enable focus again
                            this.suppressFocus = false;
                            
                            // Existing logic for clicking inside vs outside current month
                            if (!date.isSame(currentMonth, 'month')) {
                                this.focusedDate = date.clone();
                                currentMonth = date.clone().startOf('month');
                                this.selectedDateYYYYMMDD = dateStr;
                                updateSelectedDateHeader();
                                renderCalendar();
                                return;
                            }
                            this.selectedDateYYYYMMDD = dateStr;
                            this.focusedDate = date.clone();
                            updateSelectedDateHeader();
                            renderCalendar();
                        };

                        // Add double-click handler to confirm date
                        dateBtn.ondblclick = () => {
                            this.selectedDateYYYYMMDD = dateStr;
                            this.close();
                            this.onSubmit(this.selectedDateYYYYMMDD);
                        };
                    }
                }
                // After rendering, focus the button for the focused date
                setTimeout(() => {
                    calendarContainer.querySelectorAll('button[data-focused-date]').forEach(btn => btn.removeAttribute('data-focused-date'));
                    const focusedBtn = calendarContainer.querySelector('button.calendar-date-focused') as HTMLButtonElement;
                    if (focusedBtn) {
                        focusedBtn.setAttribute('data-focused-date', 'true');
                        focusedBtn.focus();
                    }
                }, 0);
            };
            renderCalendar();

            // Keyboard navigation
            const handleKeyDown = (evt: KeyboardEvent) => {
                let handled = false;
                if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(evt.key)) {
                    // When keyboard navigation is used, enable focus again
                    this.suppressFocus = false;
                    
                    let newFocus = this.focusedDate.clone();
                    if (evt.key === 'ArrowLeft') newFocus.subtract(1, 'day');
                    if (evt.key === 'ArrowRight') newFocus.add(1, 'day');
                    if (evt.key === 'ArrowUp') newFocus.subtract(7, 'day');
                    if (evt.key === 'ArrowDown') newFocus.add(7, 'day');
                    if (!newFocus.isSame(currentMonth, 'month')) {
                        currentMonth = newFocus.clone();
                    }
                    this.focusedDate = newFocus;
                    renderCalendar();
                    handled = true;
                } else if (evt.key === 'Enter') {
                    this.selectedDateYYYYMMDD = this.focusedDate.format('YYYY-MM-DD');
                    updateSelectedDateHeader();
                    // Immediately confirm and close on Enter
                    this.close();
                    this.onSubmit(this.selectedDateYYYYMMDD);
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
                :root {
                    --date-selector-accent: var(--interactive-accent, #a48cff);
                    --date-selector-accent-light: #b3aaff;
                    --date-selector-header: var(--text-accent, #fff);
                    --date-selector-today-border: var(--interactive-accent, #a48cff);
                    --date-selector-bg: var(--background-primary, #2a2a40);
                    --date-selector-bg-secondary: var(--background-secondary, #23233a);
                    --date-selector-bg-error: var(--background-modifier-error, #d43a3a);
                }
                .date-selector-modal {
                    width: auto !important;
                    max-width: none !important;
                    min-width: 0 !important;
                    margin: 0 auto !important;
                    box-sizing: border-box;
                    padding: 2em !important;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                }
                .calendar-modal-title {
                    color: var(--date-selector-header);
                    margin-bottom: 0.5em;
                }
                .custom-calendar-container {
                    margin: 0 auto;
                    padding: 0;
                    min-height: 340px;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    width: auto;
                    box-sizing: border-box;
                }
                .calendar-header { 
                    display: flex; 
                    align-items: center; 
                    justify-content: space-between; 
                    margin-bottom: 1.2em; 
                    width: 100%;
                    box-sizing: border-box;
                }
                .calendar-nav-btn { 
                    background: none; 
                    border: none; 
                    font-size: 1.6em; 
                    cursor: pointer; 
                    padding: 0 0.7em; 
                    color: var(--date-selector-accent-light); 
                    transition: color 0.15s; 
                }
                .calendar-nav-btn:hover { color: var(--date-selector-accent); }
                .calendar-month-year { font-weight: bold; font-size: 1.3em; letter-spacing: 0.02em; color: var(--date-selector-header); }
                .calendar-selected-date-header { 
                    margin-top: 1.2em;
                    margin-bottom: 1em; 
                    font-size: 1.1em; 
                    color: var(--date-selector-accent); 
                    width: 100%; 
                    text-align: left; 
                    box-sizing: border-box;
                }
                .calendar-days-row {
                    display: grid;
                    grid-template-columns: repeat(7, minmax(0, 1fr));
                    gap: 0.4em;
                    margin-bottom: 0.3em;
                    width: 100%;
                    box-sizing: border-box;
                }
                .calendar-day-label { 
                    box-sizing: border-box;
                    text-align: center; 
                    font-size: 1.1em; 
                    color: var(--text-faint, #b3b3c6); 
                    font-weight: 600; 
                    letter-spacing: 0.01em; 
                    display: flex; 
                    align-items: center; 
                    justify-content: center;
                    height: 2.2em;
                }
                .calendar-day-label-weekend {
                    color: var(--date-selector-accent);
                }
                .calendar-dates-grid { 
                    display: grid; 
                    grid-template-rows: repeat(6, 1fr); 
                    gap: 0.4em; 
                    width: 100%; 
                    box-sizing: border-box;
                }
                .calendar-week-row {
                    display: grid;
                    grid-template-columns: repeat(7, minmax(0, 1fr));
                    gap: 0.4em;
                    width: 100%;
                    box-sizing: border-box;
                }
                .calendar-date-blank { 
                    width: 2.6em; 
                    height: 2.6em; 
                    box-sizing: border-box; 
                }
                /* Base date button - current month weekday (lightest) */
                .calendar-date-btn { 
                    width: 2.6em;
                    height: 2.6em;
                    margin: 0; 
                    border: none; 
                    border-radius: 6px; 
                    background: rgba(78, 87, 119, 0.2);
                    cursor: pointer; 
                    transition: background 0.15s, color 0.15s, box-shadow 0.15s; 
                    font-size: 1.1em; 
                    color: var(--text-normal, #e3e3f7); 
                    font-weight: 500; 
                    display: flex; 
                    align-items: center; 
                    justify-content: center; 
                    box-sizing: border-box;
                    overflow: hidden;
                }
                /* Current month weekend (darker than weekday) */
                .calendar-date-weekend {
                    background: rgba(50, 45, 75, 0.65) !important;
                    color: var(--date-selector-accent-light) !important;
                }
                /* Surrounding months weekday (darker than current month weekend) */
                .calendar-date-outside { 
                    color: var(--text-faint, #aaa) !important; 
                    background: rgba(45, 45, 55, 0.65) !important;
                }
                /* Surrounding months weekend (darkest) */
                .calendar-date-outside.calendar-date-weekend {
                    background: rgba(30, 30, 45, 0.85) !important;
                    color: #9992b8 !important;
                }
                /* Hover state - subtle neutral background */
                .calendar-date-btn:hover {
                    background: rgba(128, 128, 128, 0.2) !important;
                    color: var(--text-normal, #fff) !important; /* Keep text color consistent on hover */
                    /* Remove box-shadow from hover */
                }
                /* Focus state (keyboard nav or click/tab) - accent shadow ONLY */
                .calendar-date-btn:focus,
                .calendar-date-focused { /* Applied via JS for keyboard nav state */
                    outline: none !important; /* Remove default outline */
                    box-shadow: 0 0 0 2px var(--date-selector-accent, rgba(164, 140, 255, 0.6)) !important;
                    /* Do not change background on focus alone */
                }
                /* Selected state - purple border */
                /* Selected state - bright accent background */
                .calendar-date-selected { 
                    /* border: 2px solid var(--date-selector-accent) !important; */ /* Use accent border */
                    background: var(--date-selector-accent) !important; /* Use accent background */
                    color: var(--text-normal, #fff) !important; 
                    font-weight: 700 !important; 
                    /* box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.2) !important; */ /* Remove inner shadow */
                    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.2) !important; /* Restore subtle inner shadow */
                }
                /* Selected AND Focused - keep selected border, add focus shadow */
                /* Selected AND Focused - keep selected background, add focus shadow */
                .calendar-date-selected:focus {
                    /* border: 2px solid var(--date-selector-accent) !important; */ /* Keep selected border */
                    background: var(--date-selector-accent) !important; /* Keep selected background */
                    color: var(--text-normal, #fff) !important; /* Maintain selected text color */
                    box-shadow: 0 0 0 2px var(--date-selector-accent, rgba(164, 140, 255, 0.6)) !important; /* Ensure focus ring */
                }
                /* Today state - distinct border */
                .calendar-date-today { 
                    border: 2px solid var(--text-muted, #888888) !important; /* Use a distinct grey border */
                }
                /* Initial Date state (the one being edited) - distinct border */
                .calendar-date-initial {
                    border: 2px solid var(--date-selector-accent) !important;
                }
                /* Full-width button styling */
                .date-selector-modal .setting-item {
                    width: 100%;
                    border-top: none;
                    padding: 0;
                }
                .date-selector-modal .setting-item-control {
                    width: 100%;
                    justify-content: center;
                }
                .date-selector-modal .setting-item-control button {
                    width: 100%;
                    margin: 0;
                    height: 2.5em;
                    font-size: 1.05em;
                    font-weight: 500;
                    border-radius: 6px;
                }
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

        contentEl.createEl('div', { attr: { style: 'margin-top: 1rem; width: 100%;' } });

        // Replace the Setting with a direct button for more style control
        const confirmBtn = contentEl.createEl('button', {
            text: 'Confirm Date',
            cls: 'mod-cta confirm-date-button',
            attr: {
                style: 'width: 100%; height: 2.8em; margin-top: 1em; font-size: 1.05em; font-weight: 500; border-radius: 6px;'
            }
        });
        
        confirmBtn.addEventListener('click', () => {
            // Basic validation: check for valid date
            if (!this.selectedDateYYYYMMDD || !moment(this.selectedDateYYYYMMDD, 'YYYY-MM-DD', true).isValid()) {
                console.error("Invalid date selected in modal:", this.selectedDateYYYYMMDD);
                // Optionally show a notice to the user here
                return;
            }
            this.close();
            // Submit the selected date in YYYY-MM-DD format
            this.onSubmit(this.selectedDateYYYYMMDD);
        });

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
        new Setting(containerEl)
            .setName('Date format')
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