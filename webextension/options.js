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
 * @param e             submit event
 */
function saveOptions(e) {

  if (e.type === "submit")
    e.preventDefault();

  // Copy default preferences.
  const prefs = Object.assign(DEFAULT_PREFS);

  // Replace defaults with each user preference from the options page.
  for (let [id, value] of Object.entries(prefs)) {

    const element = document.getElementById(id);
    const tagName = element.tagName;
    const type = element.type || '';

    if (tagName === "INPUT" && type === "checkbox") {
      prefs[id] = element.checked.toString();
    } else {
      prefs[id] = element.value.toString();
    }
  }

  // Save settings to "sync" storage.
  const savingPrefs = browser.storage.sync.set({ preferences: prefs });

  // Update the saved/unsaved message.
  savingPrefs.then(() => setSavedStateLabel(e));
}


/*
 * Sets the user interface for the options page.
 */
function setInterface() {

  // Get "sync" storage contents.
  let gettingStorage = browser.storage.sync.get();

  gettingStorage.then((storedObject) => {
    setLabelText();
    setOptionText();
    setButtonText();
    setInputValues(storedObject, true);
    setSavedStateLabel(new CustomEvent("set"));
  });
}


/*
 * Resets the user interface for the options page.
 * @param e             event
 */
function resetInterface(e) {

  // Pass an empty preferences object to use defaults.
  setInputValues({ preferences: {} });

  // Set the saved/unsaved message.
  setSavedStateLabel(e);
}


/*
 * Sets the button text for the options page.
 */
function setButtonText() {

  document.getElementById("reset").innerText =
    browser.i18n.getMessage("options_ui_reset");

  document.getElementById("submit").innerText =
    browser.i18n.getMessage("options_ui_submit");
}


/*
 * Sets the label text for the options page.
 */
function setLabelText() {
  const labelNodes = document.getElementsByTagName("label");

  for (const labelNode of labelNodes) {
    const id = labelNode.getAttribute("for");

    if (id && (id in DEFAULT_PREFS)) {
      labelNode.innerText = browser.i18n.getMessage(id + "_label");
    }
  }
}


/*
 * Sets the option text for the options page.
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
 * Sets the input element values for the options page.
 *
 * @param storedObject  contents of "sync" storage
 */
function setInputValues(storedObject, setListeners) {

  // Merge default preferences with preferences from storage.
  const prefs = Object.assign(DEFAULT_PREFS, storedObject.preferences);

  // Load preference values into the user interface.
  for (let [id, value] of Object.entries(prefs)) {

    const element = document.getElementById(id);
    const tagName = element.tagName;
    const type = element.type;

    if (tagName === "INPUT" && type === "checkbox") {
      element.checked = value === "true" ? "checked": false;
    } else {
      element.value = value;
    }

    if (setListeners) {
      element.addEventListener("change", setSavedStateLabel);
    }
  }
}


/*
 * Sets the saved/unsaved message on the options page.
 *
 * @param e             reset event
 */
function setSavedStateLabel(e) {

  const eventType = e && e.type;

  if (eventType === "set")
    return;

  const submitLabel = document.getElementById("submit_label");

  submitLabel.innerText = browser.i18n.getMessage(
    eventType === "submit" ?
      "options_ui_submit_saved_label" :
      "options_ui_submit_unsaved_label"
  );
}


document.addEventListener("DOMContentLoaded", setInterface);
document.querySelector("form").addEventListener("reset", resetInterface);
document.querySelector("form").addEventListener("submit", saveOptions);
