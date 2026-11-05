/* App entry (stub). The UI tasks build the shell here. */
// From file:// the classic guard in app.html has already replaced the page with the "serve over HTTP(S)"
// message (and Chrome refuses module loads from file:// anyway): do no work there.
if (typeof location === 'undefined' || location.protocol !== 'file:') {
  console.info('app shell loaded');
}
