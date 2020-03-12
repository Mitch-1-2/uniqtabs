/*
 * @author              Mitchell Field <mitchell.field@live.com.au>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */


const DISCARDABLE_TAB_URLS = new Set([
  "about:blank",
  "about:newtab",
  "about:privatebrowsing"
]);

const SORT_MODES = new Map([
  ["none", 0],
  ["host_title_path", 1],
  ["host_path_title", 2],
  ["title_host_path", 3]
]);

const DEFAULT_PREFS = {
  "pref_tabs_deduplicate": "false",
  "pref_tabs_sort_by_parts": "none",
  "pref_tabs_sort_by_query_string": "true"
};

const PREFS = Object.assign(DEFAULT_PREFS);

// Get "sync" storage contents.
browser.storage.sync.get().then((storedObject) => {

  // Merge preferences with preferences from storage.
  Object.assign(PREFS, DEFAULT_PREFS, storedObject.preferences);
  updateUI();
});

// Set browser action.
browser.browserAction.onClicked.addListener(onBrowserAction);

// Listen to changes in storage.
browser.storage.onChanged.addListener(onStorageChanged);

const processingWindows = new Set();

const hostnameTokenCache = new Map();
const pathnameTokenCache = new Map();


function TabProps(tab) {
  const { id, index, status, title, url, windowId } = tab;

  const {
    protocol = ':',
    hostname = '',
    pathname = '/',
    searchParams = '',
    hash = '#'
  } = new URL(url || '');

  Object.assign(this, {
    _lowerDomainTokens: null,
    _pathnameTokens: null,
    _tldTokens: null,
    hasAboutScheme: protocol === "about:",
    hasPathname: pathname !== '/',
    hash,
    hostname,
    id,
    index,
    isDiscardable: DISCARDABLE_TAB_URLS.has(url),
    isDuplicate: false,
    pathname,
    queryString: searchParams.toString(),
    status,
    tab,
    title: title || '',
    url,
    windowId
  });
}

TabProps.prototype = {
  get lowerDomainTokens() {
    if (!this._lowerDomainTokens) {
      const hostnameTokens = splitHostname(this.hostname, this.windowId);
      this._tldTokens = hostnameTokens[0];
      this._lowerDomainTokens = hostnameTokens[1];
    }
    return this._lowerDomainTokens;
  },
  get pathnameTokens() {
    if (!this._pathnameTokens) {
      this._pathnameTokens = splitPathname(this.pathname, this.windowId);
    }
    return this._pathnameTokens;
  },
  get tldTokens() {
    if (!this._tldTokens) {
      const hostnameTokens = splitHostname(this.hostname, this.windowId);
      this._tldTokens = hostnameTokens[0];
      this._lowerDomainTokens = hostnameTokens[1];
    }
    return this._tldTokens;
  }
}


/*
 * Called when the "browser action" is invoked.
 */
function onBrowserAction(tab, onClickData) {
  const sort = PREFS.pref_tabs_sort_by_parts !== "none";
  const deduplicate = PREFS.pref_tabs_deduplicate === "true";

  if (!sort && !deduplicate) {

    // The browser action is not configured to sort nor deduplicate tabs.
    browser.runtime.openOptionsPage();
    return;
  }

  processTabs(tab.windowId, sort, deduplicate);
}


/*
 * Called when a storage area is changed.
 */
function onStorageChanged(changes, areaName) {
  if (areaName !== "sync" || !("preferences" in changes)) {
    return;
  }

  Object.assign(PREFS, changes.preferences.newValue);
  updateUI();
}


/*
 * Updates UI elements such as titles and descriptions.
 */
function updateUI() {
  let sort = PREFS.pref_tabs_sort_by_parts !== "none";
  let deduplicate = PREFS.pref_tabs_deduplicate === "true";

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
  browser.browserAction.setTitle({
    title: browser.i18n.getMessage(titleID)
  });

  // Set browser action shortcut description.
  browser.commands.update({
    name: "_execute_browser_action",
    description: browser.i18n.getMessage(shortcutDescriptionID)
  });
}


/*
 * Sorts, deduplicates, and removes low-priority (or blank) tabs.
 *
 * @param windowId      window ID
 * @param sort          sort tabs
 * @param deduplicate   deduplicate tabs
 */
function processTabs(windowId, sort, deduplicate) {

  let tabPropsArray;

  const gettingTabs = browser.tabs.query({
    pinned: false,
    windowId,
  }).then(unpinnedTabs => {

    // Check if window is already being sorted.
    if (processingWindows.has(windowId))
      return;

    processingWindows.add(windowId);

    // Initialise various caches for the window.
    hostnameTokenCache.set(windowId, new Map());
    pathnameTokenCache.set(windowId, new Map());

    tabPropsArray = unpinnedTabs.map(unpinnedTab => new TabProps(unpinnedTab));

    // Get sorting order for tabs.
    tabPropsArray.sort(compareTabs);

    if (!sort)
      return;

    // Get first tab index.
    const {index} = unpinnedTabs[0];

    // Move tabs into place.
    return browser.tabs.move(
      tabPropsArray.map(tabProps => tabProps.id), { index });
  }).then(() => {

    // Filter duplicate and discardable tabs.
    const unwantedTabs = tabPropsArray.filter(tabProps =>
      tabProps.status === "complete" &&
        (tabProps.isDiscardable || deduplicate && tabProps.isDuplicate));

    // Check for discardable tabs.
    const hasDiscardableTabs = tabPropsArray.some(tabProps =>
      tabProps.status === "complete" && tabProps.isDiscardable);

    if (hasDiscardableTabs) {

      // Create a new tab to remain after culling.
      return browser.tabs.create({
        active: false,
        windowId: windowId
      }).then(browser.tabs.remove(unwantedTabs.map(tab => tab.id)));
    } else {
      return browser.tabs.remove(unwantedTabs.map(tab => tab.id));
    }
  }).then(removedTabs => {

    // Clear the window's caches.
    hostnameTokenCache.get(windowId).clear();
    pathnameTokenCache.get(windowId).clear();

    // Allow the window's tabs to be sorted again.
    processingWindows.delete(windowId);
  });
}


/*
 * Compares tabs based on certain criteria.
 *
 * @param propsA        first tab properties for comparison
 * @param propsB        second tab properties for comparison
 * @return              comparison numeric result
 */
function compareTabs(propsA, propsB) {

  // Map the string preference value to a number.
  const sortMode = SORT_MODES.get(PREFS.pref_tabs_sort_by_parts);
  let result;

  if ((result = propsB.hasAboutScheme - propsA.hasAboutScheme) !== 0)
    return result;

  if (propsA.hasAboutScheme) { // Both tab URLs have "about:" schemes.

    // Compare pathnames.
    return propsA.pathname.localeCompare(propsB.pathname);
  }

  if (sortMode === 3) { // title-host-path sorting. Compare titles.
    if ((result = propsA.title.localeCompare(propsB.title)) !== 0)
      return result;
  }

  // Compare hostnames.
  if ((result =
    compareTokens(propsA.lowerDomainTokens, propsB.lowerDomainTokens)) !== 0)
    return result;

  // Compare TLDs.
  if ((result = compareTokens(propsA.tldTokens, propsB.tldTokens)) !== 0)
    return result;

  // Compare pathlessness.
  if ((result = propsA.hasPathname - propsB.hasPathname) !== 0)
    return result;

  if (sortMode === 1) { // host-title-path sorting. Compare titles.
    if ((result = propsA.title.localeCompare(propsB.title)) !== 0)
      return result;
  }

  // Compare pathnames.
  result = compareTokens(propsA.pathnameTokens, propsB.pathnameTokens);
  if (result !== 0)
    return result;

  // Compare query strings.
  if (PREFS.pref_tabs_sort_by_query_string) {
    if ((result = propsA.queryString.localeCompare(propsB.queryString)) !== 0)
      return result;
  }

  // Compare hashes (fragments).
  if ((result = propsA.hash.localeCompare(propsB.hash)) !== 0)
    return result;

  if (sortMode === 2) { // host-path-title. Compare titles.
    if ((result = propsA.title.localeCompare(propsB.title)) !== 0)
      return result;
  }

  // The two tabs are considered duplicate. Mark the later tab as a duplicate.
  if (propsA.index < propsB.index) {
    propsB.isDuplicate = true;
  } else {
    propsA.isDuplicate = true;
  }

  return 0;
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

  const tokensLengthA = tokensA.length;
  const tokensLengthB = tokensB.length;
  const shortestLength = Math.min(tokensLengthA, tokensLengthB);
  let result = 0;

  for (let index = 0; index < shortestLength; ++index) {
    if ((result = tokensA[index].localeCompare(tokensB[index])) !== 0)
      break;
  }

  return result === 0 ? Math.sign(tokensLengthA - tokensLengthB) : result;
}


/*
 * Roughly split hostname into top-level and lower-level domains.
 *
 * Will set/get cache entries by hostname and window ID.
 *
 * @param hostname      URL hostname
 * @param windowId      ID of associated window
 * @return              [top-level domain tokens, lower-level domain tokens]
 */
function splitHostname(hostname, windowId) {

  const tokensMap = hostnameTokenCache.get(windowId);
  let hostnameTokens = tokensMap.get(hostname);

  if (hostnameTokens)
    return hostnameTokens;

  const tokens = hostname.split('.').reverse();
  const tokensLength = tokens.length;
  const splitIndex = (tokensLength > 2 && tokens[1].length <= 3) ? 2 : 1;
  hostnameTokens = [tokens.slice(0, splitIndex), tokens.slice(splitIndex)];
  tokensMap.set(hostname, hostnameTokens);

  return hostnameTokens;
}


/*
 * Split pathname into tokens.
 *
 * Will set/get cache entries by pathname and window ID.
 *
 * @param hostname      URL pathname
 * @param windowId      ID of associated window
 * @return              [pathname tokens]
 */
function splitPathname(pathname, windowId) {

  const tokensMap = pathnameTokenCache.get(windowId);
  let pathnameTokens = tokensMap.get(pathname);

  if (pathnameTokens)
    return pathnameTokens;

  pathnameTokens = pathname.split('/');

  tokensMap.set(pathname, pathnameTokens);

  return pathnameTokens;
}
