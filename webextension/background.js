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
browser.browserAction.onClicked.addListener(onBrowserAction);

// Listen to changes in storage.
browser.storage.onChanged.addListener(onStorageChanged);

// Listen for tab updates.
browser.tabs.onUpdated.addListener(onTabUpdated);


class TabProps {
  constructor(tab, windowProps, containers, sortPrefs) {
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
      pathname = "",
      searchParams = "",
      hash = "#"
    } = new URL(url || "");

    const pathnameTrimmed = pathname.replace(/^\/|\/$/g, ""); // trim slashes
    const hasPathname = pathnameTrimmed !== "";
    const containerIndex = containers && containers.get(cookieStoreId) || -1;

    const {
      sortMode,
      sortByQueryString
    } = sortPrefs;

    Object.assign(this, {
      _lowerDomainTokens: null,
      _pathnameTokens: null,
      _maybeSlug: null,
      _tldTokens: null,
      hash,
      hostname,
      id,
      index,
      isActive: active,
      isBlank: BLANK_TAB_URLS.has(url),
      isDuplicate: false,
      pathname: pathnameTrimmed,
      queryString: sortByQueryString ? searchParams.toString() : "",
      status,
      title: title || "",
      windowId,
      windowProps
    });

    const criteriaBase = [
      containerIndex,
      protocol,
      this.lowerDomainTokens,
      this.tldTokens,
      hasPathname,
      this.pathnameTokens,
      this.queryString,
      this.hash,
      this.title
    ];

    let criteria;
    switch (sortMode) {
      case 1:
        criteria = [
          containerIndex,
          protocol,
          this.lowerDomainTokens,
          this.tldTokens,
          hasPathname,
          this.title,
          this.pathnameTokens,
          this.queryString,
          this.hash
        ];
        break;
      case 2:
        criteria = criteriaBase;
        break;
      case 3:
        criteria = [
          containerIndex,
          this.title,
          protocol,
          this.lowerDomainTokens,
          this.tldTokens,
          hasPathname,
          this.pathnameTokens,
          this.queryString,
          this.hash
        ];
        break;
      case 4:
        criteria = [
          containerIndex,
          protocol,
          this.lowerDomainTokens,
          this.tldTokens
        ];
        break;
      default:
        criteria = [
          containerIndex
        ];
        break;
    }

    Object.assign(this, {
      criteria,
      criteriaBase
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

  get maybeSlug() {
    if (this._maybeSlug === null) {
      const pathEnd = this.pathnameTokens.at(-1);
      const titleSlugged = this.title.replace(/ /g,"_").toLocaleLowerCase().replace(/\W/g, "");

      // First character of path end matches the first character of slugged title.
      // Naively presume that the path end is a slug.
      this._maybeSlug = pathEnd.charAt(0) === titleSlugged.charAt(0) ? pathEnd : "";
    }
    return this._maybeSlug;
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
    const sortPrefs = {
      sortMode,
      sortByQueryString: prefs.pref_tabs_sort_by_query_string === "true"
    }

    tabPropsArray = unpinnedTabs.map(
      unpinnedTab => new TabProps(unpinnedTab, windowProps, containers, sortPrefs)
    );

    if (!sort)
      return Promise.resolve();

    const compareFunction = sortMode === 4 ? compareTabsOrderAuto : compareTabsOrder;

    // Sort and move tabs into place.
    return browser.tabs.move(
      tabPropsArray.sort(compareFunction).map(tabProps => tabProps.id),
      { index }
    );
  }, err => {
    return Promise.reject(err);
  }).then(() => {

    // Detect duplicate tabs.
    if (deduplicate)
      tabPropsArray.sort(compareTabsSimilarity);

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

  const criteriaA = propsA.criteria;
  const criteriaB = propsB.criteria;
  const criteriaLength = criteriaA.length;
  let result = 0;

  for (let index = 0; index < criteriaLength; ++index) {
    let criterionA = criteriaA[index];
    let criterionB = criteriaB[index];
    switch (typeof criterionA) {
      case "object":
        result = compareTokens(criterionA, criterionB);
        break;
      case "string":
        result = criterionA.localeCompare(criterionB);
        break;
      default:
        result = criterionA - criterionB;
        break;
    }
    if (result)
      break;
  }

  return result;
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

  const criteriaA = propsA.criteriaBase;
  const criteriaB = propsB.criteriaBase;
  const criteriaLength = criteriaA.length;
  let result = 0;

  for (let index = 0; index < criteriaLength; ++index) {
    let criterionA = criteriaA[index];
    let criterionB = criteriaB[index];
    switch (typeof criterionA) {
      case "object":
        result = compareTokens(criterionA, criterionB);
        break;
      case "string":
        result = criterionA.localeCompare(criterionB);
        break;
      default:
        result = criterionA - criterionB;
        break;
    }
    if (result)
      break;
  }

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
