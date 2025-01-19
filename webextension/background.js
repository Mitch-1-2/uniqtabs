/*
 * @file                Background script.
 * @author              Mitchell Field <mitchell.field@live.com.au>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import "./browser-polyfill.js";
import { PREFS_DEFAULT } from "./prefs.js";

// URLs of pages with state that isn't important enough to keep.
// Considered blank.
const BLANK_TAB_URLS = new Set([
  "about:blank",
  "about:newtab",
  "about:privatebrowsing",
  "chrome://newtab/"
]);

const SORT_MODES = new Map([
  ["none", 0],
  ["host_title_path", 1],
  ["host_path_title", 2],
  ["title_host_path", 3],
  ["auto", 4]
]);

const PREFS = Object.assign(PREFS_DEFAULT);

// Get "sync" storage contents.
browser.storage.sync.get().then(async storedObject => {

  // Merge preferences with preferences from storage.
  Object.assign(PREFS, PREFS_DEFAULT, storedObject.preferences);
  return updateUI();
});

// Set browser action.
browser.action.onClicked.addListener(onBrowserAction);

// Listen to changes in storage.
browser.storage.onChanged.addListener(onStorageChanged);

// Listen for tab updates.
browser.tabs.onUpdated.addListener(onTabUpdated);

class TabProps {
  #lowerDomainTokens = null;
  #maybeSlug = null;
  #pathnameTokens = null;
  #tldTokens = null;
  isDuplicate = false;

  constructor(tab, windowProps, containers, sortPrefs) {
    let url;
    ({
      active: this.isActive,
      id: this.id,
      index: this.index,
      status: this.status,
      title: this.title = "",
      url,
      windowId: this.windowId
    } = tab);

    this.isBlank = BLANK_TAB_URLS.has(url);
    this.windowProps = windowProps;

    let protocol, pathname, searchParams;
    ({
      protocol = ":",
      hostname: this.hostname = "",
      pathname = "",
      searchParams = "",
      hash: this.hash = "#"
    } = new URL(url || ""));

    this.pathname = pathname.replace(/^\/|\/$/g, ""); // trim slashes

    const hasPathname = this.pathname !== "";
    const containerIndex = containers?.get(tab?.cookieStoreId) || -1;

    const {
      sortMode,
      sortByQueryString
    } = sortPrefs;

    this.queryString = sortByQueryString ? searchParams.toString() : "";

    const domainCriteria = [this.lowerDomainTokens, this.tldTokens, hasPathname];
    const pathCriteria = [this.pathnameTokens, this.queryString, this.hash];
    this.dupeCriteria = [
      containerIndex, protocol, ...domainCriteria, ...pathCriteria, this.title
    ].join("\u0010") || "";
    let criteria;

    switch (sortMode) {
      case 1:
        criteria = [containerIndex, protocol, ...domainCriteria, this.title, ...pathCriteria];
        break;
      case 2:
        this.sortCriteria = this.dupeCriteria;
        return;
      case 3:
        criteria = [containerIndex, protocol, this.title, ...domainCriteria, ...pathCriteria];
        break;
      case 4:
        criteria = [containerIndex, protocol, ...domainCriteria];
        break;
      default:
        criteria = [containerIndex];
        break;
    }
    this.sortCriteria = criteria.join("\u0010") || "";
  }

  get lowerDomainTokens() {
    if (!this.#lowerDomainTokens) {
      [this.#tldTokens, this.#lowerDomainTokens] =
        this.windowProps.getHostnameTokens(this.hostname);
    }
    return this.#lowerDomainTokens;
  }

  get pathnameTokens() {
    return this.#pathnameTokens ??= this.windowProps.getPathnameTokens(this.pathname);
  }

  get maybeSlug() {
    if (this.#maybeSlug === null) {
      const pathEnd = this.pathnameTokens.at(-1);
      const titleSlugged = this.title.replace(/ /g,"_").toLocaleLowerCase().replace(/\W/g, "");

      // First character of path end matches the first character of slugged title.
      // Naively presume that the path end is a slug.
      this.#maybeSlug = pathEnd.charAt(0) === titleSlugged.charAt(0) ? pathEnd : "";
    }
    return this.#maybeSlug;
  }

  get tldTokens() {
    if (!this.#tldTokens) {
      [this.#tldTokens, this.#lowerDomainTokens] =
        this.windowProps.getHostnameTokens(this.hostname);
    }
    return this.#tldTokens;
  }
}


class WindowProps {
  static #windows = new Set();
  #hostnameTokenCache = new Map();
  #pathnameTokenCache = new Map();

  static hasWindowById(windowId) {
    return WindowProps.#windows.has(windowId);
  }

  constructor(windowId) {
    WindowProps.#windows.add(this.windowId = windowId);
  }

  /*
   * Roughly split hostname into top-level and lower-level domain tokens.
   *
   * @param hostname      hostname
   * @return              [top-level domain tokens, lower-level domain tokens]
   */
  getHostnameTokens(hostname) {
    let hostnameTokens = this.#hostnameTokenCache.get(hostname);
    if (!hostnameTokens) {
      const tokens = hostname.split(".").reverse();
      const splitIndex = (tokens.length > 2 && tokens[1].length <= 3) ? 2 : 1;
      hostnameTokens = [tokens.slice(0, splitIndex), tokens.slice(splitIndex)];
      this.#hostnameTokenCache.set(hostname, hostnameTokens);
    }
    return hostnameTokens;
  }

  /*
   * Split pathname into tokens.
   *
   * @param hostname      pathname
   * @return              [pathname tokens]
   */
  getPathnameTokens(pathname) {
    let pathnameTokens = this.#pathnameTokenCache.get(pathname);
    if (!pathnameTokens) {
      pathnameTokens = pathname.split("/");
      this.#pathnameTokenCache.set(pathname, pathnameTokens);
    }
    return pathnameTokens;
  }

  clear() {
    this.#hostnameTokenCache.clear();
    this.#pathnameTokenCache.clear();
    WindowProps.#windows.delete(this.windowId);
  }
}


/*
 * Called when the "browser action" is invoked.
 */
function onBrowserAction(tab, onClickData) {
  "use strict";

  const prefs = Object.assign({}, PREFS);
  const sort = prefs.pref_tabs_sort_on_browser_action === "true" &&
    prefs.pref_tabs_sort_by_parts !== "none";

  const deduplicate = prefs.pref_tabs_deduplicate_on_browser_action === "true";

  if (sort || deduplicate)
    return processTabs(tab.windowId, sort, deduplicate, prefs);

  // The browser action is not configured to sort nor deduplicate tabs.
  return browser.runtime.openOptionsPage();
}


/*
 * Called when a storage area is changed.
 */
async function onStorageChanged(changes, areaName) {
  "use strict";

  if (areaName !== "sync" || !("preferences" in changes)) {
    return;
  }

  Object.assign(PREFS, changes.preferences.newValue);
  return updateUI();
}


function onTabUpdated(tabId, changeInfo, tab) {
  "use strict";

  const prefs = Object.assign({}, PREFS);
  const sort = prefs.pref_tabs_sort_on_update === "true" &&
    (prefs.pref_tabs_sort_by_container === "true" ||
    prefs.pref_tabs_sort_by_parts !== "none");
  const deduplicate = prefs.pref_tabs_deduplicate_on_update === "true";

  if (changeInfo.status !== "complete" || !changeInfo.status)
    return;

  if (sort || deduplicate)
    return processTabs(tab.windowId, sort, deduplicate, prefs);
}


/*
 * Updates UI elements such as titles and descriptions.
 */
function updateUI() {
  "use strict";

  const sort = PREFS.pref_tabs_sort_on_browser_action === "true" &&
    PREFS.pref_tabs_sort_by_parts !== "none";
  const deduplicate = PREFS.pref_tabs_deduplicate_on_browser_action === "true";

  // Default browser action title.
  let titleID = "browser_action_none_label";
  let shortcutDescriptionID = "browser_action_shortcut_none_label";

  if (sort) {
    if (deduplicate) {

      // Sort and deduplicate.
      titleID = "browser_action_sort_deduplicate_label";
      shortcutDescriptionID = "browser_action_shortcut_sort_deduplicate_label";
    } else {

      // Sort.
      titleID = "browser_action_sort_label";
      shortcutDescriptionID = "browser_action_shortcut_sort_label";
    }
  } else if (deduplicate) {

    // Deduplicate.
    titleID = "browser_action_deduplicate_label";
    shortcutDescriptionID = "browser_action_deduplicate_label";
  }

  // Set browser action title.
  browser.action.setTitle({
    title: browser.i18n.getMessage(titleID)
  });

  // Set browser action shortcut description.
  if ("update" in browser.commands) {
    browser.commands.update({
      name: "_execute_action",
      description: browser.i18n.getMessage(shortcutDescriptionID)
    });
  }
}


/*
 * Sorts, deduplicates, and removes low-priority (or blank) tabs.
 *
 * @param windowId      window ID
 * @param sort          sort tabs
 * @param deduplicate   deduplicate tabs
 * @param prefs         preferences
 */
async function processTabs(windowId, sort, deduplicate, prefs) {
  "use strict";

  if (WindowProps.hasWindowById(windowId))
    return Promise.resolve();

  const windowProps = new WindowProps(windowId);
  const unpinnedTabs = await browser.tabs.query({
    pinned: false,
    windowId
  });

  if (!unpinnedTabs?.length) {
    windowProps.clear();
    return Promise.resolve();
  }

  // Get first tab index.
  const index = unpinnedTabs[0].index;

  let containers = null;
  if (("contextualIdentities" in browser) && prefs.pref_tabs_sort_by_container === "true") {
    try {
      const containersArray = await browser.contextualIdentities.query({});
      containers = new Map(
        containersArray.map((c, i) => [c.cookieStoreId, i])
      );
    } catch (err) {}
  }

  const sortMode = SORT_MODES.get(prefs.pref_tabs_sort_by_parts);
  const sortPrefs = {
    sortMode,
    sortByQueryString: prefs.pref_tabs_sort_by_query_string === "true"
  }

  const tabPropsArray = unpinnedTabs.map(
    unpinnedTab => new TabProps(unpinnedTab, windowProps, containers, sortPrefs)
  );

  if (sort)
    await sortTabs(tabPropsArray, index, sortMode);
  await deduplicateTabs(windowId, tabPropsArray, index, deduplicate);

  tabPropsArray.length = 0;
  windowProps.clear();
  return Promise.resolve();
}


/*
 * Sorts tabs.
 *
 * @param windowId      window ID
 * @param index         index of first unpinned tab
 * @param sortMode      preferences
 */
async function sortTabs(tabPropsArray, index, sortMode) {
  "use strict";

  const comparator = sortMode === 4 ? compareTabsOrderAuto : compareTabsOrder;

  // Sort and move tabs into place.
  return browser.tabs.move(
    tabPropsArray.sort(comparator).map(tabProps => tabProps.id),
    { index }
  ).catch((err) => Promise.resolve());
}


/*
 * Deduplicates, and removes low-priority (or blank) tabs.
 *
 * @param windowId      window ID
 * @param sort          sort tabs
 * @param deduplicate   deduplicate tabs
 * @param prefs         preferences
 */
async function deduplicateTabs(windowId, tabPropsArray, index, deduplicate) {
  "use strict";

  tabPropsArray.sort(compareTabsSimilarity);

  // Filter duplicate and blank tabs.
  const unwantedTabs = tabPropsArray.filter(tabProps =>
    tabProps.status === "complete" &&
      (tabProps.isBlank || deduplicate && tabProps.isDuplicate)
  );

  // Create a new tab to remain after culling.
  if (index === 0 && tabPropsArray.length === unwantedTabs.length) {
    return browser.tabs.create({
      active: false,
      windowId: windowId
    }).finally(browser.tabs.remove(unwantedTabs.map(tab => tab.id)));
  }

  return browser.tabs.remove(unwantedTabs.map(tab => tab.id))
}


/*
 * Compares tabs to determine order.
 *
 * @param propsA        first tab properties
 * @param propsB        second tab properties
 * @return              numeric result
 */
function compareTabsOrder(propsA, propsB) {
  "use strict";

  return propsA.sortCriteria.localeCompare(propsB.sortCriteria);
}


/*
 * Compares tabs to heuristically determine order.
 *
 * @param propsA        first tab properties
 * @param propsB        second tab properties
 * @return              numeric result
 */
function compareTabsOrderAuto(propsA, propsB) {
  "use strict";
  
  let result;
  if ((result = compareTabsOrder(propsA, propsB)))
    return result;

  const tokensA = propsA.pathnameTokens;
  const tokensB = propsB.pathnameTokens;
  const tokensLengthA = tokensA.length;
  const tokensLengthB = tokensB.length;
  const tokensLength = Math.min(tokensLengthA, tokensLengthB);
  const tokensLengthDiff = tokensLengthA - tokensLengthB;

  let index = 0;
  for (index = 0; index < tokensLength; ++index) {
    if ((result = tokensA[index].localeCompare(tokensB[index])))
      break;
  }

  if (tokensLengthDiff)
    return result || tokensLengthDiff;

  if (result && index > 1) {
    const maybeSlugA = propsA.maybeSlug;
    const maybeSlugB = propsB.maybeSlug;
    if (maybeSlugA !== "" && maybeSlugB !== "")
      return maybeSlugA.localeCompare(maybeSlugB);
  }

  return propsA.title.localeCompare(propsB.title) ||
    propsA.queryString.localeCompare(propsB.queryString) ||
    propsA.hash.localeCompare(propsB.hash);
}


/*
 * Compares tabs to determine similarity.
 *
 * @param propsA        first tab properties
 * @param propsB        second tab properties
 * @return              numeric result
 */
function compareTabsSimilarity(propsA, propsB) {
  "use strict";

  const result = propsA.dupeCriteria.localeCompare(propsB.dupeCriteria);

  if (!result) {
    if (propsA.isActive)
      propsB.isDuplicate = true;
    else if (propsB.isActive || propsA.index < propsB.index)
      propsA.isDuplicate = true;
  }

  return result;
}


/*
 * Compares a list of tokens.
 *
 * Compare a token from one array to its corresponding token in the other array
 * until they sort differently or an array runs out of tokens to compare.
 *
 * @param tokensA       first array of tokens for comparison
 * @param tokensB       second array of tokens for comparison
 * @return              comparison numeric result
 */
function compareTokens(tokensA, tokensB) {
  "use strict";

  if (tokensA === tokensB)
    return 0;

  for (let index = 0; ; ++index) {
    let result = tokensA[index]?.localeCompare(tokensB[index] ?? "");
    if (result)
      return result;
    if (result === undefined)
      return tokensA.length - tokensB.length;
  }
}
