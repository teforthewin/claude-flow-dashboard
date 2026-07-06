// Web-mode shim for window.electronAPI.
// In Electron this script is a no-op because the contextBridge has already
// installed window.electronAPI before the page evaluates this. In the browser
// (docker UI service), we polyfill the same surface against the REST API.
(function () {
  if (typeof window === 'undefined') return;
  if (window.electronAPI) return;

  var API_BASE =
    (window.__LOOMSCOPE_API_BASE__ || '').replace(/\/$/, '') || '/api';

  function json(method, path, body) {
    return fetch(API_BASE + path, {
      method: method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + path);
      return r.status === 204 ? null : r.json();
    });
  }

  var sseSource = null;
  var listeners = { entry: [], updated: [], teams: [], revoked: [], settings: [] };
  function ensureStream() {
    if (sseSource) return;
    sseSource = new EventSource(API_BASE + '/events');
    sseSource.addEventListener('sessions:entry', function (ev) {
      var data = JSON.parse(ev.data);
      listeners.entry.forEach(function (cb) { cb(data); });
    });
    sseSource.addEventListener('sessions:updated', function () {
      listeners.updated.forEach(function (cb) { cb(); });
    });
    sseSource.addEventListener('teams:updated', function () {
      listeners.teams.forEach(function (cb) { cb(); });
    });
    sseSource.addEventListener('teams:revoked', function (ev) {
      var data = JSON.parse(ev.data);
      listeners.revoked.forEach(function (cb) { cb(data.name); });
    });
  }
  function on(channel, cb) {
    ensureStream();
    listeners[channel].push(cb);
    return function () {
      listeners[channel] = listeners[channel].filter(function (x) { return x !== cb; });
    };
  }

  window.electronAPI = {
    getSessions: function () { return json('GET', '/sessions'); },
    getSession: function (id) { return json('GET', '/sessions/' + encodeURIComponent(id)); },
    getStats: function (id) { return json('GET', '/sessions/' + encodeURIComponent(id) + '/stats'); },
    deleteSessions: function (ids) { return json('POST', '/sessions/delete', { ids: ids }); },
    reloadSessions: function () { return json('POST', '/sessions/reload'); },
    archiveSessions: function () {
      // Archive download not supported in web mode; surface as no-op cancellation.
      return Promise.resolve({ cancelled: true });
    },

    onSessionEntry: function (cb) { return on('entry', cb); },
    onGlobalUpdate: function (cb) { return on('updated', cb); },

    getTeams: function () { return json('GET', '/teams'); },
    getTeamMessages: function (name) { return json('GET', '/teams/' + encodeURIComponent(name) + '/messages'); },
    onTeamsUpdate: function (cb) { return on('teams', cb); },
    onTeamRevoked: function (cb) { return on('revoked', cb); },
    archiveTeam: function () { return Promise.resolve({ cancelled: true }); },

    getSettings: function () { return json('GET', '/settings'); },
    checkSettings: function () { return json('GET', '/settings/check'); },
    setSettings: function (patch) { return json('PUT', '/settings', patch); },
    selectFolder: function () { return Promise.resolve(null); },
    openFolder: function () { return Promise.resolve({ ok: false }); },
    onSettingsChanged: function () { return function () {}; },
  };

  // Mark web mode for the renderer if it wants to adapt UI affordances.
  window.__LOOMSCOPE_WEB_MODE__ = true;
})();
