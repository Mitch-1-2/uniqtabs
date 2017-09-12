/*
 * @author              Mitchell Field <mitchell.field@live.com.au>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */


const DEFAULT_PREFS = {
  "pref_tabSortByURL": "host_title_path"
};


/*
 * Saves preferences to "sync" storage.
 *
 * @param e             event
 */
function saveOptions(e) {

  e.preventDefault();

  // Copy default preferences.
  const prefs = Object.assign(DEFAULT_PREFS);

  // Replace defaults with each user preference.
  for (let [id, value] of Object.entries(prefs)) {
    prefs[id] = document.getElementById(id).value;
  }

  // Save settings to "sync" storage.
  browser.storage.sync.set({ preferences: prefs });
}


/*
 * Sets the user interface for the addon options page.
 */
function setInterface() {

  // Get "sync" storage contents.
  let gettingStorage = browser.storage.sync.get();

  gettingStorage.then((storedObject) => {
    setLabelText();
    setOptionText();
    setButtonText();
    setInputValues(storedObject);
  });
}


/*
 * Sets the button text for the addon options page.
 */
function setButtonText() {

  document.getElementById("reset").innerText =
    browser.i18n.getMessage("options_ui_button_reset");

  document.getElementById("submit").innerText =
    browser.i18n.getMessage("options_ui_button_submit");
}


/*
 * Sets the label text for the addon options page.
 */
function setLabelText() {
  const labelNodes = document.querySelectorAll("label");

  for (const labelNode of labelNodes) {
    const id = labelNode.getAttribute("for");

    if (id && (id in DEFAULT_PREFS)) {
      labelNode.innerText = browser.i18n.getMessage(id + "_label");
    }
  }
}


/*
 * Sets the option text for the addon options page.
 */
function setOptionText() {

  const selectNodes = document.querySelectorAll("select");

  for (const selectNode of selectNodes) {
    const id = selectNode.getAttribute("id");

    let optionIndex = 0;

    for (const optionNode of selectNode.children) {
      if (id && (id in DEFAULT_PREFS)) {
        optionNode.innerText =
          browser.i18n.getMessage(id + "_option_" + optionIndex);
      }

      ++optionIndex;
    }
  }
}


/*
 * Sets the input element values for the addon options page.
 *
 * @param storedObject  object holding the contents of "sync" storage
 */
function setInputValues(storedObject) {

  // Merge default preferences with preferences from storage.
  const prefs = Object.assign(DEFAULT_PREFS, storedObject.preferences);

  // Load preference values into the user interface.
  for (let [id, value] of Object.entries(prefs)) {
    document.getElementById(id).value = value;
  }
}


document.addEventListener("DOMContentLoaded", setInterface);
document.querySelector("form").addEventListener("submit", saveOptions);
