/*
 * @file                Background script.
 * @author              Mitchell Field <mitchell.field@live.com.au>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

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
  ["title_host_path", 3]
]);

const PREFS = Object.assign(PREFS_DEFAULT);

// Get "sync" storage contents.
browser.storage.sync.get().then(async storedObject => {

  // Merge preferences with preferences from storage.
  Object.assign(PREFS, PREFS_DEFAULT, storedObject.preferences);
  return updateUI();
});

// Set browser action.
browser.browserAction.onClicked.addListener(onBrowserAction);

// Listen to changes in storage.
browser.storage.onChanged.addListener(onStorageChanged);

// Listen for tab updates.
browser.tabs.onUpdated.addListener(onTabUpdated);


class TabProps {
  constructor(tab, windowProps, containers, sortMode) {
    const {
      active,
      cookieStoreId = null,
      id,
      index,
      status,
      title,
      url,
      windowId
    } = tab;

    const {
      protocol = ":",
      hostname = "",
      pathname = '/',
      searchParams = "",
      hash = "#"
    } = new URL(url || "");

    Object.assign(this, {
      _lowerDomainTokens: null,
      _pathnameTokens: null,
      _tldTokens: null,
      containerIndex: containers && containers.get(cookieStoreId) || -1,
      hasHTTPScheme: protocol === "https:" || protocol === "http:",
      hasPathname: pathname !== "/",
      hash,
      hostname,
      id,
      index,
      isActive: active,
      isBlank: BLANK_TAB_URLS.has(url),
      isDuplicate: false,
      pathname,
      queryString: searchParams.toString(),
      scheme: protocol,
      sortMode,
      status,
      tab,
      title: title || "",
      url,
      windowId,
      windowProps
    });
  }

  get lowerDomainTokens() {
    if (!this._lowerDomainTokens) {
      const hostnameTokens = this.windowProps.getHostnameTokens(this.hostname);
      this._tldTokens = hostnameTokens[0];
      this._lowerDomainTokens = hostnameTokens[1];
    }
    return this._lowerDomainTokens;
  }

  get pathnameTokens() {
    if (!this._pathnameTokens) {
      this._pathnameTokens = this.windowProps.getPathnameTokens(this.pathname);
    }
    return this._pathnameTokens;
  }

  get tldTokens() {
    if (!this._tldTokens) {
      const hostnameTokens = this.windowProps.getHostnameTokens(this.hostname);
      this._tldTokens = hostnameTokens[0];
      this._lowerDomainTokens = hostnameTokens[1];
    }
    return this._tldTokens;
  }
}


class WindowProps {
  constructor(windowId) {
    WindowProps.windows.add(windowId);
    this.windowId = windowId;
    this.hostnameTokenCache = new Map();
    this.pathnameTokenCache = new Map();
  }

  /*
   * Roughly split hostname into top-level and lower-level domain tokens.
   *
   * @param hostname      hostname
   * @return              [top-level domain tokens, lower-level domain tokens]
   */
  getHostnameTokens(hostname) {
    let hostnameTokens = this.hostnameTokenCache.get(hostname);
    if (!hostnameTokens) {
      const tokens = hostname.split('.').reverse();
      const splitIndex = (tokens.length > 2 && tokens[1].length <= 3) ? 2 : 1;
      hostnameTokens = [tokens.slice(0, splitIndex), tokens.slice(splitIndex)];
      this.hostnameTokenCache.set(hostname, hostnameTokens);
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
    let pathnameTokens = this.pathnameTokenCache.get(pathname);
    if (!pathnameTokens) {
      pathnameTokens = pathname.split("/");
      this.pathnameTokenCache.set(pathname, pathnameTokens);
    }
    return pathnameTokens;
  }

  clear() {
    this.hostnameTokenCache.clear();
    this.pathnameTokenCache.clear();
    WindowProps.windows.delete(this.windowId);
  }
}

WindowProps.windows = new Set();

WindowProps.hasWindowById = function(windowId) {
  "use strict";
  return WindowProps.windows.has(windowId);
}


/*
 * Called when the "browser action" is invoked.
 */
function onBrowserAction(tab, onClickData) {
  "use strict";
  const prefs = Object.assign({}, PREFS);
  const sort = prefs.pref_tabs_sort_on_browser_action === "true" &&
    (prefs.pref_tabs_sort_by_container === "true" ||
    prefs.pref_tabs_sort_by_parts !== "none");
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

  if (changeInfo.status !== "complete" || !changeInfo.status) {
    return;
  }

  if (sort || deduplicate)
    return processTabs(tab.windowId, sort, deduplicate, prefs);
}


/*
 * Updates UI elements such as titles and descriptions.
 */
function updateUI() {
  "use strict";
  const sort = PREFS.pref_tabs_sort_on_browser_action === "true";
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
  browser.browserAction.setTitle({
    title: browser.i18n.getMessage(titleID)
  });

  // Set browser action shortcut description.
  if ("update" in browser.commands) {
    browser.commands.update({
      name: "_execute_browser_action",
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
  let index;
  let tabPropsArray = [];

  if (WindowProps.hasWindowById(windowId))
    return Promise.resolve();

  const windowProps = new WindowProps(windowId);

  return browser.tabs.query({
    pinned: false,
    windowId,
  }).then(async unpinnedTabs => {
    if (!unpinnedTabs || unpinnedTabs.length === 0) {
      return Promise.reject(
        new Error(browser.i18n.getMessage("error_tabs_none")));
    }

    // Get first tab index.
    ({ index } = unpinnedTabs[0]);

    let containers = null;

    if (("contextualIdentities" in browser) && prefs.pref_tabs_sort_by_container === "true") {
      try {
        const containersArray = await browser.contextualIdentities.query({});
        containers = new Map(
          containersArray.map((c, index) => [c.cookieStoreId, index])
        );
      } catch (err) {}
    };

    const sortMode = SORT_MODES.get(prefs.pref_tabs_sort_by_parts);

    tabPropsArray = unpinnedTabs.map(
      unpinnedTab => new TabProps(unpinnedTab, windowProps, containers, sortMode)
    );

    if (!sort)
      return Promise.resolve();

    // Sort and move tabs into place.
    return browser.tabs.move(
      tabPropsArray.sort(compareTabsOrder).map(tabProps => tabProps.id),
      { index }
    );
  }, err => {
    return Promise.reject(err);
  }).then(() => {

    // Detect duplicate tabs.
    if (deduplicate) {
      let tabPropsA = null;
      tabPropsArray.sort(compareTabsSimilarity).forEach(tabPropsB => {
        if (tabPropsA && compareTabsSimilarity(tabPropsA, tabPropsB) === 0)
          tabPropsA.isDuplicate = true;
        tabPropsA = tabPropsB;
      });
    }

    // Filter duplicate and blank tabs.
    const unwantedTabs = tabPropsArray.filter(tabProps =>
      tabProps.status === "complete" &&
        (tabProps.isBlank || deduplicate && tabProps.isDuplicate)
    );

    if (index === 0 && tabPropsArray.length === unwantedTabs.length) {

      // Create a new tab to remain after culling.
      return browser.tabs.create({
        active: false,
        windowId: windowId
      }).finally(browser.tabs.remove(unwantedTabs.map(tab => tab.id)));
    } else {
      return browser.tabs.remove(unwantedTabs.map(tab => tab.id));
    }
  }, err => {
    return Promise.reject(err);
  }).catch(err => {

    // Error caught. Do nothing.
  }).finally(() => {
    tabPropsArray.length = 0;
    windowProps.clear();
    return Promise.resolve();
  });
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

  const containerDiff = propsA.containerIndex - propsB.containerIndex;
  if (containerDiff)
    return containerDiff;

  const sortMode = propsA.sortMode;
  if (sortMode === 0)
    return 0;

  return (sortMode === 3 ? propsA.title.localeCompare(propsB.title) : 0) || // title-host-path
    (propsA.hasHTTPScheme && propsB.hasHTTPScheme ?
      0 : propsA.scheme.localeCompare(propsB.scheme)) ||
    compareTokens(propsA.lowerDomainTokens, propsB.lowerDomainTokens) ||
    compareTokens(propsA.tldTokens, propsB.tldTokens) ||
    (propsA.hasPathname - propsB.hasPathname) ||
    (sortMode === 1 ? propsA.title.localeCompare(propsB.title) : 0) || // host-title-path
    compareTokens(propsA.pathnameTokens, propsB.pathnameTokens) ||
    (PREFS.pref_tabs_sort_by_query_string === "true" ?
      propsA.queryString.localeCompare(propsB.queryString) : 0) ||
    propsA.hash.localeCompare(propsB.hash) ||
    (sortMode === 2 ? propsA.title.localeCompare(propsB.title) : 0); // host-path-title
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

  return (propsA.containerIndex - propsB.containerIndex) ||
    (!propsA.hasHTTPScheme || !propsB.hasHTTPScheme ?
      propsA.scheme.localeCompare(propsB.scheme) : 0) ||
    compareTokens(propsA.lowerDomainTokens, propsB.lowerDomainTokens) ||
    compareTokens(propsA.tldTokens, propsB.tldTokens) ||
    (propsA.hasPathname - propsB.hasPathname) ||
    compareTokens(propsA.pathnameTokens, propsB.pathnameTokens) ||
    propsA.queryString.localeCompare(propsB.queryString) ||
    propsA.hash.localeCompare(propsB.hash) ||
    propsA.title.localeCompare(propsB.title);
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
  const tokensLengthA = tokensA.length;
  const tokensLengthB = tokensB.length;
  const shortestLength = Math.min(tokensLengthA, tokensLengthB);

  for (let index = 0; index < shortestLength; ++index) {
    let result = tokensA[index].localeCompare(tokensB[index]);
    if (result)
      return result;
  }

  return tokensLengthA - tokensLengthB;
}
