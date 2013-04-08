/*
 * @author		Mitchell Field <mitchell.field@live.com.au>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

"use strict";
const {Cc, Ci} = require("chrome");
const {Hotkey} = require("sdk/hotkeys");
const _ = require("sdk/l10n").get;
const notifications = require("sdk/notifications");
const prefs = require("sdk/preferences/service");
const self = require("sdk/self");
const simplePrefs = require("sdk/simple-prefs");
const tabs = require("sdk/tabs");
const timers = require("sdk/timers");
const url = require("sdk/url");
const windows = require("sdk/windows").browserWindows;
const idle = require("./idle");
const wm = Cc["@mozilla.org/appshell/window-mediator;1"]
			 .getService(Ci.nsIWindowMediator);
const prefNames = [
	"tabClobber",
	"tabLimitHard",
	"tabLimitSoft",
	"tabLimitWarningTimeout",
	"tabSortByHost",
	"tabSortByPath",
	"tabSortByTitle",
	"tabSortByPinned",
	"tabSortByPinnedThreshold",
	"tabSortOnHotkey",
	"tabSortOnIdle",
	"tabSortOnContextMenu"
];
const aboutPaths = new Set([
	"blank",
	"newtab",
	"privatebrowsing"
]);
const gTLDs = new Set([
	"aero",
	"asia",
	"biz",
	"cat",
	"com",
	"coop",
	"edu",
	"gov",
	"jobs",
	"mil",
	"mobi",
	"museum",
	"name",
	"net",
	"org",
	"post",
	"pro",
	"tel",
	"travel",
	"xxx"
]);

// pref vars
let clobber;
let hardLimit, softLimit, limitTimeout;
let sortByHost, sortByPath, sortByTitle;
let sortByPinned, sortByPinnedThreshold;
let sortOnHotkey, sortOnIdle, sortOnContextMenu;
let sortAllWindows;

const newTabs = new Set();
const sortingWindows = new Set();
let canWarn = true;
let isWarning = false;
let isUnloading = false;
let isSettingContextMenus = false;
let sortHotkey;
let warningTimeout;

// exports
exports.main = main;
exports.onUnload = onUnload;
exports.sortTabs = sortTabs;

/*
 * Initialises the addon.
 *
 * @param options		(unused) parameters with which the addon was loaded
 * @param callbacks		unused
 * @return				void
 */
function main(options, callbacks)
{
	onPrefChange(); // initialise pref vars
	for each (var pref in prefNames) {
		simplePrefs.on(pref, onPrefChange);
	}
	tabs.on("ready", tabReady);
	tabs.on("open", tabTrack);
	tabs.on("close", tabClosed);
	windows.on("open", setTabContextMenus);
}

/*
 * Deinitialises the addon.
 *
 * @param reason		(unused) reason for addon unloading
 * @return				void
 */
function onUnload(reason)
{
	if (isUnloading)
		return;
	isUnloading = true;
	idle.unregister();
	tabs.removeListener("ready", tabReady);
	tabs.removeListener("open", tabTrack);
	tabs.removeListener("close", tabClosed);
	for each (var pref in prefNames) {
		simplePrefs.removeListener(pref, onPrefChange);
	}
	if (sortHotkey) {
		sortHotkey.destroy();
		sortHotkey = null;
	}
	sortOnContextMenu = false;
	setTabContextMenus();
	newTabs.clear();
	sortingWindows.clear();
}

/*
 * Makes a rough guess of how many tokens are TLD parts.
 *
 * This doesn't need to be as accurate as the Public Suffix List
 * (http://publicsuffix.org) as some public suffixes are useful for
 * differentiating URL hosts.
 *
 * @param tokens		reversed URL host tokens (e.g. ["au", "com", "google"])
 * @return				estimated number of tokens which are TLD parts [0|1|2]
 */
function sizeOfTLD(tokens)
{
	if (tokens.length < 2)
		return 0;
	return (tokens[0].length === 2 && gTLDs.has(tokens[1])) ? 2 : 1;
}

/*
 * Sorts tabs of certain windows.
 *
 * @return				void
 */
function sortTabs()
{
	if (isUnloading)
		return;
	if (sortAllWindows) {
		for each (let window in windows) {
			sortWindow(window);
		}
	}
	else {
		sortWindow(windows.activeWindow);
	}
}

/*
 * Sorts tabs in a window.
 *
 * @param window		window containing tabs for sorting
 * @return 				void
 */
function sortWindow(window)
{
	if (!window || sortingWindows.has(window))
		return;
	sortingWindows.add(window);
	let sortingTabs = [];
	const windowTabs = window.tabs;
	const windowTabsLength = windowTabs.length;
	for (let i = 0; i < windowTabsLength; ++i) {
		sortingTabs[i] = windowTabs[i];
	}
	sortingTabs.sort(tabComparator);
	sortTabsByPinned(sortingTabs);
	try {
		for (let i = windowTabsLength - 1; i > -1; --i) {
			let tab = sortingTabs[i];
			if (!tab.isPinned)
				tab.index = i;
		}
	}
	catch (e) {
		// don't care
	}
	sortingWindows.delete(window);
}

/*
 * Compares certain pinned tabs with all other non-pinned tabs and sorts
 * the non-pinned tabs accordingly.
 *
 * The tabs are already sorted according to criteria such as URL host, title,
 * and/or URL path.
 * Splice, immediately after pinned tabs, a run of non-pinned tabs with at least
 * "simplePrefs.prefs.tabSortByPinnedThreshold" number of non-TLD host parts in
 * common with each pinned tab, according to user preference.
 *
 * @param sortingTabs	tabs (pinned and non-pinned) to be sorted
 * @return				void
 *
 */
function sortTabsByPinned(sortingTabs)
{
	if (!sortByPinnedThreshold || sortByPinned === "none")
		return;
	let pinnedTabs = [];
	for each (let someTab in sortingTabs) {
		if (!someTab.isPinned)
			continue;
		pinnedTabs.push(someTab);
	}
	let pinnedTabsLength = pinnedTabs.length;
	if (!pinnedTabsLength)
		return;
	let spliceInsertionIndex = pinnedTabsLength;
	let pinnedStart = (sortByPinned === "last") ? pinnedTabsLength - 1 : 0;
	pinnedTabs.sort(function (a, b) {
		if (a.index > b.index)
			return 1;
		if (b.index > a.index)
			return -1;
		return 0;
	});
	if (sortByPinned === "lastToFirst")
		pinnedTabs.reverse();
	const sortingTabsLength = sortingTabs.length;
	for (let i = pinnedStart; i < pinnedTabsLength; ++i) {
		let aTab = pinnedTabs[i];
		if (!aTab)
			continue;
		let aURL = url.URL(aTab.url || "");
		let aTokens = (aURL.host || "").split(".").reverse();
		let aTokensLength = aTokens.length;
		let similarityThreshold = sortByPinnedThreshold + sizeOfTLD(aTokens);
		let sliceStart = -1;
		let sliceSize = 0;
		for (let j = spliceInsertionIndex; j < sortingTabsLength; ++j) {
			let bTab = sortingTabs[j];
			if (bTab.isPinned)
				continue;
			let bURL = url.URL(bTab.url || "");
			let bTokens = (bURL.host || "").split(".").reverse();
			let bTokensLength = bTokens.length;
			let tokenIndex = 0;
			while (true) {
				let aEOT = tokenIndex >= aTokensLength;
				let bEOT = tokenIndex >= bTokensLength;
				if (aEOT || bEOT)
					break;
				if (aTokens[tokenIndex] !== bTokens[tokenIndex])
					break;
				++tokenIndex;
			}
			if (tokenIndex >= similarityThreshold) {
				if (sliceStart === -1)
					sliceStart = sortingTabs.indexOf(bTab);
				++sliceSize;
			}
			else if (sliceStart !== -1) {
				break;
			}
		}
		if (sliceSize > 0) {
			let similarTabs = sortingTabs.splice(sliceStart, sliceSize);
			for each (let similarTab in similarTabs) {
				sortingTabs.splice(spliceInsertionIndex, 0, similarTab);
				++spliceInsertionIndex;
			}
		}
	}
}

/*
 * Sort tabs based on certain criteria.
 *
 * @param aTab			first tab for comparison
 * @param bTab			second tab for comparison
 * @return				[-1|0|1]
 */
function tabComparator(aTab, bTab)
{
	if (!aTab || !bTab)
		return 0;
	const aPinned = aTab.isPinned;
	const bPinned = bTab.isPinned;
	// compare pinned states
	if (aPinned && bPinned)
		return 0;
	if (aPinned && !bPinned)
		return -1;
	if (!aPinned && bPinned)
		return 1;
	let compResult;
	let aTokens, bTokens;
	const aURL = url.URL(aTab.url || "");
	const bURL = url.URL(bTab.url || "");
	if (sortByHost || (!sortByTitle && !sortByPath) ||
		(sortByPinned !== "none" && sortByPinnedThreshold)) {
		const aHost = aURL.host || "";
		const bHost = bURL.host || "";
		aTokens = aHost.split(".").reverse();
		bTokens = bHost.split(".").reverse();
		compResult = tokensComparator(aTokens, bTokens, true);
		if (compResult < 0)
			return -1;
		if (compResult > 0)
			return 1;
	}
	if (sortByTitle) {
		const aTitle = aTab.title || "";
		const bTitle = bTab.title || "";
		compResult = aTitle.localeCompare(bTitle);
		if (compResult < 0)
			return -1;
		if (compResult > 0)
			return 1;
	}
	if (sortByPath) {
		const aPath = aURL.path || "";
		const bPath = bURL.path || "";
		aTokens = aPath.split(".");
		bTokens = bPath.split(".")
		compResult = tokensComparator(aTokens, bTokens);
		if (compResult < 0)
			return -1;
		if (compResult > 0)
			return 1;
	}
	return 0;
}

/*
 * Compares a list of tokens.
 *
 * Compares a token from one array to its corresponding token in the other array
 * until they sort differently or an array runs out of tokens to compare.
 *
 * @param aTokens		first array of tokens for comparison
 * @param bTokens		second array of tokens for comparison
 * @param isHost		search for TLDs in tokens; comparisons exclude TLDs
 * @return				[-1|0|1]
 */
function tokensComparator(aTokens, bTokens, isHost = false)
{
	const aTokensLength = aTokens.length;
	const bTokensLength = bTokens.length;
	let aTokenIndex = isHost ? sizeOfTLD(aTokens) : 0;
	let bTokenIndex = isHost ? sizeOfTLD(bTokens) : 0;
	while (true) {
		let aEOT = aTokenIndex >= aTokensLength;
		let bEOT = bTokenIndex >= bTokensLength;
		if (aEOT && bEOT) // all tokens compared and equal
			return 0;
		if (aEOT) {
			// All tokens from first array equal corresponding second array
			// tokens. Ran out of tokens to compare.
			return -1;
		}
		if (bEOT) {
			// All tokens from second array equal corresponding first array
			// tokens. Ran out of tokens to compare.
			return 1;
		}
		let aToken = aTokens[aTokenIndex];
		let bToken = bTokens[bTokenIndex];
		let compResult = aToken.localeCompare(bToken);
		if (compResult < 0)
			return -1;
		if (compResult > 0)
			return 1;
		++aTokenIndex;
		++bTokenIndex;
	}
}

/*
 * Acquire all user preferences for this addon.
 *
 * Any time a single preference is changed, *all* preferences are acquired.
 * Sets up events and hotkeys relevant to preferences.
 *
 * @param prefName		(unused) the individual preference which changed
 * @return				void
 */
function onPrefChange(prefName = null)
{
	const sPrefs = simplePrefs.prefs;
	clobber = sPrefs.tabClobber;
	softLimit = sPrefs.tabLimitSoft;
	hardLimit = sPrefs.tabLimitHard;
	limitTimeout = sPrefs.tabLimitWarningTimeout;
	sortByHost = sPrefs.tabSortByHost;
	sortByPath = sPrefs.tabSortByPath;
	sortByTitle = sPrefs.tabSortByTitle;
	sortByPinned = sPrefs.tabSortByPinned;
	sortByPinnedThreshold = sPrefs.tabSortByPinnedThreshold;
	sortAllWindows = ("tabSortAllWindows" in sPrefs) &&
					 sPrefs.tabSortAllWindows;
	sortOnHotkey = sPrefs.tabSortOnHotkey;
	sortOnIdle = sPrefs.tabSortOnIdle;
	sortOnContextMenu = sPrefs.tabSortOnContextMenu;
	setTabContextMenus();
	limitTimeout = isNaN(limitTimeout) ? 3000 : limitTimeout * 1000;
	if (sortHotkey) { // the hotkey instance
		sortHotkey.destroy();
		sortHotkey = null;
	}
	if (sortOnHotkey) { // the hotkey preference
		sortHotkey = new Hotkey({
			combo: sortOnHotkey,
			onPress: sortTabs
		});
	}
	idle.unregister();
	if (sortOnIdle) {
		idle.register("idle", sortTabs, sortOnIdle);
	}
}

/*
 * Tracks a new tab as such, and warns if the number of tabs has reached the
 * soft or hard limit.
 *
 * @param tab			the new tab which has opened
 * @return				void
 */
function tabTrack(tab)
{
	newTabs.add(tab);
	if (isWarning || !canWarn)
		return;
	isWarning = true;
	const tabsLength = tabs.length;
	if (hardLimit && tabsLength > hardLimit) {
		canWarn = false;
		notifications.notify({
			title: self.name,
			text: _("notifications.tabLimitHard", hardLimit)
		});
	}
	else if (softLimit && tabsLength > softLimit) {
		canWarn = false;
		notifications.notify({
			title: self.name,
			text: _("notifications.tabLimitSoft", softLimit)
		});
	}
	if (!canWarn) {
		timers.clearTimeout(warningTimeout);
		canWarn = false;
		if (limitTimeout)
			warningTimeout = timers.setTimeout(function () canWarn = true,
											   limitTimeout);
	}
	isWarning = false;
}

/*
 * Remove the closed tab from the "new tabs" set.
 *
 * @param tab			the tab which has closed
 * @return				void
 */
function tabClosed(tab)
{
	newTabs.delete(tab);
}

/*
 * Close the tab and remove it from the "new tabs" set.
 *
 * @param				the tab to close
 * @return				void
 */
function tabUntrack(tab)
{
	newTabs.delete(tab);
	tab.close();
}

/*
 * Called when any tab is ready.
 *
 * Only act when the ready tab is a "new tab". Check if the number of tabs has
 * reached the hard limit, then check if the tab is a duplicate.
 *
 * @param tab			which tab is ready
 * @return				void
 */
function tabReady(tab)
{
	if (!tab || !("url" in tab) || !newTabs.has(tab))
		return;
	newTabs.delete(tab);
	const tabsLength = tabs.length;
	const tabURL = tab.url;
	const tabURLObject = url.URL(tabURL);
	const hasAboutScheme = tabURLObject.scheme === "about";
	if (hardLimit && tabsLength > hardLimit) {
		if (!hasAboutScheme || aboutPaths.has(tabURLObject.path))
			tabUntrack(tab);
		return;
	}
	if (clobber === "none" || !tabURL)
		return;
	if (hasAboutScheme && aboutPaths.has(tabURLObject.path) ||
		tabURL === prefs.get("browser.newtab.url")) {
		return;
	}
	const clobberNew = clobber === "new";
	for (let i = 0; i < tabsLength; ++i) { // check for duplicates
		if (isUnloading)
			return;
		let someTab = tabs[i];
		if (!tab || !someTab || (tab === someTab))
			continue;
		let someTabURL = ("url" in someTab) && someTab.url;
		if (!tabURL || !someTabURL)
			continue;
		if (tabURL === someTabURL) {
			if (clobberNew) { // clobber new tab
				tabUntrack(tab);
				break;
			}
			else if (!someTab.isPinned) { // clobber existing tab
				tabUntrack(someTab);
			}
		}
	}
}

/*
 * Adds or removes "Sort Tabs" from the tab context menus of each window.
 *
 * @param window		unused
 * @return				void
 */
function setTabContextMenus(window = null)
{
	if (isSettingContextMenus)
		return;
	isSettingContextMenus = true;
	const enumerator = wm.getEnumerator("navigator:browser");
	const sortTabs_label = _("tabContextMenu.sortTabs.label");
	const sortTabs_accesskey = _("tabContextMenu.sortTabs.accesskey");
	while (enumerator.hasMoreElements()) {
		let win = enumerator.getNext();
		let gBrowser = win.gBrowser;
		let tabContextMenu = gBrowser.tabContextMenu;
		let context_sortTabs;
		let functionAttached = ("sortTabs" in gBrowser);
		if (sortOnContextMenu) {
			if (functionAttached)
				continue;
			gBrowser.sortTabs = sortTabs;
			context_sortTabs = createMenuItem(win.document,
											  "context_sortTabs",
											  sortTabs_label,
											  sortTabs_accesskey,
											  "gBrowser.sortTabs()");
			let context_reloadAllTabs_elements = tabContextMenu.getElementsByAttribute("id", "context_reloadAllTabs");
			if (context_reloadAllTabs_elements.length) {
				tabContextMenu.insertBefore(context_sortTabs, context_reloadAllTabs_elements[0]);
			}
			else {
				tabContextMenu.appendChild(context_sortTabs);
			}
		}
		else if (functionAttached) {
			delete gBrowser.sortTabs;
			context_sortTabs = tabContextMenu.getElementsByAttribute("id", "context_sortTabs")[0];
			tabContextMenu.removeChild(context_sortTabs);
		}
	}
	isSettingContextMenus = false;
}

/*
 * Creates and returns a new menuitem.
 *
 * @param document		document inside which the new menuitem is created
 * @param id			id of new menuitem
 * @param label			label of new menuitem
 * @param accesskey		accesskey of new menuitem
 * @param command		command of new menuitem
 * @return				new menuitem
 */
function createMenuItem(document, id, label, accesskey, command)
{
	const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
	const item = document.createElementNS(XUL_NS, "menuitem");
	item.setAttribute("id", id);
	item.setAttribute("label", label);
	item.setAttribute("accesskey", accesskey);
	item.setAttribute("oncommand", command);
	return item;
}
