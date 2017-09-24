"use strict";
/**
 * Load a file packaged with the extension
 *
 * @param url: a relative URL to local file
 */
function loadExtensionFile(url, returnType) {
  var xhr = new XMLHttpRequest();
  // Use blocking XHR to ensure everything is loaded by the time
  // we return.
  xhr.open("GET", chrome.extension.getURL(url), false);
  xhr.send(null);
  // Get file contents
  if (xhr.readyState != 4) {
    return;
  }
  if (returnType === 'xml') {
    return xhr.responseXML;
  }
  if (returnType === 'json') {
    return JSON.parse(xhr.responseText);
  }
  return xhr.responseText;
}


// Rules are loaded here
var all_rules, ls;
try{
  ls = localStorage;
} catch(e) {
  ls = {setItem: () => {}, getItem: () => {}};
}
all_rules = new RuleSets(ls);

// Allow users to enable `platform="mixedcontent"` rulesets
var enableMixedRulesets = false;
storage.get({enableMixedRulesets: false}, function(item) {
  enableMixedRulesets = item.enableMixedRulesets;
  all_rules.addFromJson(loadExtensionFile('rules/default.rulesets', 'json'));
});

// Load in the legacy custom rulesets, if any
function load_legacy_custom_rulesets(legacy_custom_rulesets){
  for(let legacy_custom_ruleset of legacy_custom_rulesets){
    all_rules.addFromXml((new DOMParser()).parseFromString(legacy_custom_ruleset, 'text/xml'));
  }
}
storage.get({legacy_custom_rulesets: []}, item => load_legacy_custom_rulesets(item.legacy_custom_rulesets));

var USER_RULE_KEY = 'userRules';
// Records which tabId's are active in the HTTPS Switch Planner (see
// devtools-panel.js).
var switchPlannerEnabledFor = {};
// Detailed information recorded when the HTTPS Switch Planner is active.
// Structure is:
//   switchPlannerInfo[tabId]["rw"/"nrw"][resource_host][active_content][url];
// rw / nrw stand for "rewritten" versus "not rewritten"
var switchPlannerInfo = {};

/**
 * Load preferences. Structure is:
 *  {
 *    httpNowhere: Boolean,
 *    showCounter: Boolean,
 *    isExtensionEnabled: Boolean
 *  }
 */
var httpNowhereOn = false;
var showCounter = true;
var isExtensionEnabled = true;

var initializeStoredGlobals = () => {
  storage.get({
    httpNowhere: false,
    showCounter: true,
    globalEnabled: true
  }, function(item) {
    httpNowhereOn = item.httpNowhere;
    showCounter = item.showCounter;
    isExtensionEnabled = item.globalEnabled;
    updateState();
  });
}
initializeStoredGlobals();

chrome.storage.onChanged.addListener(function(changes, areaName) {
  if (areaName === 'sync' || areaName === 'local') {
    if ('httpNowhere' in changes) {
      httpNowhereOn = changes.httpNowhere.newValue;
      updateState();
    }
    if ('showCounter' in changes) {
      showCounter = changes.showCounter.newValue;
      updateState();
    }
    if ('globalEnabled' in changes) {
      isExtensionEnabled = changes.globalEnabled.newValue;
      updateState();
    }
  }
});

if (chrome.tabs) {
  chrome.tabs.onActivated.addListener(function() {
    updateState();
  });
}
if (chrome.windows) {
  chrome.windows.onFocusChanged.addListener(function() {
    updateState();
  });
}
chrome.webNavigation.onCompleted.addListener(function() {
  updateState();
});

/**
* Load stored user rules
 **/
var getStoredUserRules = function() {
  var oldUserRuleString = ls.getItem(USER_RULE_KEY);
  var oldUserRules = [];
  if (oldUserRuleString) {
    oldUserRules = JSON.parse(oldUserRuleString);
  }
  return oldUserRules;
};
var wr = chrome.webRequest;

/**
 * Load all stored user rules
 */
var loadStoredUserRules = function() {
  var rules = getStoredUserRules();
  var i;
  for (let rule of rules) {
    all_rules.addUserRule(rule);
  }
  log('INFO', 'loaded ' + i + ' stored user rules');
};

loadStoredUserRules();

function getActiveRulesetCount(id) {
  const applied = activeRulesets.getRulesets(id);

  if (!applied)
  {
    return 0;
  }

  let activeCount = 0;

  for (const key in applied) {
    if (applied[key].active) {
      activeCount++;
    }
  }

  return activeCount;
}

/**
 * Set the icon color correctly
 * active: extension is enabled.
 * blocking: extension is in "block all HTTP requests" mode.
 * disabled: extension is disabled from the popup menu.
 */

function updateState () {
  if (!chrome.tabs) return;

  let iconState = 'active';

  if (!isExtensionEnabled) {
    iconState = 'disabled';
  } else if (httpNowhereOn) {
    iconState = 'blocking';
  }

  chrome.browserAction.setIcon({
    path: {
      38: 'icons/icon-' + iconState + '-38.png'
    }
  });

  chrome.browserAction.setTitle({
    title: 'HTTPS Everywhere' + (iconState === 'active') ? '' : ' (' + iconState + ')'
  });

  chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
    if (!tabs || tabs.length === 0) {
      return;
    }

    const activeCount = getActiveRulesetCount(tabs[0].id);

    chrome.browserAction.setBadgeBackgroundColor({ color: '#00cc00' });

    const showBadge = activeCount > 0 && isExtensionEnabled && showCounter;

    chrome.browserAction.setBadgeText({ text: showBadge ? String(activeCount) : '' });
  });
}

/**
 * Adds a new user rule
 * @param params: params defining the rule
 * @param cb: Callback to call after success/fail
 * */
var addNewRule = function(params, cb) {
  if (all_rules.addUserRule(params)) {
    // If we successfully added the user rule, save it in local 
    // storage so it's automatically applied when the extension is 
    // reloaded.
    var oldUserRules = getStoredUserRules();
    // TODO: there's a race condition here, if this code is ever executed from multiple 
    // client windows in different event loops.
    oldUserRules.push(params);
    // TODO: can we exceed the max size for storage?
    ls.setItem(USER_RULE_KEY, JSON.stringify(oldUserRules));
    cb(true);
  } else {
    cb(false);
  }
};

/**
 * Removes a user rule
 * @param ruleset: the ruleset to remove
 * */
var removeRule = function(ruleset) {
  if (all_rules.removeUserRule(ruleset)) {
    // If we successfully removed the user rule, remove it in local storage too
    var userRules = getStoredUserRules();
    userRules = userRules.filter(r =>
      !(r.host == ruleset.name &&
        r.redirectTo == ruleset.rules[0].to &&
        String(RegExp(r.urlMatcher)) == String(ruleset.rules[0].from_c))
    );
    ls.setItem(USER_RULE_KEY, JSON.stringify(userRules));
  }
}

/**
 * Adds a listener for removed tabs
 * */
function AppliedRulesets() {
  this.active_tab_rules = {};

  var that = this;
  if (chrome.tabs) {
    chrome.tabs.onRemoved.addListener(function(tabId, info) {
      that.removeTab(tabId);
    });
  }
}

AppliedRulesets.prototype = {
  addRulesetToTab: function(tabId, ruleset) {
    if (tabId in this.active_tab_rules) {
      this.active_tab_rules[tabId][ruleset.name] = ruleset;
    } else {
      this.active_tab_rules[tabId] = {};
      this.active_tab_rules[tabId][ruleset.name] = ruleset;
    }
  },

  getRulesets: function(tabId) {
    if (tabId in this.active_tab_rules) {
      return this.active_tab_rules[tabId];
    }
    return null;
  },

  removeTab: function(tabId) {
    delete this.active_tab_rules[tabId];
  }
};

// FIXME: change this name
var activeRulesets = new AppliedRulesets();

var urlBlacklist = new Set();
var domainBlacklist = new Set();

// redirect counter workaround
// TODO: Remove this code if they ever give us a real counter
var redirectCounter = new Map();

/**
 * Called before a HTTP(s) request. Does the heavy lifting
 * Cancels the request/redirects it to HTTPS. URL modification happens in here.
 * @param details of the handler, see Chrome doc
 * */
function onBeforeRequest(details) {
  // If HTTPSe has been disabled by the user, return immediately.
  if (!isExtensionEnabled) {
    return;
  }

  const uri = new URL(details.url);

  // Should the request be canceled?
  var shouldCancel = (
    httpNowhereOn &&
    uri.protocol === 'http:' &&
    !/\.onion$/.test(uri.hostname) &&
    !/^localhost$/.test(uri.hostname) &&
    !/^127(\.[0-9]{1,3}){3}$/.test(uri.hostname) &&
    !/^0\.0\.0\.0$/.test(uri.hostname)
  );

  // Normalise hosts such as "www.example.com."
  var canonical_host = uri.hostname;
  if (canonical_host.charAt(canonical_host.length - 1) == ".") {
    while (canonical_host.charAt(canonical_host.length - 1) == ".")
      canonical_host = canonical_host.slice(0,-1);
    uri.hostname = canonical_host;
  }

  // If there is a username / password, put them aside during the ruleset
  // analysis process
  var using_credentials_in_url = false;
  if (uri.password || uri.username) {
    using_credentials_in_url = true;
    var tmp_user = uri.username;
    var tmp_pass = uri.password;
    uri.username = null;
    uri.password = null;
  }

  var canonical_url = uri.href;
  if (details.url != canonical_url && !using_credentials_in_url) {
    log(INFO, "Original url " + details.url + 
        " changed before processing to " + canonical_url);
  }
  if (urlBlacklist.has(canonical_url)) {
    return {cancel: shouldCancel};
  }

  if (details.type == "main_frame") {
    activeRulesets.removeTab(details.tabId);
  }

  var potentiallyApplicable = all_rules.potentiallyApplicableRulesets(uri.hostname);

  if (redirectCounter.get(details.requestId) >= 8) {
    log(NOTE, "Redirect counter hit for " + canonical_url);
    urlBlacklist.add(canonical_url);
    var hostname = uri.hostname;
    domainBlacklist.add(hostname);
    log(WARN, "Domain blacklisted " + hostname);
    return {cancel: shouldCancel};
  }

  var newuristr = null;

  for (let ruleset of potentiallyApplicable) {
    activeRulesets.addRulesetToTab(details.tabId, ruleset);
    if (ruleset.active && !newuristr) {
      newuristr = ruleset.apply(canonical_url);
    }
  }

  if (newuristr && using_credentials_in_url) {
    // re-insert userpass info which was stripped temporarily
    const uri_with_credentials = new URL(newuristr);
    uri_with_credentials.username = tmp_user;
    uri_with_credentials.password = tmp_pass;
    newuristr = uri_with_credentials.href;
  }

  // In Switch Planner Mode, record any non-rewriteable
  // HTTP URIs by parent hostname, along with the resource type.
  if (switchPlannerEnabledFor[details.tabId] && uri.protocol !== "https:") {
    writeToSwitchPlanner(details.type,
      details.tabId,
      canonical_host,
      details.url,
      newuristr);
  }

  if (httpNowhereOn) {
    // If loading a main frame, try the HTTPS version as an alternative to
    // failing.
    if (shouldCancel) {
      if (!newuristr) {
        return {redirectUrl: canonical_url.replace(/^http:/, "https:")};
      } else {
        return {redirectUrl: newuristr.replace(/^http:/, "https:")};
      }
    }
    if (newuristr && newuristr.substring(0, 5) === "http:") {
      // Abort early if we're about to redirect to HTTP in HTTP Nowhere mode
      return {cancel: true};
    }
  }

  if (newuristr) {
    return {redirectUrl: newuristr};
  } else {
    return {cancel: shouldCancel};
  }
}


// Map of which values for the `type' enum denote active vs passive content.
// https://developer.chrome.com/extensions/webRequest.html#event-onBeforeRequest
var activeTypes = { stylesheet: 1, script: 1, object: 1, other: 1};

// We consider sub_frame to be passive even though it can contain JS or flash.
// This is because code running in the sub_frame cannot access the main frame's
// content, by same-origin policy. This is true even if the sub_frame is on the
// same domain but different protocol - i.e. HTTP while the parent is HTTPS -
// because same-origin policy includes the protocol. This also mimics Chrome's
// UI treatment of insecure subframes.
var passiveTypes = { main_frame: 1, sub_frame: 1, image: 1, xmlhttprequest: 1};

/**
 * Record a non-HTTPS URL loaded by a given hostname in the Switch Planner, for
 * use in determining which resources need to be ported to HTTPS.
 * (Reminder: Switch planner is the pro-tool enabled by switching into debug-mode)
 *
 * @param type: type of the resource (see activeTypes and passiveTypes arrays)
 * @param tab_id: The id of the tab
 * @param resource_host: The host of the original url
 * @param resource_url: the original url
 * @param rewritten_url: The url rewritten to
 * */
function writeToSwitchPlanner(type, tab_id, resource_host, resource_url, rewritten_url) {
  var rw = "rw";
  if (rewritten_url == null)
    rw = "nrw";

  var active_content = 0;
  if (activeTypes[type]) {
    active_content = 1;
  } else if (passiveTypes[type]) {
    active_content = 0;
  } else {
    log(WARN, "Unknown type from onBeforeRequest details: `" + type + "', assuming active");
    active_content = 1;
  }

  if (!switchPlannerInfo[tab_id]) {
    switchPlannerInfo[tab_id] = {};
    switchPlannerInfo[tab_id]["rw"] = {};
    switchPlannerInfo[tab_id]["nrw"] = {};
  }
  if (!switchPlannerInfo[tab_id][rw][resource_host])
    switchPlannerInfo[tab_id][rw][resource_host] = {};
  if (!switchPlannerInfo[tab_id][rw][resource_host][active_content])
    switchPlannerInfo[tab_id][rw][resource_host][active_content] = {};

  switchPlannerInfo[tab_id][rw][resource_host][active_content][resource_url] = 1;
}

/**
 * Return the number of properties in an object. For associative maps, this is
 * their size.
 * @param obj: object to calc the size for
 * */
function objSize(obj) {
  if (typeof obj == 'undefined') return 0;
  var size = 0, key;
  for (key in obj) {
    if (obj.hasOwnProperty(key)) size++;
  }
  return size;
}

/**
 * Make an array of asset hosts by score so we can sort them,
 * presenting the most important ones first.
 * */
function sortSwitchPlanner(tab_id, rewritten) {
  var asset_host_list = [];
  if (typeof switchPlannerInfo[tab_id] === 'undefined' ||
      typeof switchPlannerInfo[tab_id][rewritten] === 'undefined') {
    return [];
  }
  var tabInfo = switchPlannerInfo[tab_id][rewritten];
  for (var asset_host in tabInfo) {
    var ah = tabInfo[asset_host];
    var activeCount = objSize(ah[1]);
    var passiveCount = objSize(ah[0]);
    var score = activeCount * 100 + passiveCount;
    asset_host_list.push([score, activeCount, passiveCount, asset_host]);
  }
  asset_host_list.sort(function(a,b){return a[0]-b[0];});
  return asset_host_list;
}

/**
 * monitor cookie changes. Automatically convert them to secure cookies
 * @param changeInfo Cookie changed info, see Chrome doc
 * */
function onCookieChanged(changeInfo) {
  if (!changeInfo.removed && !changeInfo.cookie.secure && isExtensionEnabled) {
    if (all_rules.shouldSecureCookie(changeInfo.cookie)) {
      var cookie = {name:changeInfo.cookie.name,
        value:changeInfo.cookie.value,
        path:changeInfo.cookie.path,
        httpOnly:changeInfo.cookie.httpOnly,
        expirationDate:changeInfo.cookie.expirationDate,
        storeId:changeInfo.cookie.storeId,
        secure: true};

      // Host-only cookies don't set the domain field.
      if (!changeInfo.cookie.hostOnly) {
        cookie.domain = changeInfo.cookie.domain;
      }

      // The cookie API is magical -- we must recreate the URL from the domain and path.
      if (changeInfo.cookie.domain[0] == ".") {
        cookie.url = "https://www" + changeInfo.cookie.domain + cookie.path;
      } else {
        cookie.url = "https://" + changeInfo.cookie.domain + cookie.path;
      }
      // We get repeated events for some cookies because sites change their
      // value repeatedly and remove the "secure" flag.
      log(DBUG,
        "Securing cookie " + cookie.name + " for " + changeInfo.cookie.domain + ", was secure=" + changeInfo.cookie.secure);
      chrome.cookies.set(cookie);
    }
  }
}

/**
 * handling redirects, breaking loops
 * @param details details for the redirect (see chrome doc)
 * */
function onBeforeRedirect(details) {
  // Catch redirect loops (ignoring about:blank, etc. caused by other extensions)
  let prefix = details.redirectUrl.substring(0, 5);
  if (prefix === "http:" || prefix === "https") {
    let count = redirectCounter.get(details.requestId);
    if (count) {
      redirectCounter.set(details.requestId, count + 1);
      log(DBUG, "Got redirect id "+details.requestId+
                ": "+count);
    } else {
      redirectCounter.set(details.requestId, 1);
    }
  }
}

/**
 * handle webrequest.onCompleted, cleanup redirectCounter
 * @param details details for the chrome.webRequest (see chrome doc)
 */
function onCompleted(details) {
  if (redirectCounter.has(details.requestId)) {
    redirectCounter.delete(details.requestId);
  }
}

/**
 * handle webrequest.onErrorOccurred, cleanup redirectCounter
 * @param details details for the chrome.webRequest (see chrome doc)
 */
function onErrorOccurred(details) {
  if (redirectCounter.has(details.requestId)) {
    redirectCounter.delete(details.requestId);
  }
}

// Registers the handler for requests
// See: https://github.com/EFForg/https-everywhere/issues/10039
wr.onBeforeRequest.addListener(onBeforeRequest, {urls: ["*://*/*"]}, ["blocking"]);


// Try to catch redirect loops on URLs we've redirected to HTTPS.
wr.onBeforeRedirect.addListener(onBeforeRedirect, {urls: ["https://*/*"]});

// Cleanup redirectCounter if neccessary
wr.onCompleted.addListener(onCompleted, {urls: ["*://*/*"]});

// Cleanup redirectCounter if neccessary
wr.onErrorOccurred.addListener(onErrorOccurred, {urls: ["*://*/*"]})

// Listen for cookies set/updated and secure them if applicable. This function is async/nonblocking.
chrome.cookies.onChanged.addListener(onCookieChanged);

/**
 * disable switch Planner
 * @param tabId the Tab to disable for
 */
function disableSwitchPlannerFor(tabId) {
  delete switchPlannerEnabledFor[tabId];
  // Clear stored URL info.
  delete switchPlannerInfo[tabId];
}

/**
 * Enable switch planner for specific tab
 * @param tabId the tab to enable it for
 */
function enableSwitchPlannerFor(tabId) {
  switchPlannerEnabledFor[tabId] = true;
}

// Listen for connection from the DevTools panel so we can set up communication.
chrome.runtime.onConnect.addListener(function (port) {
  if (port.name == "devtools-page") {
    chrome.runtime.onMessage.addListener(function(message, sender, sendResponse){
      var tabId = message.tabId;

      var disableOnCloseCallback = function(port) {
        log(DBUG, "Devtools window for tab " + tabId + " closed, clearing data.");
        disableSwitchPlannerFor(tabId);
      };

      if (message.type === "enable") {
        enableSwitchPlannerFor(tabId);
        port.onDisconnect.addListener(disableOnCloseCallback);
      } else if (message.type === "disable") {
        disableSwitchPlannerFor(tabId);
      } else if (message.type === "getHosts") {
        sendResponse({
          nrw: sortSwitchPlanner(tabId, "nrw"),
          rw: sortSwitchPlanner(tabId, "rw")
        });
      }
    });
  }
});

// This is necessary for communication with the popup in Firefox Private
// Browsing Mode, see https://bugzilla.mozilla.org/show_bug.cgi?id=1329304
chrome.runtime.onMessage.addListener(function(message, sender, sendResponse){
  if (message.type == "get_option") {
    storage.get(message.object, sendResponse);
    return true;
  } else if (message.type == "set_option") {
    storage.set(message.object, item => {
      if (sendResponse) {
        sendResponse(item);
      }
    });
  } else if (message.type == "delete_from_ruleset_cache") {
    all_rules.ruleCache.delete(message.object);
  } else if (message.type == "get_active_rulesets") {
    sendResponse(activeRulesets.getRulesets(message.object));
  } else if (message.type == "set_ruleset_active_status") {
    var ruleset = activeRulesets.getRulesets(message.object.tab_id)[message.object.name];
    ruleset.active = message.object.active;
    sendResponse(true);
  } else if (message.type == "add_new_rule") {
    addNewRule(message.object, function() {
      sendResponse(true);
    });
    return true;
  } else if (message.type == "remove_rule") {
    removeRule(message.object);
  } else if (message.type == "import_settings") {
    // This is used when importing settings from the options ui
    import_settings(message.object).then(() => {
      sendResponse(true);
    });
  }
});

// Send a message to the embedded webextension bootstrap.js to get settings to import
chrome.runtime.sendMessage("import-legacy-data", import_settings);

/**
 * Import extension settings (custom rulesets, ruleset toggles, globals) from an object
 * @param settings the settings object
 */
async function import_settings(settings) {
  if (settings.changed) {
    // Load all the ruleset toggles into memory and store
    for (const ruleset_name in settings.rule_toggle) {
      ls[ruleset_name] = settings.rule_toggle[ruleset_name];
    }

    all_rules = new RuleSets(ls);
    all_rules.addFromJson(loadExtensionFile('rules/default.rulesets', 'json'));

    // Load custom rulesets
    load_legacy_custom_rulesets(settings.custom_rulesets);

    // Save settings
    await new Promise(resolve => {
      storage.set({
        legacy_custom_rulesets: settings.custom_rulesets,
        httpNowhere: settings.prefs.http_nowhere_enabled,
        showCounter: settings.prefs.show_counter,
        globalEnabled: settings.prefs.global_enabled
      }, resolve);
    });
  }
}
