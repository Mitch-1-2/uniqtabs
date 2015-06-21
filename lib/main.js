/*
 * @author              Mitchell Field <mitchell.field@live.com.au>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

'use strict';
// required modules
const {Cc, Ci} = require('chrome');
const {Hotkey} = require('sdk/hotkeys');
const _ = require('sdk/l10n').get;
const notifications = require('sdk/notifications');
const prefs = require('sdk/preferences/service');
const self = require('sdk/self');
const simplePrefs = require('sdk/simple-prefs');
const tabs = require('sdk/tabs');
const timers = require('sdk/timers');
const url = require('sdk/url');
const windows = require('sdk/windows').browserWindows;
const idle = require('./idle');
const wm = Cc['@mozilla.org/appshell/window-mediator;1']
             .getService(Ci.nsIWindowMediator);

const TabProps = function (isNew, createTime, loadTime, accessTime) {
    this.isNew = isNew || true;
    this.createTime = createTime || 0;
    this.loadTime = loadTime || 0;
    this.accessTime = accessTime || 0;
};

const sortModes = new Map([
  ['host-title-path', 0],
  ['host-path-title', 1],
  ['title', 2]
]);

const cullBlankModes = new Map([
  ['never', 0],
  ['onSort', 1],
  ['aggressive', 2]
]);

// Duplicate tabs with an 'about' scheme plus paths below will not be clobbered
// unless the tab hard limit has been reached. Sorting priority values are in
// descending order.
const aboutPaths = new Map([
  ['blank', 1],
  ['newtab', 2]
]);

// preferences
let clobber = '';
let cullBlank = 'onSort';
let cullBlankMode = 0;
let hardLimit = 0;
let softLimit = 0;
let limitTimeout = 0;
let sortByTimeCreated = false;
let sortByTimeAccessed = false;
let sortBy = 'host-title-path';
let sortMode = 0;
let sortByPinned = '';
let sortByPinnedThreshold = 0;
let sortOnHotkey = '';
let sortOnIdle = false;
let sortOnContextMenu = false;
let sortAllWindows = false;

const tabMap = new Map();
const sortingWindows = (typeof WeakSet !== 'undefined') ? new WeakSet() : new Set();
const cullingWindows = (typeof WeakSet !== 'undefined') ? new WeakSet() : new Set();
let canWarn = true;
let isWarning = false;
let isUnloading = false;
let isSettingContextMenus = false;
let sortHotkey;
let warningTimeout;
let cullingTimeout;

// module exports
exports.main = main;
exports.onUnload = onUnload;
exports.sortTabs = sortTabs;

/*
 * Called when the addon is loaded.
 *
 * Initialise the addon.
 *
 * @param options       parameters with which the addon was loaded
 * @param callbacks     -
 * @return              void
 */
function main(/* options, callbacks */)
{
  onPrefChange(); // initialise pref vars
  simplePrefs.on('', onPrefChange); // listen to all pref changes
  tabs.on('activate', tabActivated);
  tabs.on('load', tabLoaded);
  tabs.on('open', tabOpened);
  tabs.on('close', tabClosed);
  windows.on('open', windowOpened);
}

/*
 * Called when the addon is unloading.
 *
 * Deinitialise the addon.
 *
 * @param reason        reason for addon unloading
 * @return              void
 */
function onUnload(/* reason */)
{
  if (isUnloading)
    return;
  isUnloading = true;
  idle.unregister();
  tabs.removeListener('activate', tabActivated);
  tabs.removeListener('load', tabLoaded);
  tabs.removeListener('open', tabOpened);
  tabs.removeListener('close', tabClosed);
  windows.removeListener('open', windowOpened);
  simplePrefs.removeListener('', onPrefChange);
  if (sortHotkey) {
    sortHotkey.destroy();
    sortHotkey = null;
  }
  sortOnContextMenu = false;
  setTabContextMenus();
  if ('clear' in tabMap) {
    tabMap.clear();
  }
  if ('clear' in sortingWindows) {
    sortingWindows.clear();
  }
  if ('clear' in cullingWindows) {
    cullingWindows.clear();
  }
  sortModes.clear();
  cullBlankModes.clear();
  aboutPaths.clear();
}

/*
 * Count the number of TLD parts in a specified URL.
 *
 * @param urlA          url object
 * @return              number of TLD parts
 */
function sizeOfTLD(urlA)
{
  return url.getTLD(urlA).split('.').length;
}

/*
 * Sorts tabs of certain windows.
 *
 * @return              void
 */
function sortTabs()
{
  if (isUnloading)
    return;
  if (sortAllWindows) {
    for (let window of windows) {
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
 * @param window        window containing tabs for sorting
 * @return              void
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
  if (sortByPinnedThreshold && sortByPinned !== 'none' &&
      sortByTimeCreated === 'none' && sortByTimeAccessed === 'none') {
    sortTabsByPinned(sortingTabs);
  }
  try {
    for (let i = windowTabsLength - 1; i > -1; --i) {
      let tab = sortingTabs[i];
      if (!tab.isPinned && tab.index !== i)
        tab.index = i;
    }
  }
  catch (err) {}
  sortingWindows.delete(window);
  if (cullBlankMode === 1)
    cullBlankTabs(window);
}

/*
 * Compares certain pinned tabs with all other non-pinned tabs and sorts
 * the non-pinned tabs accordingly.
 *
 * The tabs are already sorted according to criteria such as URL host, title,
 * and/or URL path.
 * Splice, immediately after pinned tabs, a run of non-pinned tabs with at least
 * 'simplePrefs.prefs.tabSortByPinnedThreshold' number of non-TLD host parts in
 * common with each pinned tab, according to user preference.
 *
 * @param sortingTabs   tabs (pinned and non-pinned) to be sorted
 * @return              void
 *
 */
function sortTabsByPinned(sortingTabs)
{
  const compare = (sortByPinned === 'lastToFirst') ?
                  (a, b) => b.index - a.index :
                  (a, b) => a.index - b.index;
  const pinnedTabs = sortingTabs.filter((tab) => tab.isPinned).sort(compare);
  let pinnedTabsLength = pinnedTabs.length;
  if (!pinnedTabsLength)
    return;
  let spliceInsertionIndex = pinnedTabsLength;
  let pinnedStart = (sortByPinned === 'last') ? pinnedTabsLength - 1 : 0;
  const sortingTabsLength = sortingTabs.length;
  for (let i = pinnedStart; i < pinnedTabsLength; ++i) {
    let tabA = pinnedTabs[i];
    if (!tabA)
      continue;
    let urlA = url.URL(tabA.url || '');
    let tokensA = (urlA.host || '').split('.').reverse();
    let tokensALength = tokensA.length;
    let similarityThreshold = sortByPinnedThreshold +
                              sizeOfTLD(url.getTLD(urlA.host));
    let sliceStart = -1;
    let sliceSize = 0;
    for (let j = spliceInsertionIndex; j < sortingTabsLength; ++j) {
      let tabB = sortingTabs[j];
      if (tabB.isPinned)
        continue;
      let bURL = url.URL(tabB.url || '');
      let tokensB = (bURL.host || '').split('.').reverse();
      let tokensBLength = tokensB.length;
      let tokenIndex = 0;
      while (true) {
        let eotA = tokenIndex >= tokensALength;
        let eotB = tokenIndex >= tokensBLength;
        if (eotA || eotB)
          break;
        if (tokensA[tokenIndex] !== tokensB[tokenIndex])
          break;
        ++tokenIndex;
      }
      if (tokenIndex >= similarityThreshold) {
        if (sliceStart === -1)
          sliceStart = sortingTabs.indexOf(tabB);
        ++sliceSize;
      }
      else if (sliceStart !== -1) {
        break;
      }
    }
    if (sliceSize > 0) {
      let similarTabs = sortingTabs.splice(sliceStart, sliceSize);
      let argsArray = [spliceInsertionIndex, 0].concat(similarTabs);
      Array.prototype.splice.apply(sortingTabs, argsArray);
      spliceInsertionIndex += sliceSize;
    }
  }
}

/*
 * Compares tabs based on certain criteria.
 *
 * @param tabA          first tab for comparison
 * @param tabB          second tab for comparison
 * @return              comparison numeric result
 */
function tabComparator(tabA, tabB)
{
  if (!tabA || !tabB)
    return 0;
  const pinnedA = tabA.isPinned;
  const pinnedB = tabB.isPinned;
  if (pinnedB)
    return +!pinnedA;
  if (pinnedA)
    return -1;

  const urlA = url.URL(tabA.url || '');
  const titleA = tabA.title || '';
  let {scheme, host, pathname, hash} = urlA;
  const schemeA = scheme || '';
  const hostA = host || '';
  const tldA = url.getTLD(urlA);
  const pathnameA = pathname || '/';
  const hashA = hash || '#';
  const aboutA = scheme === 'about';

  const urlB = url.URL(tabB.url || '');
  const titleB = tabB.title || '';
  ({scheme, host, pathname, hash}) = urlB;
  const schemeB = scheme || '';
  const hostB = host || '';
  const tldB = url.getTLD(urlB);
  const pathnameB = pathname || '/';
  const hashB = hash || '#';
  const aboutB = scheme === 'about';

  if (aboutA && !aboutB)
    return 1;
  if (!aboutA && aboutB)
    return -1;

  const aboutPriorityA = aboutA && aboutPaths.get(pathnameA);
  const aboutPriorityB = aboutB && aboutPaths.get(pathnameB);

  if (aboutPriorityA && !aboutPriorityB)
    return 1;
  if (!aboutPriorityA && aboutPriorityB)
    return -1;
  if (aboutPriorityA && aboutPriorityB)
    return aboutPriorityA - aboutPriorityB;

  const tabPropsA = tabMap.get(tabA);
  const tabPropsB = tabMap.get(tabB);
  let compResult, m;
  if (sortByTimeCreated !== 'none') {
    compResult = (tabPropsA && tabPropsA.createTime || 0) -
                 (tabPropsB && tabPropsB.createTime || 0);
    m = -(sortByTimeCreated === 'most');
    return compResult * m;
  }
  else if (sortByTimeAccessed !== 'none') {
    compResult = (tabPropsA && tabPropsA.accessTime || 0) -
                 (tabPropsB && tabPropsB.accessTime || 0);
    m = -(sortByTimeAccessed === 'most');
    return compResult * m;
  }

  if (sortMode === 2) {
    // Title comparison.
    compResult = titleA.localeCompare(titleB);
    if (compResult !== 0)
      return compResult;
  }
  else if (sortMode < 2) {
    const hostishA = hostA.slice(0, hostA.lastIndexOf(tldA));
    const hostishB = hostB.slice(0, hostB.lastIndexOf(tldB));
    const hostishTokensA = hostishA.split('.').reverse();
    const hostishTokensB = hostishB.split('.').reverse();
    // Host comparison.
    compResult = tokensComparator(hostishTokensA, hostishTokensB);
    if (compResult !== 0)
      return compResult;
    // TLD comparison.
    compResult = tldA.localeCompare(tldB);
    if (compResult !== 0)
      return compResult;
    const aPathless = pathnameA === '/';
    const bPathless = pathnameB === '/';
    if (bPathless)
      return +!aPathless;
    if (aPathless)
      return -1;
    if (sortMode === 0) {
      // Title comparison.
      compResult = titleA.localeCompare(titleB);
      if (compResult !== 0)
        return compResult;
    }
    // Pathname comparison.
    compResult = tokensComparator(pathnameA.split('/'), pathnameB.split('/'));
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
 * @param isHost        search for TLDs in tokens; comparisons exclude TLDs
 * @return              comparison numeric result
 */
function tokensComparator(tokensA, tokensB)
{
  const tokensALength = tokensA.length;
  const tokensBLength = tokensB.length;
  let tokenIndex = 0;
  while (true) {
    let eotA = tokenIndex >= tokensALength;
    let eotB = tokenIndex >= tokensBLength;
    if (eotB)
      return +!eotA;
    if (eotA)
      return -1;
    let tokenA = tokensA[tokenIndex];
    let tokenB = tokensB[tokenIndex];
    let compResult = tokenA.localeCompare(tokenB);
    if (compResult !== 0)
      return compResult;
    ++tokenIndex;
  }
  return 0;
}

/*
 * Acquire all user preferences for this addon.
 *
 * Any time a single preference is changed, *all* preferences are acquired.
 * Set up events and hotkeys relevant to preferences.
 *
 * @param prefName      the individual preference which changed
 * @return              void
 */
function onPrefChange(/* prefName = null */)
{
  const {
    tabClobber,
    tabCullBlank,
    tabLimitSoft,
    tabLimitHard,
    tabLimitWarningTimeout,
    tabSortByTimeCreated,
    tabSortByTimeAccessed,
    tabSortBy,
    tabSortByPinned,
    tabSortByPinnedThreshold,
    tabSortAllWindows,
    tabSortOnHotkey,
    tabSortOnIdle,
    tabSortOnContextMenu
  } = simplePrefs.prefs;
  clobber = tabClobber || 'existing';
  cullBlank = tabCullBlank || 'onSort';
  cullBlankMode = cullBlankModes.get(cullBlank);
  softLimit = parseInt(tabLimitSoft, 10) || 0;
  hardLimit = parseInt(tabLimitHard, 10) || 0;
  limitTimeout = parseFloat(tabLimitWarningTimeout) * 1000 || 3000;
  sortByTimeCreated = tabSortByTimeCreated || false;
  sortByTimeAccessed = tabSortByTimeAccessed || false;
  sortBy = tabSortBy || 'host-title-path';
  sortMode = sortModes.get(sortBy);
  sortByPinned = tabSortByPinned || 'none';
  sortByPinnedThreshold = parseInt(tabSortByPinnedThreshold, 10) || 0;
  sortAllWindows = tabSortAllWindows || false;
  sortOnHotkey = tabSortOnHotkey || '';
  sortOnIdle = parseInt(tabSortOnIdle, 10) || 0;
  sortOnContextMenu = tabSortOnContextMenu || false;
  setTabContextMenus();
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
  if (sortOnIdle)
    idle.register('idle', sortTabs, sortOnIdle);
}

/*
 * Called when a tab is opened.
 *
 * Add the tab to the 'new tabs' set.
 *
 * @param tab           the new tab which has opened
 * @return              void
 */
function tabOpened(tab)
{
  if (!tab)
    return;
  tabMap.set(tab, new TabProps(true, Date.now()));
  timers.setTimeout(warnNotify, 0, tab);
  if (cullBlankMode < 2)
    return;
  cullBlankTabs(tab.window);
}

/*
 * Display a warning notification if the number of tabs has reached the soft or
 * hard limit.
 *
 * @return              void
 */
function warnNotify(tab)
{
  if (!tab || isWarning || !canWarn)
    return;
  isWarning = true;
  const window = tab.window;
  if (!window)
    return;
  const windowTabs = window.tabs;
  const windowTabsLength = windowTabs.length;
  if (hardLimit && windowTabsLength > hardLimit) {
    canWarn = false;
    notifications.notify({
      title: self.name,
      text: _('notifications.tabLimitHard', hardLimit)
    });
  }
  else if (softLimit && windowTabsLength > softLimit) {
    canWarn = false;
    notifications.notify({
      title: self.name,
      text: _('notifications.tabLimitSoft', softLimit)
    });
  }
  if (!canWarn) {
    timers.clearTimeout(warningTimeout);
    canWarn = false;
    if (limitTimeout) {
      warningTimeout = timers.setTimeout(() => canWarn = true, limitTimeout);
    }
  }
  isWarning = false;
}

/*
 * Called when a tab is closed.
 *
 * Remove the closed tab from the 'new tabs' set.
 *
 * @param tab           the tab which has closed
 * @return              void
 */
function tabClosed(tab)
{
  tabMap.delete(tab);
}

/*
 * Close a tab and remove it from the 'new tabs' set.
 *
 * @param tab           the tab to close
 * @return              void
 */
function tabRelease(tab)
{
  tabMap.delete(tab);
  try {
    if (tab)
      tab.close();
  }
  catch (err) {}
}

/*
 * Cull excess blank tabs.
 *
 * If there is a blank tab at the end it will be kept.
 *
 * @param tab           the window in which to cull blank tabs
 * @return              void
 */
function cullBlankTabs(window)
{
  timers.clearTimeout(cullingTimeout);
  cullingTimeout = timers.setTimeout(function(window) {
    if (!window || cullingWindows.has(window)) {
      return;
    }
    cullingWindows.add(window);
    const windowTabs = window.tabs;
    const windowTabsLength = windowTabs.length;
    const cullOnSort = cullBlankMode === 1;
    let tabSpared = false;
    for (let i = windowTabsLength - 1; i >= 0; --i) {
      let tab = windowTabs[i];
      let {scheme, path} = url.URL(tab.url || '');
      let priority = scheme === 'about' && aboutPaths.get(path) || 0;
      if (!priority) {
        if (cullOnSort) {
          break;
        }
        else {
          tabSpared = true;
          continue;
        }
      }
      if (('readyState' in tab) && tab.readyState === 'complete') {
        // readyState available in Firefox 33+
        if (tabSpared) {
          tabRelease(tab);
        }
        else {
          tabSpared = true;
        }
      }
    }
    cullingWindows.delete(window);
  }, 150, window);
}

function tabActivated(tab)
{
  if (!tab)
    return;
  const dateNow = Date.now();
  const tabProps = tabMap.get(tab);
  if (!tabProps) {
    tabMap.set(tab, new TabProps(false, 0, 0, dateNow));
    return;
  }
  tabProps.accessTime = dateNow;
}

/*
 * Called when a tab is loaded.
 *
 * Only act when the ready tab is a 'new tab'. Check if the number of tabs has
 * reached the hard limit, then check if the tab is a duplicate.
 *
 * @param tab           the tab which is ready
 * @return              void
 */
function tabLoaded(tab)
{
  if (!tab)
    return;
  const window = tab.window;
  if (!window)
    return;
  const dateNow = Date.now();
  const tabProps = tabMap.get(tab);
  if (!tabProps) {
    tabMap.set(tab, new TabProps(false, dateNow, dateNow));
    return;
  }
  if (!tabProps.isNew)
    return;
  tabProps.isNew = false;
  tabProps.loadTime = dateNow;
  const tabURL = tab.url || '';
  const {scheme, path} = url.URL(tabURL);
  const tabPath = path || '/';
  const tabAbout = scheme === 'about';
  const tabPriority = tabAbout && aboutPaths.get(tabPath) || 0;
  const windowTabs = window.tabs;
  const windowTabsLength = windowTabs.length;
  if (hardLimit && windowTabsLength > hardLimit) {
    if (!tabAbout || tabPriority)
      tabRelease(tab);
    return;
  }
  if (clobber === 'none' || !tabURL)
    return;
  if (tabPriority || tabURL === prefs.get('browser.newtab.url'))
    return;
  const clobberNew = clobber === 'new';
  for (let i = 0; i < windowTabsLength; ++i) { // check for duplicates
    if (isUnloading)
      return;
    let someTab = windowTabs[i];
    if (!someTab || tab === someTab)
      continue;
    let someTabWindow = someTab.window;
    if (window !== someTabWindow)
      continue;
    let someTabURL = ('url' in someTab) && someTab.url || '';
    if (tabURL === someTabURL) {
      if (clobberNew) { // clobber new tab
        tabRelease(tab);
        break;
      }
      else if (!someTab.isPinned) { // clobber existing tab
        tabRelease(someTab);
      }
    }
  }
}

/*
 * Called when a window is opened.
 *
 * @param window        the window which has opened
 * @return              void
 */
function windowOpened(window)
{
  setTabContextMenus(window);
}

/*
 * Adds or removes 'Sort Tabs' from the tab context menus of each window.
 *
 * Modify the XUL of each enumerated browser window.
 *
 * @param window        -
 * @return              void
 */
function setTabContextMenus(window = null)
{
  if (isSettingContextMenus)
    return;
  isSettingContextMenus = true;
  const enumerator = wm.getEnumerator('navigator:browser');
  const sortTabs_label = _('tabContextMenu.sortTabs.label');
  const sortTabs_accesskey = _('tabContextMenu.sortTabs.accesskey');
  while (enumerator.hasMoreElements()) {
    let win = enumerator.getNext();
    let gBrowser = win.gBrowser;
    let tabContextMenu = gBrowser.tabContextMenu;
    let functionAttached = ('sortTabs' in gBrowser);
    let rat, st;
    if (sortOnContextMenu) {
      if (functionAttached && gBrowser.sortTabs === sortTabs)
        continue;
      gBrowser.sortTabs = sortTabs;
      st = createMenuItem(win.document,
                          'context_sortTabs',
                          sortTabs_label,
                          sortTabs_accesskey,
                          'gBrowser.sortTabs()');
      rat = tabContextMenu.getElementsByAttribute('id',
                                                  'context_reloadAllTabs')[0];
      tabContextMenu.insertBefore(st, rat || null);
    }
    else if (functionAttached) {
      delete gBrowser.sortTabs;
      st = tabContextMenu.getElementsByAttribute('id', 'context_sortTabs')[0];
      tabContextMenu.removeChild(st);
    }
  }
  isSettingContextMenus = false;
}

/*
 * Creates and returns a new menuitem.
 *
 * @param document      document inside which the new menuitem is created
 * @param id            id of new menuitem
 * @param label         label of new menuitem
 * @param accesskey     accesskey of new menuitem
 * @param command       command of new menuitem
 * @return              new menuitem
 */
function createMenuItem(document, id, label, accesskey, command)
{
  const XUL_NS = 'http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul';
  const item = document.createElementNS(XUL_NS, 'menuitem');
  item.setAttribute('id', id);
  item.setAttribute('label', label);
  item.setAttribute('accesskey', accesskey);
  item.setAttribute('oncommand', command);
  return item;
}
