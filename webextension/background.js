/*
 * @author              Mitchell Field <mitchell.field@live.com.au>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */


// Set browser action.
browser.browserAction.onClicked.addListener(onBrowserAction);

// Set default browser action title.
browser.browserAction.setTitle({
  title: browser.i18n.getMessage("browserAction_none_label")
});

// Listen to changes in storage.
browser.storage.onChanged.addListener(onStorageChanged);


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
  "pref_tabDeduplicate": "false",
  "pref_tabSortByParts": "none",
  "pref_tabSortBySearchParams": "true"
};

const PREFS = Object.assign(DEFAULT_PREFS);

const cullingWindows = new Set();
const sortingWindows = new Set();

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
    hasAboutScheme: protocol === "about",
    hasPathname: pathname !== '/',
    hash,
    hostname,
    id,
    index,
    isDiscardable: DISCARDABLE_TAB_URLS.has(url),
    isDuplicate: false,
    pathname,
    searchParams: searchParams.toString(),
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
  let sort = PREFS.pref_tabSortByParts !== "none";
  let deduplicate = PREFS.pref_tabDeduplicate === "true";

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

  let sort = PREFS.pref_tabSortByParts !== "none";
  let deduplicate = PREFS.pref_tabDeduplicate === "true";

  // Default browser action title.
  let titleMessageID = "browserAction_none_label";

  if (sort) {
    if (deduplicate) {

      // Sort and deduplicate.
      titleMessageID = "browserAction_sort_deduplicate_label";
    } else {

      // Sort.
      titleMessageID = "browserAction_sort_label";
    }
  } else if (deduplicate) {

    // Deduplicate.
    titleMessageID = "browserAction_deduplicate_label";
  }

  // Set browser action title.
  browser.browserAction.setTitle({
    title: browser.i18n.getMessage(titleMessageID)
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
    if (sortingWindows.has(windowId))
      return;

    sortingWindows.add(windowId);

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
      const gettingNewTab = browser.tabs.create({
        active: false,
        windowId: windowId
      });

      // Remove tabs.
      return gettingNewTab.then(
        browser.tabs.remove(unwantedTabs.map(tab => tab.id)));
    } else {
      return browser.tabs.remove(unwantedTabs.map(tab => tab.id));
    }
  }).then(removedTabs => {

    // Clear the window's caches.
    hostnameTokenCache.get(windowId).clear();
    pathnameTokenCache.get(windowId).clear();

    // Allow the window's tabs to be sorted again.
    sortingWindows.delete(windowId);
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
  let sortMode = SORT_MODES.get(PREFS.pref_tabSortByParts);

  let result;

  if ((result = propsA.hasAboutScheme - propsB.hasAboutScheme) !== 0)
    return result;

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

  // Compare search parameters.
  if ((result = propsA.searchParams.localeCompare(propsB.searchParams)) !== 0)
    return result;

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

  const tokensALength = tokensA.length;
  const tokensBLength = tokensB.length;

  for (let tokenIndex = 0; ; ++tokenIndex) {
    const isEndedA = tokenIndex >= tokensALength; // End of 'A' tokens.
    const isEndedB = tokenIndex >= tokensBLength; // End of 'B' tokens.

    if (isEndedA || isEndedB)
      return isEndedB - isEndedA;

    const tokenA = tokensA[tokenIndex];
    const tokenB = tokensB[tokenIndex];
    const result = tokenA.localeCompare(tokenB);

    if (result !== 0)
      return result;
  }

  return 0;
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
  let splitIndex;
  
  if (tokensLength > 2) {
    splitIndex = tokens[1].length <= 3 ? 2 : 1;
  } else {
    splitIndex = 1;
  }

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
