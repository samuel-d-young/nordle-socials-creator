// Where "Sign in with Buffer" lands on this computer. Buffer sends the browser to the hosted relay page (site/connect/buffer.html), which sends it
// here: http://127.0.0.1:<port>/app/oauth-callback.html?code=..&state=.. (or ?error=..&state=..). This page has no token, so it cannot call Nordle's API (and
// that is the point: the API stays closed to anything but the owner's Studio tab). It does one thing: hand {code, state, error} to the Studio tab that
// started the sign-in, over a BroadcastChannel (and, for browsers that block that here, a short-lived localStorage key), and show what happened.
// The code is useless without the PKCE verifier, which only Nordle's server has. No inline script here: the page's CSP allows scripts from 'self' only.
(function () {
  var NAME = 'nordle-buffer-oauth';
  var KEY = 'nordle-buffer-oauth';             // the fallback: the Studio tab reads it (storage event) and removes it
  var REPLY_KEY = 'nordle-buffer-oauth-reply';   // the Studio tab's answer when there is no BroadcastChannel
  var q = new URLSearchParams(location.search);
  var msg = { code: q.get('code'), state: q.get('state'), error: q.get('error') };
  // the code is in the address bar for as long as it takes to read it
  try { history.replaceState(null, '', location.pathname); } catch (e) { /* not worth stopping for */ }

  var main = document.querySelector('main');
  var line = document.getElementById('msg');
  var say = function (text, tone) { line.textContent = text; main.setAttribute('data-state', tone); };
  var heard = false;   // the Studio tab has answered at least once

  if (!msg.state || (!msg.code && !msg.error)) {
    say('This is the page Buffer sends you back to. Nothing came with it, so there is nothing to do here. Close this tab and press "Sign in with Buffer" in Nordle.', 'bad');
    return;
  }

  var onReply = function (d) {
    if (!d || typeof d.reply !== 'string' || d.state !== msg.state) return;
    heard = true;
    if (d.reply === 'received') say('Nordle has the sign-in and is finishing it…', 'waiting');
    else if (d.reply === 'done') { say('Connected to Nordle: you can close this tab.', 'ok'); setTimeout(function () { try { window.close(); } catch (e) { /* the person closes it */ } }, 1500); }
    else say(typeof d.message === 'string' && d.message ? d.message : 'Nordle could not finish the sign-in.', 'bad');
    if (d.reply !== 'received') { try { localStorage.removeItem(KEY); } catch (e) { /* blocked */ } }
  };

  var channel = null;
  try { channel = new BroadcastChannel(NAME); channel.onmessage = function (e) { onReply(e.data); }; } catch (e) { channel = null; }
  window.addEventListener('storage', function (e) {
    if (e.key !== REPLY_KEY || !e.newValue) return;
    try { onReply(JSON.parse(e.newValue)); } catch (err) { /* not for us */ }
  });

  if (msg.error && !msg.code) say('Buffer did not sign you in. Nordle will say so; this tab can be closed.', 'bad');
  if (channel) channel.postMessage(msg);
  try {
    localStorage.setItem(KEY, JSON.stringify({ code: msg.code, state: msg.state, error: msg.error, at: Date.now() }));
    setTimeout(function () { try { localStorage.removeItem(KEY); } catch (e) { /* blocked */ } }, 60000);
  } catch (e) { /* the channel is enough, or nothing is */ }

  setTimeout(function () {
    if (heard) return;
    say('Nordle did not answer. Its Publishing window has to be open in this same browser. Open it, press "Sign in with Buffer" again, and approve it once more.', 'bad');
  }, 5000);
})();
