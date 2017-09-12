/*
 * @author              Mitchell Field <mitchell.field@live.com.au>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */


// Set browser action.
browser.browserAction.onClicked.addListener(onBrowserAction);

// Set browser action title to localised version.
browser.browserAction.setTitle({
  title: browser.i18n.getMessage("browserAction_label")
});

// Listen to changes in storage.
browser.storage.onChanged.addListener(onStorageChanged);


const DISCARDABLE_TAB_URLS = new Set([
  "about:blank",
  "about:newtab",
  "about:privatebrowsing"
]);

const SORT_MODES = new Map([
  ["host_path_title", 0],
  ["host_title_path", 1],
  ["title_host_path", 2]
]);

const DEFAULT_PREFS = {
  "pref_tabSortByURL": "host_title_path",
  "pref_tabSortBySearchParams": "true"
};

const PREFS = Object.assign(DEFAULT_PREFS);

const cullingWindows = new Set();
const sortingWindows = new Set();

const hostnameTokenCache = new Map();
const pathnameTokenCache = new Map();
const tabPropsCache = new Map();


/*
 * Called when the "browser action" is invoked.
 */
function onBrowserAction() {
  sortTabs();
}


/*
 * Called when a storage area is changed.
 */
function onStorageChanged(changes, areaName) {
  if (areaName === "sync" && ("preferences" in changes)) {
    Object.assign(PREFS, changes.preferences.newValue);
  }
}


/*
 * Sorts tabs and removes blank tabs.
 */
function sortTabs() {
  const gettingCurrentWindow = browser.windows.getCurrent({
    populate: true,
    windowTypes: ["normal"]
  });

  gettingCurrentWindow.then(windowInfo => {
    const gettingUnpinnedTabs = browser.tabs.query({
      pinned: false,
      windowId: windowInfo.id
    });

    gettingUnpinnedTabs.then(unpinnedTabs => {

      const windowId = windowInfo.id;

      // Check if window is already being sorted.
      if (sortingWindows.has(windowId))
        return;

      sortingWindows.add(windowId);

      // Initialise various caches for the window.

      hostnameTokenCache.set(windowId, new Map());
      pathnameTokenCache.set(windowId, new Map());
      tabPropsCache.set(windowId, new Map());

      // Get first tab index.
      const {index} = unpinnedTabs[0];

      unpinnedTabs.sort(compareTabs);

      // Move tabs into place.
      const gettingMovedTabs = browser.tabs.move(
        unpinnedTabs.map(tab => tab.id), {index: index});

      gettingMovedTabs.then(tabsArray => {

        // Filter tabs which are relatively safe to remove.
        const blankTabs = tabsArray.filter(tab => {
          return DISCARDABLE_TAB_URLS.has(tab.url) && tab.status == "complete";
        });

        let gettingRemovedTabs;

        if (blankTabs.length > 0) {

          // Create a new blank tab to remain after culling.
          const gettingNewTab = browser.tabs.create({
            active: false,
            windowId: windowId
          });

          // Remove the older blank tabs.
          gettingRemovedTabs = gettingNewTab.then(
            browser.tabs.remove(blankTabs.map(tab => tab.id)));
        } else {

          // Remove all blank tabs.
          gettingRemovedTabs = browser.tabs.remove(
            blankTabs.map(tab => tab.id));
        }

        gettingRemovedTabs.then(removedTabs => {

          // Clear the window's caches.
          hostnameTokenCache.get(windowId).clear();
          pathnameTokenCache.get(windowId).clear();
          tabPropsCache.get(windowId).clear();

          // Allow the window's tabs to be sorted again.
          sortingWindows.delete(windowId);
        });
      });
    });
  });
}


/*
 * Gets certain properties of a tab.
 *
 * Tab properties are cached per-window for next access.
 *
 * @param tab           tab
 * @return              tab properties object
 */
function getTabProps(tab) {

  const {id: tabId, windowId} = tab;

  const tabPropsMap = tabPropsCache.get(windowId);
  let tabProps = tabPropsMap.get(tabId);

  if (tabProps)
    return tabProps;

  const {
    protocol = ':',
    hostname = '',
    pathname = '/',
    searchParams = '',
    hash = '#'
  } = new URL(tab.url || '');

  tabProps = {
    hostname,
    pathname,
    searchParams: searchParams.toString(),
    hash,
    hasAboutScheme: protocol === "about",
    hasPathname: pathname !== '/',
    title: tab.title || '',
  };

  tabPropsMap.set(tabId, tabProps);

  return tabProps;
}


/*
 * Compares tabs based on certain criteria.
 *
 * @param tabA          first tab for comparison
 * @param tabB          second tab for comparison
 * @return              comparison numeric result
 */
function compareTabs(tabA, tabB) {

  const propsA = getTabProps(tabA);
  const propsB = getTabProps(tabB);

  const windowIdA = tabA.windowId;
  const windowIdB = tabB.windowId;

  // Map the string preference value to a number.
  let sortMode = SORT_MODES.get(PREFS.pref_tabSortByURL);

  let result;

  if ((result = propsA.hasAboutScheme - propsB.hasAboutScheme) !== 0)
    return result;

  if (sortMode === 2) { // title-host-path sorting. Compare titles.
    if ((result = propsA.title.localeCompare(propsB.title)) !== 0)
      return result;
  }

  // Split the hostname's TLD from its lower-level domains.
  const [lowerDomainTokensA, tldA] = splitHostname(propsA.hostname, windowIdA);
  const [lowerDomainTokensB, tldB] = splitHostname(propsB.hostname, windowIdB);

  // Compare hostnames.
  if ((result = compareTokens(lowerDomainTokensA, lowerDomainTokensB)) !== 0)
    return result;

  // Compare TLDs.
  if ((result = compareTokens(tldA, tldB)) !== 0)
    return result;

  // Compare pathlessness.
  if ((result = propsA.hasPathname - propsB.hasPathname) !== 0)
    return result;

  if (sortMode === 1) { // host-title-path sorting. Compare titles.
    if ((result = propsA.title.localeCompare(propsB.title)) !== 0)
      return result;
  }

  // Compare pathnames.
  result = compareTokens(splitPathname(propsA.pathname, windowIdA),
    splitPathname(propsB.pathname, windowIdB));

  if (result !== 0)
    return result;

  // Compare search parameters.
  if ((result = propsA.searchParams.localeCompare(propsB.searchParams)) !== 0) {
    return result;
  }

  // Compare hashes (fragments).
  if ((result = propsA.hash.localeCompare(propsB.hash)) !== 0)
    return result;

  if (sortMode === 0) { // host-path-title. Compare titles.
    if ((result = propsA.title.localeCompare(propsB.title)) !== 0)
      return result;
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
 * @return              [lower-level domain tokens, top-level domain tokens]
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

  hostnameTokens = [tokens.slice(splitIndex), tokens.slice(0, splitIndex)];

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
