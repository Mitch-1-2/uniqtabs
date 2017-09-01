/*
 * @author              Mitchell Field <mitchell.field@live.com.au>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */


// Set browser action.
browser.browserAction.onClicked.addListener(sort);

// Set browser action title to localised version.
browser.browserAction.setTitle({
    title: browser.i18n.getMessage("sortTabs")
});


const DISCARDABLE_TAB_URLS = new Set([
  "about:blank",
  "about:newtab",
  "about:privatebrowsing"
]);

const SORT_MODES = new Map([
  ["host-path-title", 0],
  ["host-title-path", 1],
  ["title", 2]
]);

const cullingWindows = new Set();
const sortingWindows = new Set();

const hostnameTokenCache = new Map();
const pathnameTokenCache = new Map();


/*
 * Sorts tabs and removes blank tabs.
 */
function sort() {
  const currentWindowPromise = browser.windows.getCurrent({
    populate: true,
    windowTypes: ["normal"]
  });

  currentWindowPromise.then(windowInfo => {
    const unpinnedTabsPromise = browser.tabs.query({
      pinned: false,
      windowId: windowInfo.id
    });

    unpinnedTabsPromise.then(unpinnedTabs => {

      // Check if window is already being sorted.
      if (sortingWindows.has(windowInfo.id))
        return;

      sortingWindows.add(windowInfo.id);

      // Get first tab index.
      const {index} = unpinnedTabs[0];

      unpinnedTabs.sort(compareTabs);

      // Move tabs into place.
      const movedTabsPromise = browser.tabs.move(
        unpinnedTabs.map(tab => tab.id), {index: index});

      movedTabsPromise.then(tabsArray => {

        // Filter tabs which are relatively safe to remove.
        const blankTabs = tabsArray.filter(tab => {
          return DISCARDABLE_TAB_URLS.has(tab.url) && tab.status == "complete";
        });

        let removedTabsPromise;

        if (blankTabs.length > 0) {

          // Create a new blank tab to remain after culling.
          const newTabPromise = browser.tabs.create({
            active: false,
            windowId: windowInfo.id
          });

          // Remove the older blank tabs.
          removedTabsPromise = newTabPromise.then(
            browser.tabs.remove(blankTabs.map(tab => tab.id)));
        } else {

          // Remove all blank tabs.
          removedTabsPromise = browser.tabs.remove(
            blankTabs.map(tab => tab.id));
        }

        // Allow the window to be sorted again.
        removedTabsPromise.then(removedTabs => {
          hostnameTokenCache.clear();
          pathnameTokenCache.clear();
          sortingWindows.delete(windowInfo.id);
        });
      });
    });
  });
}


/*
 * Compares tabs based on certain criteria.
 *
 * @param tabA          first tab for comparison
 * @param tabB          second tab for comparison
 * @return              comparison numeric result
 */
function compareTabs(tabA, tabB) {

  if (!tabA.url || !tabB.url)
    return;

  // Destructure tab 'A' URL.
  const {
    protocol: protocolA = ':',
    hostname: hostnameA = '',
    pathname: pathnameA = '/',
    hash: hashA = '#'
  } = new URL(tabA.url);

  const hasAboutSchemeA = protocolA === "about";

  const titleA = tabA.title || '';

  // Destructure tab 'B' URL.
  const {
    protocol: protocolB = ':',
    hostname: hostnameB = '',
    pathname: pathnameB = '/',
    hash: hashB = '#'
  } = new URL(tabB.url);

  const hasAboutSchemeB = protocolB === "about";

  const titleB = tabB.title || '';

  if (hasAboutSchemeA && !hasAboutSchemeB)
    return 1;

  if (!hasAboutSchemeA && hasAboutSchemeB)
    return -1;

  let sortMode = 1; //XXX hardcoded until preferences are implemented.

  let compResult;

  if (sortMode === 2) {

    // Title comparison.
    return titleA.localeCompare(titleB);
  } else if (sortMode < 2) {

    // Split the hostname's TLD from its lower-level domains.
    const [lowerDomainTokensA, tldA] = splitHostname(hostnameA);
    const [lowerDomainTokensB, tldB] = splitHostname(hostnameB);

    // Host comparison.
    compResult = compareTokens(lowerDomainTokensA, lowerDomainTokensB);

    if (compResult !== 0)
      return compResult;

    // TLD comparison.
    compResult = compareTokens(tldA, tldB);

    if (compResult !== 0)
      return compResult;

    const isPathlessA = pathnameA === '/';
    const isPathlessB = pathnameB === '/';

    if (isPathlessB)
      return +!isPathlessA;

    if (isPathlessA)
      return -1;

    if (sortMode === 0) {

      // Title comparison.
      compResult = titleA.localeCompare(titleB);

      if (compResult !== 0)
        return compResult;

      // Pathname comparison.
      compResult = compareTokens(splitPathname(pathnameA),
        splitPathname(pathnameB));

      if (compResult !== 0)
        return compResult;

      // Hash (fragment) comparison.
      compResult = hashA.localeCompare(hashB);
      if (compResult !== 0)
        return compResult;

      if (sortMode === 1) {

        // Title comparison.
        compResult = titleA.localeCompare(titleB);
        if (compResult !== 0)
          return compResult;
      }
    }
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
function compareTokens(tokensA, tokensB)
{
  const tokensALength = tokensA.length;
  const tokensBLength = tokensB.length;

  for (let tokenIndex = 0; ; ++tokenIndex) {
    const eotA = tokenIndex >= tokensALength; // End of 'A' tokens.
    const eotB = tokenIndex >= tokensBLength; // End of 'B' tokens.

    if (eotB) {

      /* Ran out of "B" tokens.
       * Return 0 if also out of "A" tokens, or 1 if not.
       */
      return +!eotA;
    }

    if (eotA)
      return -1;

    const tokenA = tokensA[tokenIndex];
    const tokenB = tokensB[tokenIndex];
    const compResult = tokenA.localeCompare(tokenB);

    if (compResult !== 0)
      return compResult;
  }

  return 0;
}


/*
 * Roughly split hostname into top-level and lower-level domains.
 *
 * @param hostname      URL hostname
 * @return              [lower-level domain tokens, top-level domain tokens]
 */
function splitHostname(hostname)
{
  let tokens = hostnameTokenCache.get(hostname);

  if (tokens !== undefined)
    return tokens;

  tokens = hostname.split('.');

  let splitIndex = tokens.length;

  if (splitIndex > 1) {

    // Check for two-letter ccTLD and preceding ccSLD.
    splitIndex = tokens[splitIndex - 1].length == 2 ? -2 : -1;
  }

  const hostnameTokens =
    [tokens.slice(0, splitIndex).reverse(), tokens.slice(splitIndex)];

  hostnameTokenCache.set(hostname, hostnameTokens);

  return hostnameTokens;
}


/*
 * Split pathname into tokens.
 *
 * @param hostname      URL pathname
 * @return              [pathname tokens]
 */
function splitPathname(pathname)
{
  let tokens = pathnameTokenCache.get(pathname);

  if (tokens !== undefined)
    return tokens;

  tokens = pathname.split('/');

  pathnameTokenCache.set(pathname, tokens);

  return tokens;
}
