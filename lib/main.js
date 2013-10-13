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

// Duplicate tabs with an 'about' scheme plus paths below will not be clobbered
// unless the tab hard limit has been reached. Sorting priority values are in
// descending order.
const aboutPaths = new Map([
  ['blank', 1],
  ['newtab', 2]
]);

// generic top-level domains
const gTLDs = new Set([
  'aero',
  'asia',
  'biz',
  'cat',
  'com',
  'coop',
  'edu',
  'gov',
  'jobs',
  'mil',
  'mobi',
  'museum',
  'name',
  'net',
  'org',
  'post',
  'pro',
  'tel',
  'travel',
  'xxx'
]);

// preferences
let clobber = '';
let hardLimit = 0;
let softLimit = 0;
let limitTimeout = 0;
let sortByHost = false;
let sortByPath = false;
let sortByTitle = false;
let sortByPinned = '';
let sortByPinnedThreshold = 0;
let sortOnHotkey = '';
let sortOnIdle = false;
let sortOnContextMenu = false;
let sortAllWindows = false;

const newTabs = new Set();
const sortingWindows = new Set();
let canWarn = true;
let isWarning = false;
let isCulling = false;
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
  tabs.on('load', tabReady);
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
  tabs.removeListener('load', tabReady);
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
  newTabs.clear();
  sortingWindows.clear();
  aboutPaths.clear();
  gTLDs.clear();
}

/*
 * Make a rough guess of how many tokens are TLD parts.
 *
 * This doesn't need to be as accurate as the Public Suffix List
 * (http://publicsuffix.org) as some public suffixes are useful for
 * differentiating URL hosts.
 *
 * @param tokens        reversed URL host tokens (e.g. ['au', 'com', 'google'])
 * @return              estimated number of tokens which are TLD parts [0|1|2]
 */
function sizeOfTLD(tokens)
{
  if (tokens.length > 1)
    return tokens[0].length === 2 && gTLDs.has(tokens[1]) ? 2 : 1;
  return 0;
}

/*
 * Roughly partition host into TLD parts and other parts.
 *
 * @param tokens        reversed URL host tokens (e.g. ['au', 'com', 'google'])
 * @return              [TLD parts, the rest]
 */
function partitionHost(tokens)
{
  let s;
  if (tokens.length > 1)
    s = tokens[0].length === 2 && gTLDs.has(tokens[1]) ? 2 : 1;
  else
    s = 0;
  return [tokens.slice(0, s), tokens.slice(s)];
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
 * @param window        window containing tabs for sorting
 * @return              void
 */
function sortWindow(window)
{
  if (!window || sortingWindows.has(window))
    return;
  sortingWindows.add(window);
  //cullLastBlankTabs(window);
  let sortingTabs = [];
  const windowTabs = window.tabs;
  const windowTabsLength = windowTabs.length;
  for (let i = 0; i < windowTabsLength; ++i) {
    sortingTabs[i] = windowTabs[i];
  }
  sortingTabs.sort(tabComparator);
  if (sortByPinnedThreshold && sortByPinned !== 'none')
    sortTabsByPinned(sortingTabs);
  try {
    for (let i = windowTabsLength - 1; i > -1; --i) {
      let tab = sortingTabs[i];
      if (!tab.isPinned && tab.index !== i)
        tab.index = i;
    }
  }
  catch (err) {}
  sortingWindows.delete(window);
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
    let aTab = pinnedTabs[i];
    if (!aTab)
      continue;
    let aURL = url.URL(aTab.url || '');
    let aTokens = (aURL.host || '').split('.').reverse();
    let aTokensLength = aTokens.length;
    let similarityThreshold = sortByPinnedThreshold + sizeOfTLD(aTokens);
    let sliceStart = -1;
    let sliceSize = 0;
    for (let j = spliceInsertionIndex; j < sortingTabsLength; ++j) {
      let bTab = sortingTabs[j];
      if (bTab.isPinned)
        continue;
      let bURL = url.URL(bTab.url || '');
      let bTokens = (bURL.host || '').split('.').reverse();
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
      let argsArray = [spliceInsertionIndex, 0].concat(similarTabs);
      Array.prototype.splice.apply(sortingTabs, argsArray);
      spliceInsertionIndex += sliceSize;
    }
  }
}

/*
 * Compares tabs based on certain criteria.
 *
 * @param aTab          first tab for comparison
 * @param bTab          second tab for comparison
 * @return              comparison numeric result
 */
function tabComparator(aTab, bTab)
{
  if (!aTab || !bTab)
    return 0;
  const aPinned = aTab.isPinned;
  const bPinned = bTab.isPinned;
  if (bPinned)
    return +!aPinned;
  if (aPinned)
    return -1;

  let {scheme, host, path} = url.URL(aTab.url || '');
  const aScheme = scheme || '';
  const aHost = host || '';
  const aPath = path || '/';
  const aAbout = scheme === 'about';

  ({scheme, host, path}) = url.URL(bTab.url || '');
  const bScheme = scheme || '';
  const bHost = host || '';
  const bPath = path || '/';
  const bAbout = scheme === 'about';

  if (aAbout && !bAbout)
    return 1;
  if (!aAbout && bAbout)
    return -1;

  const aAboutPriority = aAbout && aboutPaths.get(aPath);
  const bAboutPriority = bAbout && aboutPaths.get(bPath);

  if (aAboutPriority && !bAboutPriority)
    return 1;
  if (!aAboutPriority && bAboutPriority)
    return -1;
  if (aAboutPriority && bAboutPriority)
    return aAboutPriority - bAboutPriority;

  let aTokens, bTokens;
  let compResult;

  if (sortByHost || (!sortByTitle && !sortByPath) ||
    (sortByPinned !== 'none' && sortByPinnedThreshold)) {
    aTokens = aHost.split('.').reverse();
    bTokens = bHost.split('.').reverse();
    const [aTLD, aRest] = partitionHost(aTokens);
    const [bTLD, bRest] = partitionHost(bTokens);
    compResult = tokensComparator(aRest, bRest);
    if (compResult !== 0)
      return compResult;
    compResult = tokensComparator(aTLD, bTLD);
    if (compResult !== 0)
      return compResult;
    const aPathless = aPath === '/';
    const bPathless = bPath === '/';
    if (bPathless)
      return +!aPathless;
    if (aPathless)
      return -1;
  }
  if (sortByTitle) {
    const aTitle = aTab.title || '';
    const bTitle = bTab.title || '';
    compResult = aTitle.localeCompare(bTitle);
    if (compResult !== 0)
      return compResult;
  }
  if (sortByPath) {
    aTokens = aPath.split('/');
    bTokens = bPath.split('/');
    compResult = tokensComparator(aTokens, bTokens);
    if (compResult !== 0)
      return compResult;
  }
  return 0;
}

/*
 * Compares a list of tokens.
 *
 * Compare a token from one array to its corresponding token in the other array
 * until they sort differently or an array runs out of tokens to compare.
 *
 * @param aTokens       first array of tokens for comparison
 * @param bTokens       second array of tokens for comparison
 * @param isHost        search for TLDs in tokens; comparisons exclude TLDs
 * @return              comparison numeric result
 */
function tokensComparator(aTokens, bTokens)
{
  const aTokensLength = aTokens.length;
  const bTokensLength = bTokens.length;
  let tokenIndex = 0;
  while (true) {
    let aEOT = tokenIndex >= aTokensLength;
    let bEOT = tokenIndex >= bTokensLength;
    if (bEOT)
      return +!aEOT;
    if (aEOT)
      return -1;
    let aToken = aTokens[tokenIndex];
    let bToken = bTokens[tokenIndex];
    let compResult = aToken.localeCompare(bToken);
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
    tabLimitSoft,
    tabLimitHard,
    tabLimitWarningTimeout,
    tabSortByHost,
    tabSortByPath,
    tabSortByTitle,
    tabSortByPinned,
    tabSortByPinnedThreshold,
    tabSortAllWindows,
    tabSortOnHotkey,
    tabSortOnIdle,
    tabSortOnContextMenu
  } = simplePrefs.prefs;
  clobber = tabClobber || 'existing';
  softLimit = parseInt(tabLimitSoft, 10) || 0;
  hardLimit = parseInt(tabLimitHard, 10) || 0;
  limitTimeout = parseFloat(tabLimitWarningTimeout) * 1000 || 3000;
  sortByHost = tabSortByHost || false;
  sortByPath = tabSortByPath || false;
  sortByTitle = tabSortByTitle || false;
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
  newTabs.add(tab);
  timers.setTimeout(warnNotify, 0, tab);
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
  newTabs.delete(tab);
}

/*
 * Close a tab and remove it from the 'new tabs' set.
 *
 * @param tab           the tab to close
 * @return              void
 */
function tabRelease(tab)
{
  newTabs.delete(tab);
  try {
    if (tab)
      tab.close();
  }
  catch (err) {}
}

/*
 * Cull excess blank tabs at the end of the tab bar.
 *
 * If there are multiple, consecutive blank tabs at the end, the first of these
 * tabs will be kept.
 *
 * @param tab           the window in which to cull tabs
 * @return              void
 */
function cullLastBlankTabs(window)
{
  timers.clearTimeout(cullingTimeout);
  cullingTimeout = timers.setTimeout(() => {
    if (isCulling)
      return;
    isCulling = true;
    let previousTab = null;
    const windowTabs = window.tabs;
    const windowTabsLength = windowTabs.length;
    for (let i = windowTabsLength - 1; i > 0; --i) {
      let tab = windowTabs[i];
      if (tab.index !== i)
        break;
      let {scheme, path} = url.URL(tab.url || '');
      let priority = scheme === 'about' && aboutPaths.get(path) || 0;
      if (!priority)
        break;
      if (previousTab)
        tabRelease(previousTab);
      previousTab = tab;
    }
    isCulling = false;
  }, 100);
}

/*
 * Called when a tab is ready.
 *
 * Only act when the ready tab is a 'new tab'. Check if the number of tabs has
 * reached the hard limit, then check if the tab is a duplicate.
 *
 * @param tab           the tab which is ready
 * @return              void
 */
function tabReady(tab)
{
  if (!tab || !newTabs.has(tab))
    return;
  newTabs.delete(tab);
  const tabURL = tab.url || '';
  const {scheme, path} = url.URL(tabURL);
  const tabPath = path || '/';
  const tabAbout = scheme === 'about';
  const tabPriority = tabAbout && aboutPaths.get(tabPath) || 0;
  const window = tab.window;
  if (!window)
    return;
  const windowTabs = window.tabs;
  const windowTabsLength = windowTabs.length;
  //cullLastBlankTabs(window);
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
