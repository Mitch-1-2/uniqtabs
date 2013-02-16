/*
 * @author		Mitchell Field <mitchell.field@live.com.au>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

"use strict";
const {Cc, Ci} = require("chrome");
const idleService = Cc["@mozilla.org/widget/idleservice;1"]
					  .getService(Ci.nsIIdleService);
var _topic = "";
var _callback = null;
var _time = 0;

const idleObserver = {
	observe: function(subject, topic, data) {
		if (topic === "idle" && _topic === "idle") {
			_callback();
		}
		else if (topic === "active" && _topic === "active") {
			_callback();
		}
	}
};

function register(topic, callback, time) {
	unregister();
	_topic = topic;
	_callback = callback;
	_time = time;
	idleService.addIdleObserver(idleObserver, _time);
}

function unregister() {
	if (!_time)
		return;
	try {
		idleService.removeIdleObserver(idleObserver, _time);
	}
	catch (e) {
		// don't care
	}
}

exports.register = register;
exports.unregister = unregister;
