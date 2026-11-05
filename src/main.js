/* App entry: wires the store, app model, stage, layer and channel panels, matrix, audio controller, transport bar and dock. */
// From file:// the classic guard in index.html has already replaced the page with the "serve over HTTP(S)"
// message (and Chrome refuses module loads from file:// anyway): do no work there.
if (typeof location === 'undefined' || location.protocol !== 'file:') {
  try {
  const [{ createState, createStore }, { createAppState }, { createLayerPanel }, { createStage }, { createChannelPanel }, { createTimelineEditor }, { createMatrix }, { createAudioController }, { createTransportUI }, { createDock }, { EXAMPLE_LAYERS }] = await Promise.all([
    import('./core/state.js'),
    import('./ui/app-state.js'),
    import('./ui/layer-panel.js'),
    import('./ui/stage.js'),
    import('./ui/channel-panel.js'),
    import('./ui/timeline.js'),
    import('./ui/matrix.js'),
    import('./ui/audio-controller.js'),
    import('./ui/transport-ui.js'),
    import('./ui/dock.js'),
    import('./spectrum/examples.js'),
  ]);

  const store = createStore(createState());
  const app = createAppState({ store, examples: EXAMPLE_LAYERS });
  const stage = createStage(document.getElementById('stage-host'), { store, app });
  const audio = createAudioController({ store, app, onStageAnalysers: a => stage.setAnalysers(a) });
  const layerPanel = createLayerPanel(document.getElementById('layers'), app);
  const panel = createChannelPanel(document.getElementById('channels'), {
    store, app,
    onTrigger: async ch => { if (!audio.listening) await audio.start(); audio.trigger(ch); },
    mountTimeline: (slot, ch) => createTimelineEditor(slot, { store, app, channel: ch, getPlayhead: (...a) => audio.getPlayhead(...a) }),
  });

  const matrix = createMatrix(document.getElementById('matrix'), { store, app, onLearn: cb => audio.onLearn(cb) });
  const transportUi = createTransportUI(document.getElementById('transport'), { store, audio });
  const dock = createDock(document.getElementById('dock'), { store, app, audio });
  // pattern step highlight for the selected channel
  const stepLoop = () => { panel.setCurrentStep(audio.patternStep(app.selected)); requestAnimationFrame(stepLoop); };
  requestAnimationFrame(stepLoop);

  // tooltips (ported from the prototype)
  const tipEl = document.getElementById('tip');
  const chkTips = document.getElementById('chkTips');
  let tipsOn = true, tipTimer = 0, tipTarget = null;
  try { const v = localStorage.getItem('dfs-tips'); if (v !== null) tipsOn = v === '1'; } catch (e) { /* storage unavailable */ }
  chkTips.checked = tipsOn;
  const hideTip = () => { clearTimeout(tipTimer); tipEl.classList.remove('on'); };
  const showTip = el => {
    if (!tipsOn || !el.dataset.tip) return;
    tipEl.textContent = el.dataset.tip; tipEl.classList.add('on');
    const r = el.getBoundingClientRect(), tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
    const x = Math.min(Math.max(r.left, 8), Math.max(8, innerWidth - tw - 8)); let y = r.bottom + 8;
    if (y + th > innerHeight - 8) y = Math.max(8, r.top - th - 8);
    tipEl.style.left = x + 'px'; tipEl.style.top = y + 'px';
  };
  const tipOf = t => (t && t.closest ? t.closest('[data-tip]') : null);
  document.addEventListener('pointerover', e => {
    const el = tipOf(e.target);
    if (el === tipTarget) return;
    hideTip(); tipTarget = el;
    if (el && e.pointerType !== 'touch') tipTimer = setTimeout(() => showTip(el), 450);
  });
  document.addEventListener('pointerdown', () => { hideTip(); tipTarget = null; });
  document.addEventListener('focusin', e => { const el = tipOf(e.target); if (el && e.target.matches && e.target.matches(':focus-visible')) { tipTarget = el; showTip(el); } });
  document.addEventListener('focusout', () => { hideTip(); tipTarget = null; });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hideTip(); });
  addEventListener('scroll', () => { hideTip(); tipTarget = null; }, true);
  chkTips.addEventListener('change', () => {
    tipsOn = chkTips.checked; hideTip();
    try { localStorage.setItem('dfs-tips', tipsOn ? '1' : '0'); } catch (e) { /* storage unavailable */ }
  });

  window.__app = { store, app, panel, layerPanel, stage, matrix, audio, transportUi, dock, getPlayhead: (...a) => audio.getPlayhead(...a), onLearn: cb => audio.onLearn(cb) };
  console.info('app shell loaded');
  } catch (e) {
    console.error(e);
    const m = document.getElementById('msg') || document.body.appendChild(document.createElement('p'));
    m.id = 'msg'; m.textContent = 'The app failed to start: ' + (e && e.message || e);
  }
}
