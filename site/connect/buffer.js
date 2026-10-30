// The redirect address registered with Buffer for Nordle's "Sign in with Buffer". Buffer sends the browser here with ?code=..&state=.. (or ?error=..&state=..);
// this page forwards it to Nordle on the SAME computer: http://127.0.0.1:<port>/app/oauth-callback.html. Buffer only accepts https redirect addresses, so a
// page like this is needed to reach a program on 127.0.0.1.
// What it must never do: send the browser anywhere but 127.0.0.1 (the host is written below, never read from the address), keep anything (no storage, no
// cookies, no requests, no analytics), or show text taken from the address as anything but text. The `state` was made by Nordle as p<port>-<32 hex digits>;
// anything else is not a sign-in Nordle started and is not forwarded. The code is useless without the PKCE verifier, which never leaves the computer.
(function () {
  var q = new URLSearchParams(location.search);
  var state = q.get('state') || '';
  var code = q.get('code');
  var error = q.get('error');
  var msg = document.getElementById('msg');
  var more = document.getElementById('more');

  var stop = function (text) {
    msg.textContent = text;
    msg.setAttribute('data-state', 'bad');
    if (more) more.textContent = '';
  };

  var m = /^p(\d{4,5})-[0-9a-f]{32}$/.exec(state);
  var port = m ? Number(m[1]) : 0;
  if (!m || port < 1024 || port > 65535) {
    stop('This is not a Buffer sign-in that Nordle started, so nothing was passed on. Open Nordle, go to Publishing, and press “Sign in with Buffer”.');
    return;
  }
  if (error !== null && !/^[a-z_]{1,40}$/.test(error)) error = 'error';
  if (code !== null && !/^[\x21-\x7e]{1,4096}$/.test(code)) {
    stop('Buffer sent back a code in a form this page does not accept, so nothing was passed on. Press “Sign in with Buffer” in Nordle to try again.');
    return;
  }
  if (!error && !code) {
    stop('Nothing came back from Buffer with this address, so there is nothing to pass on. Press “Sign in with Buffer” in Nordle to try again.');
    return;
  }

  // the host is fixed here on purpose
  var target = 'http://127.0.0.1:' + port + '/app/oauth-callback.html?' + (error ? 'error=' + encodeURIComponent(error) : 'code=' + encodeURIComponent(code)) + '&state=' + encodeURIComponent(state);
  location.replace(target);
})();
