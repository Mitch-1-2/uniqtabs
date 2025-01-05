/*
 * @file                Options script.
 * @author              Mitchell Field <mitchell.field@live.com.au>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/* prefs.js */
const PREFS_DEFAULT = {
  "pref_tabs_deduplicate_on_browser_action": "false",
  "pref_tabs_deduplicate_on_update": "false",
  "pref_tabs_sort_by_container": "true",
  "pref_tabs_sort_by_parts": "none",
  "pref_tabs_sort_by_query_string": "true",
  "pref_tabs_sort_on_browser_action": "false",
  "pref_tabs_sort_on_update": "false"
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
  const prefs = {};
  Object.assign(prefs, PREFS_DEFAULT);

  // Replace defaults with each user preference from the options page.
  for (let [name, value] of Object.entries(prefs)) {

    const elements = document.querySelectorAll(`input[name="${name}"]`);
    for (let element of elements) {
      let tagName = element.tagName;
      let type = element.type || "";

      if ("INPUT" && type === "checkbox") {
        prefs[name] = element.checked.toString();
      } else if (type === "radio") {
        if (element.checked)
          prefs[name] = element.value.toString();
      } else {
        prefs[name] = element.value.toString();
      }
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
  const labelNodes = document.querySelectorAll("label,legend");

  for (const labelNode of labelNodes) {
    const tagName = labelNode.tagName.toLowerCase();
    let id = labelNode.id;
    if (tagName === "label") {
      if (id !== "")
        continue;
      id = labelNode.getAttribute("for") + "_label";
    }

    labelNode.innerText = browser.i18n.getMessage(id);
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
      if (id && (id in PREFS_DEFAULT)) {
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
  const prefs = {};
  Object.assign(prefs, PREFS_DEFAULT, storedObject.preferences);

  // Load preference values into the user interface.
  for (let [name, value] of Object.entries(prefs)) {

    const elements = document.querySelectorAll(`input[name="${name}"]`);
    for (let element of elements) {
      let tagName = element.tagName;
      let type = element.type;
      if (tagName === "INPUT" && type === "checkbox") {
        element.checked = value === "true" ? "checked": false;
      } else if (type === "radio") {
        element.checked = value === element.value ? "checked": false;
      } else {
        element.value = value;
      }
      if (setListeners) {
        element.addEventListener("change", setSavedStateLabel);
      }
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
