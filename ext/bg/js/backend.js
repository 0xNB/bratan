/*
 * Copyright (C) 2016-2020  Alex Yatskov <alex@foosoft.net>
 * Author: Alex Yatskov <alex@foosoft.net>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */


class Backend {
    constructor() {
        this.translator = new Translator();
        this.anki = new AnkiNull();
        this.mecab = new Mecab();
        this.clipboardMonitor = new ClipboardMonitor();
        this.options = null;
        this.optionsSchema = null;
        this.optionsContext = {
            depth: 0,
            url: window.location.href
        };

        this.isPreparedResolve = null;
        this.isPreparedPromise = new Promise((resolve) => (this.isPreparedResolve = resolve));

        this.clipboardPasteTarget = document.querySelector('#clipboard-paste-target');

        this.popupWindow = null;

        this.apiForwarder = new BackendApiForwarder();
    }

    async prepare() {
        await this.translator.prepare();

        this.optionsSchema = await requestJson(chrome.runtime.getURL('/bg/data/options-schema.json'), 'GET');
        this.options = await optionsLoad();
        try {
            this.options = JsonSchema.getValidValueOrDefault(this.optionsSchema, this.options);
        } catch (e) {
            // This shouldn't happen, but catch errors just in case of bugs
            logError(e);
        }

        this.onOptionsUpdated('background');

        if (isObject(chrome.commands) && isObject(chrome.commands.onCommand)) {
            chrome.commands.onCommand.addListener((command) => this._runCommand(command));
        }
        if (isObject(chrome.tabs) && isObject(chrome.tabs.onZoomChange)) {
            chrome.tabs.onZoomChange.addListener((info) => this._onZoomChange(info));
        }
        chrome.runtime.onMessage.addListener(this.onMessage.bind(this));

        const options = this.getOptionsSync(this.optionsContext);
        if (options.general.showGuide) {
            chrome.tabs.create({url: chrome.runtime.getURL('/bg/guide.html')});
        }

        this.isPreparedResolve();
        this.isPreparedResolve = null;
        this.isPreparedPromise = null;

        this.clipboardMonitor.onClipboardText = (text) => this._onClipboardText(text);
    }

    onOptionsUpdated(source) {
        this.applyOptions();

        const callback = () => this.checkLastError(chrome.runtime.lastError);
        chrome.tabs.query({}, (tabs) => {
            for (const tab of tabs) {
                chrome.tabs.sendMessage(tab.id, {action: 'optionsUpdate', params: {source}}, callback);
            }
        });
    }

    onMessage({action, params}, sender, callback) {
        const handler = Backend._messageHandlers.get(action);
        if (typeof handler !== 'function') { return false; }

        try {
            const promise = handler(this, params, sender);
            promise.then(
                (result) => callback({result}),
                (error) => callback({error: errorToJson(error)})
            );
            return true;
        } catch (error) {
            callback({error: errorToJson(error)});
            return false;
        }
    }

    _onClipboardText(text) {
        this._onCommandSearch({mode: 'popup', query: text});
    }

    _onZoomChange({tabId, oldZoomFactor, newZoomFactor}) {
        const callback = () => this.checkLastError(chrome.runtime.lastError);
        chrome.tabs.sendMessage(tabId, {action: 'zoomChanged', params: {oldZoomFactor, newZoomFactor}}, callback);
    }

    applyOptions() {
        const options = this.getOptionsSync(this.optionsContext);
        if (!options.general.enable) {
            this.setExtensionBadgeBackgroundColor('#555555');
            this.setExtensionBadgeText('off');
        } else if (!dictConfigured(options)) {
            this.setExtensionBadgeBackgroundColor('#f0ad4e');
            this.setExtensionBadgeText('!');
        } else {
            this.setExtensionBadgeText('');
        }

        this.anki = options.anki.enable ? new AnkiConnect(options.anki.server) : new AnkiNull();

        if (options.parsing.enableMecabParser) {
            this.mecab.startListener();
        } else {
            this.mecab.stopListener();
        }

        if (options.general.enableClipboardPopups) {
            this.clipboardMonitor.start();
        } else {
            this.clipboardMonitor.stop();
        }
    }

    async getOptionsSchema() {
        if (this.isPreparedPromise !== null) {
            await this.isPreparedPromise;
        }
        return this.optionsSchema;
    }

    async getFullOptions() {
        if (this.isPreparedPromise !== null) {
            await this.isPreparedPromise;
        }
        return this.options;
    }

    async setFullOptions(options) {
        if (this.isPreparedPromise !== null) {
            await this.isPreparedPromise;
        }
        try {
            this.options = JsonSchema.getValidValueOrDefault(this.optionsSchema, utilIsolate(options));
        } catch (e) {
            // This shouldn't happen, but catch errors just in case of bugs
            logError(e);
        }
    }

    async getOptions(optionsContext) {
        if (this.isPreparedPromise !== null) {
            await this.isPreparedPromise;
        }
        return this.getOptionsSync(optionsContext);
    }

    getOptionsSync(optionsContext) {
        return this.getProfileSync(optionsContext).options;
    }

    getProfileSync(optionsContext) {
        const profiles = this.options.profiles;
        if (typeof optionsContext.index === 'number') {
            return profiles[optionsContext.index];
        }
        const profile = this.getProfileFromContext(optionsContext);
        return profile !== null ? profile : this.options.profiles[this.options.profileCurrent];
    }

    getProfileFromContext(optionsContext) {
        for (const profile of this.options.profiles) {
            const conditionGroups = profile.conditionGroups;
            if (conditionGroups.length > 0 && Backend.testConditionGroups(conditionGroups, optionsContext)) {
                return profile;
            }
        }
        return null;
    }

    static testConditionGroups(conditionGroups, data) {
        if (conditionGroups.length === 0) { return false; }

        for (const conditionGroup of conditionGroups) {
            const conditions = conditionGroup.conditions;
            if (conditions.length > 0 && Backend.testConditions(conditions, data)) {
                return true;
            }
        }

        return false;
    }

    static testConditions(conditions, data) {
        for (const condition of conditions) {
            if (!conditionsTestValue(profileConditionsDescriptor, condition.type, condition.operator, condition.value, data)) {
                return false;
            }
        }
        return true;
    }

    setExtensionBadgeBackgroundColor(color) {
        if (typeof chrome.browserAction.setBadgeBackgroundColor === 'function') {
            chrome.browserAction.setBadgeBackgroundColor({color});
        }
    }

    setExtensionBadgeText(text) {
        if (typeof chrome.browserAction.setBadgeText === 'function') {
            chrome.browserAction.setBadgeText({text});
        }
    }

    checkLastError() {
        // NOP
    }

    _runCommand(command, params) {
        const handler = Backend._commandHandlers.get(command);
        if (typeof handler !== 'function') { return false; }

        handler(this, params);
        return true;
    }

    // Message handlers

    _onApiOptionsSchemaGet() {
        return this.getOptionsSchema();
    }

    _onApiOptionsGet({optionsContext}) {
        return this.getOptions(optionsContext);
    }

    _onApiOptionsGetFull() {
        return this.getFullOptions();
    }

    async _onApiOptionsSet({changedOptions, optionsContext, source}) {
        const options = await this.getOptions(optionsContext);

        function getValuePaths(obj) {
            const valuePaths = [];
            const nodes = [{obj, path: []}];
            while (nodes.length > 0) {
                const node = nodes.pop();
                for (const key of Object.keys(node.obj)) {
                    const path = node.path.concat(key);
                    const obj = node.obj[key];
                    if (obj !== null && typeof obj === 'object') {
                        nodes.unshift({obj, path});
                    } else {
                        valuePaths.push([obj, path]);
                    }
                }
            }
            return valuePaths;
        }

        function modifyOption(path, value, options) {
            let pivot = options;
            for (const key of path.slice(0, -1)) {
                if (!hasOwn(pivot, key)) {
                    return false;
                }
                pivot = pivot[key];
            }
            pivot[path[path.length - 1]] = value;
            return true;
        }

        for (const [value, path] of getValuePaths(changedOptions)) {
            modifyOption(path, value, options);
        }

        await this._onApiOptionsSave({source});
    }

    async _onApiOptionsSave({source}) {
        const options = await this.getFullOptions();
        await optionsSave(options);
        this.onOptionsUpdated(source);
    }

    async _onApiKanjiFind({text, optionsContext}) {
        const options = await this.getOptions(optionsContext);
        const definitions = await this.translator.findKanji(text, options);
        definitions.splice(options.general.maxResults);
        return definitions;
    }

    async _onApiTermsFind({text, details, optionsContext}) {
        const options = await this.getOptions(optionsContext);
        const [definitions, length] = await this.translator.findTerms(text, details, options);
        definitions.splice(options.general.maxResults);
        return {length, definitions};
    }

    async _onApiTextParse({text, optionsContext}) {
        const options = await this.getOptions(optionsContext);
        const results = [];
        while (text.length > 0) {
            const term = [];
            const [definitions, sourceLength] = await this.translator.findTermsInternal(
                text.substring(0, options.scanning.length),
                dictEnabledSet(options),
                {},
                options
            );
            if (definitions.length > 0) {
                dictTermsSort(definitions);
                const {expression, reading} = definitions[0];
                const source = text.substring(0, sourceLength);
                for (const {text, furigana} of jpDistributeFuriganaInflected(expression, reading, source)) {
                    const reading = jpConvertReading(text, furigana, options.parsing.readingMode);
                    term.push({text, reading});
                }
                text = text.substring(source.length);
            } else {
                const reading = jpConvertReading(text[0], null, options.parsing.readingMode);
                term.push({text: text[0], reading});
                text = text.substring(1);
            }
            results.push(term);
        }
        return results;
    }

    async _onApiTextParseMecab({text, optionsContext}) {
        const options = await this.getOptions(optionsContext);
        const results = {};
        const rawResults = await this.mecab.parseText(text);
        for (const mecabName in rawResults) {
            const result = [];
            for (const parsedLine of rawResults[mecabName]) {
                for (const {expression, reading, source} of parsedLine) {
                    const term = [];
                    if (expression !== null && reading !== null) {
                        for (const {text, furigana} of jpDistributeFuriganaInflected(
                            expression,
                            jpKatakanaToHiragana(reading),
                            source
                        )) {
                            const reading = jpConvertReading(text, furigana, options.parsing.readingMode);
                            term.push({text, reading});
                        }
                    } else {
                        const reading = jpConvertReading(source, null, options.parsing.readingMode);
                        term.push({text: source, reading});
                    }
                    result.push(term);
                }
                result.push([{text: '\n'}]);
            }
            results[mecabName] = result;
        }
        return results;
    }

    async _onApiDefinitionAdd({definition, mode, context, optionsContext}) {
        const options = await this.getOptions(optionsContext);
        const templates = Backend._getTemplates(options);

        if (mode !== 'kanji') {
            await audioInject(
                definition,
                options.anki.terms.fields,
                options.audio.sources,
                optionsContext
            );
        }

        if (context && context.screenshot) {
            await this._injectScreenshot(
                definition,
                options.anki.terms.fields,
                context.screenshot
            );
        }

        const note = await dictNoteFormat(definition, mode, options, templates);
        return this.anki.addNote(note);
    }

    async _onApiDefinitionsAddable({definitions, modes, optionsContext}) {
        const options = await this.getOptions(optionsContext);
        const templates = Backend._getTemplates(options);
        const states = [];

        try {
            const notes = [];
            for (const definition of definitions) {
                for (const mode of modes) {
                    const note = await dictNoteFormat(definition, mode, options, templates);
                    notes.push(note);
                }
            }

            const cannotAdd = [];
            const results = await this.anki.canAddNotes(notes);
            for (let resultBase = 0; resultBase < results.length; resultBase += modes.length) {
                const state = {};
                for (let modeOffset = 0; modeOffset < modes.length; ++modeOffset) {
                    const index = resultBase + modeOffset;
                    const result = results[index];
                    const info = {canAdd: result};
                    state[modes[modeOffset]] = info;
                    if (!result) {
                        cannotAdd.push([notes[index], info]);
                    }
                }

                states.push(state);
            }

            if (cannotAdd.length > 0) {
                const noteIdsArray = await this.anki.findNoteIds(cannotAdd.map((e) => e[0]));
                for (let i = 0, ii = Math.min(cannotAdd.length, noteIdsArray.length); i < ii; ++i) {
                    const noteIds = noteIdsArray[i];
                    if (noteIds.length > 0) {
                        cannotAdd[i][1].noteId = noteIds[0];
                    }
                }
            }
        } catch (e) {
            // NOP
        }

        return states;
    }

    async _onApiNoteView({noteId}) {
        return this.anki.guiBrowse(`nid:${noteId}`);
    }

    async _onApiTemplateRender({template, data, dynamic}) {
        return (
            dynamic ?
            handlebarsRenderDynamic(template, data) :
            handlebarsRenderStatic(template, data)
        );
    }

    async _onApiCommandExec({command, params}) {
        return this._runCommand(command, params);
    }

    async _onApiAudioGetUrl({definition, source, optionsContext}) {
        const options = await this.getOptions(optionsContext);
        return await audioGetUrl(definition, source, options);
    }

    _onApiScreenshotGet({options}, sender) {
        if (!(sender && sender.tab)) {
            return Promise.resolve();
        }

        const windowId = sender.tab.windowId;
        return new Promise((resolve) => {
            chrome.tabs.captureVisibleTab(windowId, options, (dataUrl) => resolve(dataUrl));
        });
    }

    _onApiForward({action, params}, sender) {
        if (!(sender && sender.tab)) {
            return Promise.resolve();
        }

        const tabId = sender.tab.id;
        return new Promise((resolve) => {
            chrome.tabs.sendMessage(tabId, {action, params}, (response) => resolve(response));
        });
    }

    _onApiFrameInformationGet(params, sender) {
        const frameId = sender.frameId;
        return Promise.resolve({frameId});
    }

    _onApiInjectStylesheet({css}, sender) {
        if (!sender.tab) {
            return Promise.reject(new Error('Invalid tab'));
        }

        const tabId = sender.tab.id;
        const frameId = sender.frameId;
        const details = {
            code: css,
            runAt: 'document_start',
            cssOrigin: 'user',
            allFrames: false
        };
        if (typeof frameId === 'number') {
            details.frameId = frameId;
        }

        return new Promise((resolve, reject) => {
            chrome.tabs.insertCSS(tabId, details, () => {
                const e = chrome.runtime.lastError;
                if (e) {
                    reject(new Error(e.message));
                } else {
                    resolve();
                }
            });
        });
    }

    async _onApiGetEnvironmentInfo() {
        const browser = await Backend._getBrowser();
        const platform = await new Promise((resolve) => chrome.runtime.getPlatformInfo(resolve));
        return {
            browser,
            platform: {
                os: platform.os
            }
        };
    }

    async _onApiClipboardGet() {
        /*
        Notes:
            document.execCommand('paste') doesn't work on Firefox.
            This may be a bug: https://bugzilla.mozilla.org/show_bug.cgi?id=1603985
            Therefore, navigator.clipboard.readText() is used on Firefox.

            navigator.clipboard.readText() can't be used in Chrome for two reasons:
            * Requires page to be focused, else it rejects with an exception.
            * When the page is focused, Chrome will request clipboard permission, despite already
              being an extension with clipboard permissions. It effectively asks for the
              non-extension permission for clipboard access.
        */
        const browser = await Backend._getBrowser();
        if (browser === 'firefox' || browser === 'firefox-mobile') {
            return await navigator.clipboard.readText();
        } else {
            const clipboardPasteTarget = this.clipboardPasteTarget;
            clipboardPasteTarget.value = '';
            clipboardPasteTarget.focus();
            document.execCommand('paste');
            const result = clipboardPasteTarget.value;
            clipboardPasteTarget.value = '';
            return result;
        }
    }

    async _onApiGetDisplayTemplatesHtml() {
        const url = chrome.runtime.getURL('/mixed/display-templates.html');
        return await requestText(url, 'GET');
    }

    _onApiGetZoom(params, sender) {
        if (!sender || !sender.tab) {
            return Promise.reject(new Error('Invalid tab'));
        }

        return new Promise((resolve, reject) => {
            const tabId = sender.tab.id;
            if (!(
                chrome.tabs !== null &&
                typeof chrome.tabs === 'object' &&
                typeof chrome.tabs.getZoom === 'function'
            )) {
                // Not supported
                resolve({zoomFactor: 1.0});
                return;
            }
            chrome.tabs.getZoom(tabId, (zoomFactor) => {
                const e = chrome.runtime.lastError;
                if (e) {
                    reject(new Error(e.message));
                } else {
                    resolve({zoomFactor});
                }
            });
        });
    }

    // Command handlers

    async _onCommandSearch(params) {
        const {mode, query} = params || {mode: 'sameTab'};

        const options = await this.getOptions(this.optionsContext);
        const {popupWidth, popupHeight} = options.general;

        const baseUrl = chrome.runtime.getURL('/bg/search.html');
        const queryString = (query && query.length > 0) ? `?query=${encodeURIComponent(query)}` : '';
        const url = baseUrl + queryString;

        switch (mode) {
            case 'sameTab':
                try {
                    const tab = await Backend._findTab(1000, (url2) => (
                        url2 !== null &&
                        url2.startsWith(url) &&
                        (url2.length === url.length || url2[url.length] === '?' || url2[url.length] === '#')
                    ));
                    if (tab !== null) {
                        await Backend._focusTab(tab);
                        return;
                    }
                } catch (e) {
                    // NOP
                }
                chrome.tabs.create({url});
                return;
            case 'newTab':
                chrome.tabs.create({url});
                return;
            case 'popup':
                if (this.popupWindow !== null) {
                    chrome.windows.remove(this.popupWindow.id);
                }
                chrome.windows.create(
                    {url, width: popupWidth, height: popupHeight, type: 'popup'},
                    (popupWindow) => { this.popupWindow = popupWindow; }
                );
                return;
        }
    }

    _onCommandHelp() {
        chrome.tabs.create({url: 'https://foosoft.net/projects/yomichan/'});
    }

    _onCommandOptions(params) {
        if (!(params && params.newTab)) {
            chrome.runtime.openOptionsPage();
        } else {
            const manifest = chrome.runtime.getManifest();
            const url = chrome.runtime.getURL(manifest.options_ui.page);
            chrome.tabs.create({url});
        }
    }

    async _onCommandToggle() {
        const optionsContext = {
            depth: 0,
            url: window.location.href
        };
        const source = 'popup';

        const options = await this.getOptions(optionsContext);
        options.general.enable = !options.general.enable;
        await this._onApiOptionsSave({source});
    }

    // Utilities

    async _injectScreenshot(definition, fields, screenshot) {
        let usesScreenshot = false;
        for (const name in fields) {
            if (fields[name].includes('{screenshot}')) {
                usesScreenshot = true;
                break;
            }
        }

        if (!usesScreenshot) {
            return;
        }

        const dateToString = (date) => {
            const year = date.getUTCFullYear();
            const month = date.getUTCMonth().toString().padStart(2, '0');
            const day = date.getUTCDate().toString().padStart(2, '0');
            const hours = date.getUTCHours().toString().padStart(2, '0');
            const minutes = date.getUTCMinutes().toString().padStart(2, '0');
            const seconds = date.getUTCSeconds().toString().padStart(2, '0');
            return `${year}-${month}-${day}-${hours}-${minutes}-${seconds}`;
        };

        const now = new Date(Date.now());
        const filename = `yomichan_browser_screenshot_${definition.reading}_${dateToString(now)}.${screenshot.format}`;
        const data = screenshot.dataUrl.replace(/^data:[\w\W]*?,/, '');

        try {
            await this.anki.storeMediaFile(filename, data);
        } catch (e) {
            return;
        }

        definition.screenshotFileName = filename;
    }

    static _getTabUrl(tab) {
        return new Promise((resolve) => {
            chrome.tabs.sendMessage(tab.id, {action: 'getUrl'}, {frameId: 0}, (response) => {
                let url = null;
                if (!chrome.runtime.lastError) {
                    url = (response !== null && typeof response === 'object' && !Array.isArray(response) ? response.url : null);
                    if (url !== null && typeof url !== 'string') {
                        url = null;
                    }
                }
                resolve({tab, url});
            });
        });
    }

    static async _findTab(timeout, checkUrl) {
        // This function works around the need to have the "tabs" permission to access tab.url.
        const tabs = await new Promise((resolve) => chrome.tabs.query({}, resolve));
        let matchPromiseResolve = null;
        const matchPromise = new Promise((resolve) => { matchPromiseResolve = resolve; });

        const checkTabUrl = ({tab, url}) => {
            if (checkUrl(url, tab)) {
                matchPromiseResolve(tab);
            }
        };

        const promises = [];
        for (const tab of tabs) {
            const promise = Backend._getTabUrl(tab);
            promise.then(checkTabUrl);
            promises.push(promise);
        }

        const racePromises = [
            matchPromise,
            Promise.all(promises).then(() => null)
        ];
        if (typeof timeout === 'number') {
            racePromises.push(new Promise((resolve) => setTimeout(() => resolve(null), timeout)));
        }

        return await Promise.race(racePromises);
    }

    static async _focusTab(tab) {
        await new Promise((resolve, reject) => {
            chrome.tabs.update(tab.id, {active: true}, () => {
                const e = chrome.runtime.lastError;
                if (e) { reject(e); }
                else { resolve(); }
            });
        });

        if (!(typeof chrome.windows === 'object' && chrome.windows !== null)) {
            // Windows not supported (e.g. on Firefox mobile)
            return;
        }

        try {
            const tabWindow = await new Promise((resolve, reject) => {
                chrome.windows.get(tab.windowId, {}, (tabWindow) => {
                    const e = chrome.runtime.lastError;
                    if (e) { reject(e); }
                    else { resolve(tabWindow); }
                });
            });
            if (!tabWindow.focused) {
                await new Promise((resolve, reject) => {
                    chrome.windows.update(tab.windowId, {focused: true}, () => {
                        const e = chrome.runtime.lastError;
                        if (e) { reject(e); }
                        else { resolve(); }
                    });
                });
            }
        } catch (e) {
            // Edge throws exception for no reason here.
        }
    }

    static async _getBrowser() {
        if (EXTENSION_IS_BROWSER_EDGE) {
            return 'edge';
        }
        if (typeof browser !== 'undefined') {
            try {
                const info = await browser.runtime.getBrowserInfo();
                if (info.name === 'Fennec') {
                    return 'firefox-mobile';
                }
            } catch (e) {
                // NOP
            }
            return 'firefox';
        } else {
            return 'chrome';
        }
    }

    static _getTemplates(options) {
        const templates = options.anki.fieldTemplates;
        return typeof templates === 'string' ? templates : profileOptionsGetDefaultFieldTemplates();
    }
}

Backend._messageHandlers = new Map([
    ['optionsSchemaGet', (self, ...args) => self._onApiOptionsSchemaGet(...args)],
    ['optionsGet', (self, ...args) => self._onApiOptionsGet(...args)],
    ['optionsGetFull', (self, ...args) => self._onApiOptionsGetFull(...args)],
    ['optionsSet', (self, ...args) => self._onApiOptionsSet(...args)],
    ['optionsSave', (self, ...args) => self._onApiOptionsSave(...args)],
    ['kanjiFind', (self, ...args) => self._onApiKanjiFind(...args)],
    ['termsFind', (self, ...args) => self._onApiTermsFind(...args)],
    ['textParse', (self, ...args) => self._onApiTextParse(...args)],
    ['textParseMecab', (self, ...args) => self._onApiTextParseMecab(...args)],
    ['definitionAdd', (self, ...args) => self._onApiDefinitionAdd(...args)],
    ['definitionsAddable', (self, ...args) => self._onApiDefinitionsAddable(...args)],
    ['noteView', (self, ...args) => self._onApiNoteView(...args)],
    ['templateRender', (self, ...args) => self._onApiTemplateRender(...args)],
    ['commandExec', (self, ...args) => self._onApiCommandExec(...args)],
    ['audioGetUrl', (self, ...args) => self._onApiAudioGetUrl(...args)],
    ['screenshotGet', (self, ...args) => self._onApiScreenshotGet(...args)],
    ['forward', (self, ...args) => self._onApiForward(...args)],
    ['frameInformationGet', (self, ...args) => self._onApiFrameInformationGet(...args)],
    ['injectStylesheet', (self, ...args) => self._onApiInjectStylesheet(...args)],
    ['getEnvironmentInfo', (self, ...args) => self._onApiGetEnvironmentInfo(...args)],
    ['clipboardGet', (self, ...args) => self._onApiClipboardGet(...args)],
    ['getDisplayTemplatesHtml', (self, ...args) => self._onApiGetDisplayTemplatesHtml(...args)],
    ['getZoom', (self, ...args) => self._onApiGetZoom(...args)]
]);

Backend._commandHandlers = new Map([
    ['search', (self, ...args) => self._onCommandSearch(...args)],
    ['help', (self, ...args) => self._onCommandHelp(...args)],
    ['options', (self, ...args) => self._onCommandOptions(...args)],
    ['toggle', (self, ...args) => self._onCommandToggle(...args)]
]);

window.yomichanBackend = new Backend();
window.yomichanBackend.prepare();
