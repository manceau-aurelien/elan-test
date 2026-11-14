(function () {
  'use strict';

  const C = window.ElanCalendar;
  const STORAGE_KEY = 'elan_proto_state_v2';
  const LEGACY_STORAGE_KEY = 'elan_proto_state_v1';
  const RING_CIRCUMFERENCE = 2 * Math.PI * 74; // r = 74

  // =========================================================================
  // Helpers
  // =========================================================================

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function uid(prefix = 'id') {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  function playGentleChime() {
    try {
      if (navigator.vibrate) {
        navigator.vibrate([120, 60, 140]);
      }
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const notes = [523.25, 659.25, 783.99]; // C5 E5 G5
      notes.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        const start = ctx.currentTime + i * 0.11;
        gain.gain.setValueAtTime(0.001, start);
        gain.gain.exponentialRampToValueAtTime(0.12, start + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.35);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.38);
      });
    } catch (_) {
      // Audio playback blocked or unavailable; ignore gracefully
    }
  }

  function formatMMSS(totalSeconds) {
    const s = Math.max(0, Math.ceil(totalSeconds));
    const min = Math.floor(s / 60);
    const sec = s % 60;
    return `${C.pad2(min)}:${C.pad2(sec)}`;
  }

  // =========================================================================
  // State Management
  // =========================================================================

  function createDefaultState(emptyMode = true, preserveTheme = 'light') {
    const now = new Date();
    const todayKey = C.toDateKey(now);
    const settings = { dayStartMin: 8 * 60, dayEndMin: 21 * 60 + 30 };

    if (emptyMode) {
      return {
        version: 1,
        activeTab: 'now',
        selectedWeekDateKey: todayKey,
        theme: preserveTheme,
        settings,
        calendarSource: 'empty',
        events: [],
        tasks: [],
        history: [],
        savedMinutes: 0,
        elanScore: 0,
        streakDays: 0,
        restShieldUsedDate: null,
        focusMinutesToday: 0,
        focusDateKey: todayKey,
        timer: null,
        breakTimer: null
      };
    }

    const demo = C.createDemoData(now, settings);
    return {
      version: 1,
      activeTab: 'now',
      selectedWeekDateKey: todayKey,
      theme: preserveTheme,
      settings,
      calendarSource: 'demo',
      events: demo.events,
      tasks: demo.tasks,
      history: demo.history,
      savedMinutes: demo.savedMinutes,
      elanScore: demo.elanScore,
      streakDays: demo.streakDays,
      restShieldUsedDate: null,
      focusMinutesToday: demo.focusMinutesToday,
      focusDateKey: todayKey,
      timer: null,
      breakTimer: null
    };
  }

  function loadState() {
    try {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return createDefaultState(true);
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== 1) return createDefaultState(true);
      const todayKey = C.toDateKey(new Date());
      if (parsed.focusDateKey !== todayKey) {
        parsed.focusDateKey = todayKey;
        parsed.focusMinutesToday = 0;
      }
      // Refresh remaining seconds if a timer was running across reload
      if (parsed.timer && parsed.timer.running && parsed.timer.targetEndMs) {
        const rem = Math.max(0, Math.ceil((parsed.timer.targetEndMs - Date.now()) / 1000));
        parsed.timer.remainingSec = rem;
        if (rem === 0) {
          if (parsed.timer.startedRunAtMs) {
            parsed.timer.elapsedBeforeRunSec =
              (parsed.timer.elapsedBeforeRunSec || 0) +
              Math.max(0, Math.round((parsed.timer.targetEndMs - parsed.timer.startedRunAtMs) / 1000));
          }
          parsed.timer.startedRunAtMs = null;
          parsed.timer.targetEndMs = null;
          parsed.timer.running = false;
        }
      }
      if (parsed.breakTimer && parsed.breakTimer.running && parsed.breakTimer.targetEndMs) {
        const rem = Math.max(0, Math.ceil((parsed.breakTimer.targetEndMs - Date.now()) / 1000));
        parsed.breakTimer.remainingSec = rem;
        if (rem === 0) parsed.breakTimer = null;
      }
      return parsed;
    } catch (_) {
      return createDefaultState(true);
    }
  }

  let state = loadState();
  let quickAddDraft = {
    durationMin: 25,
    horizon: 'soon',
    pinnedSlot: null // { dateKey, startMin, maxDurationMin }
  };
  let breakdownTaskId = null;
  let slotPickerTaskId = null;

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (_) {
      // Storage quota full or disabled
    }
  }

  // =========================================================================
  // DOM References
  // =========================================================================

  const dom = {
    desktopStage: document.getElementById('desktopStage'),
    toggleFrameBtn: document.getElementById('toggleFrameBtn'),
    appShell: document.getElementById('appShell'),
    headerClock: document.getElementById('headerClock'),
    headerBankBtn: document.getElementById('headerBankBtn'),
    headerBankText: document.getElementById('headerBankText'),
    openAgendaBtn: document.getElementById('openAgendaBtn'),
    toggleThemeBtn: document.getElementById('toggleThemeBtn'),
    contextBanner: document.getElementById('contextBanner'),
    mainContent: document.getElementById('mainContent'),
    navItems: document.querySelectorAll('.nav-item[data-tab]'),
    openQuickAddBtn: document.getElementById('openQuickAddBtn'),
    sheetBackdrop: document.getElementById('sheetBackdrop'),
    quickAddSheet: document.getElementById('quickAddSheet'),
    quickAddForm: document.getElementById('quickAddForm'),
    quickTaskInput: document.getElementById('quickTaskInput'),
    nlpHint: document.getElementById('nlpHint'),
    pinnedSlotBanner: document.getElementById('pinnedSlotBanner'),
    horizonSection: document.getElementById('horizonSection'),
    victoryCheckbox: document.getElementById('victoryCheckbox'),
    quickAddSubmitBtn: document.getElementById('quickAddSubmitBtn'),
    breakdownSheet: document.getElementById('breakdownSheet'),
    breakdownForm: document.getElementById('breakdownForm'),
    breakdownTargetName: document.getElementById('breakdownTargetName'),
    microStepsList: document.getElementById('microStepsList'),
    slotPickerSheet: document.getElementById('slotPickerSheet'),
    slotPickerTaskLabel: document.getElementById('slotPickerTaskLabel'),
    slotPickerList: document.getElementById('slotPickerList'),
    agendaSheet: document.getElementById('agendaSheet'),
    calendarSourceBadge: document.getElementById('calendarSourceBadge'),
    icsFileInput: document.getElementById('icsFileInput'),
    exportIcsBtn: document.getElementById('exportIcsBtn'),
    dayStartSelect: document.getElementById('dayStartSelect'),
    dayEndSelect: document.getElementById('dayEndSelect'),
    resetDemoBtn: document.getElementById('resetDemoBtn'),
    clearAllBtn: document.getElementById('clearAllBtn'),
    toastContainer: document.getElementById('toastContainer'),
    burstLayer: document.getElementById('burstLayer')
  };

  // =========================================================================
  // UI Feedback (Toasts, Confetti Burst, Theme)
  // =========================================================================

  function showToast(message) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    dom.toastContainer.appendChild(el);
    setTimeout(() => {
      el.remove();
    }, 3100);
  }

  function triggerBurst() {
    const colors = ['#4f46e5', '#10b981', '#f97316', '#eab308', '#ec4899'];
    const cx = dom.appShell.clientWidth / 2;
    const cy = dom.appShell.clientHeight * 0.36;
    for (let i = 0; i < 18; i++) {
      const dot = document.createElement('span');
      dot.className = 'burst-dot';
      const angle = (Math.PI * 2 * i) / 18 + Math.random() * 0.25;
      const dist = 55 + Math.random() * 85;
      dot.style.left = `${cx}px`;
      dot.style.top = `${cy}px`;
      dot.style.background = colors[i % colors.length];
      dot.style.setProperty('--dx', `${Math.round(Math.cos(angle) * dist)}px`);
      dot.style.setProperty('--dy', `${Math.round(Math.sin(angle) * dist)}px`);
      dom.burstLayer.appendChild(dot);
      setTimeout(() => dot.remove(), 900);
    }
  }

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.theme);
    dom.toggleThemeBtn.textContent = state.theme === 'dark' ? '☀️' : '🌙';
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) {
      metaTheme.setAttribute('content', state.theme === 'dark' ? '#0d1321' : '#4f46e5');
    }
  }

  // =========================================================================
  // Business Logic & Timer Engine
  // =========================================================================

  function getTodayContext() {
    const now = new Date();
    return {
      now,
      todayKey: C.toDateKey(now),
      nowMin: C.getNowMinutes(now)
    };
  }

  function getOverdueTasks(todayKey, nowMin) {
    return state.tasks.filter((t) => {
      if (t.completed || !t.scheduledDateKey || t.scheduledStartMin == null) return false;
      if (t.scheduledDateKey < todayKey) return true;
      return t.scheduledDateKey === todayKey && t.scheduledStartMin + t.durationMin <= nowMin;
    });
  }

  function getFocusCandidateTask(todayKey, nowMin) {
    if (state.timer) {
      const active = state.tasks.find((t) => t.id === state.timer.taskId && !t.completed);
      if (active) return active;
    }

    const incomplete = state.tasks.filter((t) => !t.completed);
    if (!incomplete.length) return null;

    // 1. Currently ongoing or upcoming today (excluding missed past blocks unless nothing else)
    const todayUpcoming = incomplete
      .filter((t) => t.scheduledDateKey === todayKey && t.scheduledStartMin + t.durationMin > nowMin)
      .sort((a, b) => a.scheduledStartMin - b.scheduledStartMin);
    if (todayUpcoming.length) return todayUpcoming[0];

    // 2. Any victory today or soon
    const victories = incomplete.filter((t) => t.isVictory);
    if (victories.length) return victories[0];

    // 3. Upcoming scheduled this week
    const futureScheduled = incomplete
      .filter((t) => t.scheduledDateKey)
      .sort((a, b) => {
        if (a.scheduledDateKey !== b.scheduledDateKey) {
          return a.scheduledDateKey.localeCompare(b.scheduledDateKey);
        }
        return (a.scheduledStartMin || 0) - (b.scheduledStartMin || 0);
      });
    if (futureScheduled.length) return futureScheduled[0];

    // 4. First weekly backlog item
    return incomplete[0];
  }

  function startTaskTimer(taskId, mode = 'full') {
    const task = state.tasks.find((t) => t.id === taskId && !t.completed);
    if (!task) return;

    const totalSec = mode === 'starter' ? 5 * 60 : Math.max(60, task.durationMin * 60);
    const nowMs = Date.now();
    state.timer = {
      taskId: task.id,
      mode,
      totalSec,
      remainingSec: totalSec,
      running: true,
      targetEndMs: nowMs + totalSec * 1000,
      startedRunAtMs: nowMs,
      elapsedBeforeRunSec: 0
    };

    // Reward starting right away to beat procrastination!
    const startPoints = mode === 'starter' ? 12 : 10;
    state.elanScore += startPoints;

    saveState();
    render();
    showToast(
      mode === 'starter'
        ? `⚡ Juste 5 min lancés ! (+${startPoints} pts d'Élan)`
        : `▶ Bloc focus lancé ! (+${startPoints} pts d'Élan)`
    );
  }

  function getTimerElapsedSec(tm) {
    if (!tm) return 0;
    const base = tm.elapsedBeforeRunSec || 0;
    if (tm.running && tm.startedRunAtMs) {
      return base + Math.max(0, Math.round((Date.now() - tm.startedRunAtMs) / 1000));
    }
    return base;
  }

  function toggleTimerPause() {
    if (!state.timer) return;
    const tm = state.timer;
    const nowMs = Date.now();
    if (tm.running) {
      const rem = Math.max(0, Math.ceil((tm.targetEndMs - nowMs) / 1000));
      tm.elapsedBeforeRunSec = getTimerElapsedSec(tm);
      tm.startedRunAtMs = null;
      tm.remainingSec = rem;
      tm.running = false;
      tm.targetEndMs = null;
    } else {
      if (tm.remainingSec <= 0) return;
      tm.startedRunAtMs = nowMs;
      tm.targetEndMs = nowMs + tm.remainingSec * 1000;
      tm.running = true;
    }
    saveState();
    render();
  }

  function addFiveMinutesToTimer() {
    if (!state.timer) return;
    state.timer.totalSec += 5 * 60;
    state.timer.remainingSec += 5 * 60;
    if (state.timer.running && state.timer.targetEndMs) {
      state.timer.targetEndMs += 5 * 60 * 1000;
    }
    saveState();
    render();
    showToast('+5 minutes ajoutées au chrono');
  }

  function continueFromStarterToFull() {
    if (!state.timer) return;
    const task = state.tasks.find((t) => t.id === state.timer.taskId);
    if (!task) return;
    const starterElapsed = Math.max(60, getTimerElapsedSec(state.timer) || 5 * 60);
    const remainingFromFullSec = Math.max(5 * 60, (task.durationMin - 5) * 60);
    const nowMs = Date.now();
    state.timer = {
      taskId: task.id,
      mode: 'full',
      totalSec: remainingFromFullSec,
      remainingSec: remainingFromFullSec,
      running: true,
      targetEndMs: nowMs + remainingFromFullSec * 1000,
      startedRunAtMs: nowMs,
      elapsedBeforeRunSec: starterElapsed
    };
    state.elanScore += 10;
    saveState();
    render();
    showToast('🚀 Super lancée ! Suite du bloc activée (+10 pts)');
  }

  function cancelTimer() {
    state.timer = null;
    saveState();
    render();
  }

  function completeTask(taskId, fromTimer = false) {
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task || task.completed) return;

    const { todayKey } = getTodayContext();
    let savedMin = 0;
    let actualMin = task.durationMin;

    if (fromTimer && state.timer && state.timer.taskId === taskId) {
      const elapsedSec = Math.max(60, getTimerElapsedSec(state.timer));
      actualMin = Math.max(1, Math.round(elapsedSec / 60));
      savedMin = Math.max(0, task.durationMin - actualMin);
      state.savedMinutes += savedMin;
      state.focusMinutesToday += actualMin;
      state.history.unshift({
        title: task.title,
        estimatedMin: task.durationMin,
        actualMin,
        savedMin,
        dateKey: todayKey
      });
      state.history = state.history.slice(0, 15);
      state.timer = null;
    } else if (state.timer && state.timer.taskId === taskId) {
      state.timer = null;
    }

    task.completed = true;
    task.completedAt = Date.now();
    task.actualMinutes = actualMin;

    const bonus = task.isVictory ? 25 : 15;
    state.elanScore += bonus + savedMin * 2;
    if (state.streakDays === 0) state.streakDays = 1;

    saveState();
    triggerBurst();
    render();

    if (savedMin > 0) {
      showToast(`🎉 Terminé ! +${savedMin} min gagnées dans ta banque !`);
    } else {
      showToast(`✅ "${task.title}" bouclé ! (+${bonus} pts d'Élan)`);
    }
  }

  function uncompleteTask(taskId) {
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task || !task.completed) return;
    task.completed = false;
    delete task.completedAt;
    saveState();
    render();
  }

  function deleteTask(taskId) {
    if (state.timer && state.timer.taskId === taskId) {
      state.timer = null;
    }
    state.tasks = state.tasks.filter((t) => t.id !== taskId);
    saveState();
    render();
    showToast('Objectif supprimé');
  }

  function toggleVictory(taskId) {
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) return;
    const currentActiveVictories = state.tasks.filter((t) => t.isVictory && !t.completed).length;
    if (!task.isVictory && currentActiveVictories >= 3) {
      showToast('Max 3 Victoires actives pour garder ton focus clair !');
      return;
    }
    task.isVictory = !task.isVictory;
    saveState();
    render();
  }

  function runRecalculateDay() {
    const { todayKey, nowMin } = getTodayContext();
    const res = C.recalculateSchedule({
      tasks: state.tasks,
      calendarEvents: state.events,
      todayKey,
      nowMin,
      settings: state.settings
    });
    state.tasks = res.tasks;
    saveState();
    render();
    if (res.movedCount > 0) {
      showToast(`↻ ${res.movedCount} bloc${res.movedCount > 1 ? 's' : ''} replacé${res.movedCount > 1 ? 's' : ''} dans tes prochains créneaux libres !`);
    } else {
      showToast('Ton planning est déjà à jour 👍');
    }
  }

  function autoPlaceTask(taskId) {
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) return;
    const { todayKey, nowMin } = getTodayContext();
    const slot = C.findBestSlot({
      durationMin: task.durationMin,
      horizon: 'week',
      todayKey,
      nowMin,
      calendarEvents: state.events,
      tasks: state.tasks,
      settings: state.settings,
      excludeTaskId: task.id
    });

    if (!slot) {
      showToast('Aucun créneau libre assez grand cette semaine. Essaie de découper la tâche !');
      return;
    }

    task.scheduledDateKey = slot.dateKey;
    task.scheduledStartMin = slot.startMin;
    task.horizon = slot.dateKey === todayKey ? 'today' : 'week';
    saveState();
    render();
    showToast(`✨ Placé ${C.formatFrenchDate(slot.dateKey, todayKey)} à ${C.formatTime(slot.startMin)}`);
  }

  function startBreakTimer(minutes) {
    if (state.savedMinutes < minutes) {
      showToast(`Il te faut ${minutes} min dans ta banque. Termine un bloc en avance pour en gagner !`);
      return;
    }
    state.savedMinutes -= minutes;
    const totalSec = minutes * 60;
    state.breakTimer = {
      totalSec,
      remainingSec: totalSec,
      running: true,
      targetEndMs: Date.now() + totalSec * 1000
    };
    saveState();
    render();
    showToast(`☕ Pause méritée de ${minutes} min lancée — profite sans culpabilité !`);
  }

  function stopBreakTimer() {
    state.breakTimer = null;
    saveState();
    render();
  }

  // =========================================================================
  // Live Timer Tick (updates digits without tearing down buttons)
  // =========================================================================

  function tickTimers() {
    let needsRender = false;
    const nowMs = Date.now();

    if (state.timer && state.timer.running && state.timer.targetEndMs) {
      const rem = Math.max(0, Math.ceil((state.timer.targetEndMs - nowMs) / 1000));
      state.timer.remainingSec = rem;

      const digitsEl = document.getElementById('timerDigits');
      const ringEl = document.getElementById('timerProgressRing');
      if (digitsEl) {
        digitsEl.textContent = formatMMSS(rem);
      }
      if (ringEl) {
        const ratio = state.timer.totalSec > 0 ? rem / state.timer.totalSec : 0;
        ringEl.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - ratio));
      }

      if (rem === 0) {
        if (state.timer.startedRunAtMs) {
          state.timer.elapsedBeforeRunSec =
            (state.timer.elapsedBeforeRunSec || 0) +
            Math.max(0, Math.round((state.timer.targetEndMs - state.timer.startedRunAtMs) / 1000));
        }
        state.timer.startedRunAtMs = null;
        state.timer.running = false;
        state.timer.targetEndMs = null;
        playGentleChime();
        saveState();
        needsRender = true;
      }
    }

    if (state.breakTimer && state.breakTimer.running && state.breakTimer.targetEndMs) {
      const rem = Math.max(0, Math.ceil((state.breakTimer.targetEndMs - nowMs) / 1000));
      state.breakTimer.remainingSec = rem;
      const breakDigitsEl = document.getElementById('breakBannerDigits');
      if (breakDigitsEl) {
        breakDigitsEl.textContent = formatMMSS(rem);
      }
      if (rem === 0) {
        state.breakTimer = null;
        playGentleChime();
        saveState();
        showToast('☕ Pause terminée ! Prêt pour le prochain élan ?');
        needsRender = true;
      }
    }

    if (needsRender) {
      render();
    }
  }

  // =========================================================================
  // Render Header, Banner & 4 Views
  // =========================================================================

  function updateHeader() {
    const { now, todayKey } = getTodayContext();
    dom.headerClock.textContent = `${C.formatCompactDate(todayKey)} · ${C.pad2(now.getHours())}:${C.pad2(now.getMinutes())}`;
    dom.headerBankText.textContent = `+${state.savedMinutes}m`;

    dom.navItems.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === state.activeTab);
    });

    const sourceLabel =
      state.calendarSource === 'ics'
        ? `Agenda .ics (${state.events.length} év.)`
        : state.calendarSource === 'demo'
        ? `Démo active (${state.events.length} év.)`
        : 'Aucun événement';
    dom.calendarSourceBadge.textContent = sourceLabel;
  }

  function renderContextBanner() {
    const { todayKey, nowMin } = getTodayContext();

    if (state.breakTimer && state.breakTimer.running) {
      dom.contextBanner.className = 'context-banner is-break';
      dom.contextBanner.innerHTML = `
        <span>☕ Pause méritée en cours : <strong id="breakBannerDigits">${formatMMSS(state.breakTimer.remainingSec)}</strong></span>
        <button type="button" class="banner-cta" data-action="stop-break">Terminer</button>
      `;
      return;
    }

    const overdue = getOverdueTasks(todayKey, nowMin);
    if (overdue.length > 0) {
      dom.contextBanner.className = 'context-banner is-overdue';
      dom.contextBanner.innerHTML = `
        <span>⏳ ${overdue.length} bloc${overdue.length > 1 ? 's' : ''} dépassé${overdue.length > 1 ? 's' : ''} — zéro culpabilité</span>
        <button type="button" class="banner-cta" data-action="recalculate">↻ Recalculer</button>
      `;
      return;
    }

    dom.contextBanner.className = 'context-banner hidden';
    dom.contextBanner.innerHTML = '';
  }

  function renderNowTab() {
    const { todayKey, nowMin } = getTodayContext();
    const minStart = C.roundUpToStep(nowMin, 5);
    const futureSlots = C.computeFreeSlots(todayKey, state.events, state.tasks, {
      dayStartMin: state.settings.dayStartMin,
      dayEndMin: state.settings.dayEndMin,
      minSlotMin: 10,
      clipBeforeMin: minStart
    });

    // Next raw calendar gap (ignoring tasks so user sees available time around calendar commitments)
    const rawFreeNow = C.computeFreeSlots(todayKey, state.events, [], {
      dayStartMin: state.settings.dayStartMin,
      dayEndMin: state.settings.dayEndMin,
      minSlotMin: 10,
      clipBeforeMin: minStart
    });

    const nextPocket = rawFreeNow[0];
    const pocketBannerHtml = nextPocket
      ? `<div class="free-pocket-pill">
           <span>🟢 Temps libre agenda</span>
           <span>${C.formatTime(nextPocket.startMin)} → ${C.formatTime(nextPocket.endMin)} (${C.formatDuration(nextPocket.durationMin)})</span>
         </div>`
      : `<div class="free-pocket-pill" style="background: var(--warm-soft); color: var(--warm-text);">
           <span>🌙 Fin de journée active</span>
           <span>Prépare demain en 1 tap</span>
         </div>`;

    const focusTask = getFocusCandidateTask(todayKey, nowMin);
    let heroHtml = '';

    if (!focusTask) {
      heroHtml = `
        <section class="card hero-card">
          ${pocketBannerHtml}
          <div class="empty-state">
            <p><strong>Aucun objectif pour le moment</strong><br />Ajoute une première tâche ou importe ton agenda.</p>
            <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px">
              <button type="button" class="btn btn-primary" data-action="open-add-soon">
                + Ajouter un objectif
              </button>
              ${
                state.calendarSource === 'empty'
                  ? `<button type="button" class="btn btn-secondary btn-sm" data-action="open-agenda-modal">
                       📅 Importer mon agenda (.ics)
                     </button>`
                  : ''
              }
            </div>
          </div>
        </section>
      `;
    } else {
      const tm = state.timer && state.timer.taskId === focusTask.id ? state.timer : null;
      const totalSec = tm ? tm.totalSec : focusTask.durationMin * 60;
      const remainingSec = tm ? tm.remainingSec : totalSec;
      const ratio = totalSec > 0 ? remainingSec / totalSec : 1;
      const dashOffset = RING_CIRCUMFERENCE * (1 - ratio);
      const isStarter = tm && tm.mode === 'starter';
      const isZero = tm && remainingSec === 0;

      let sublabel = `Prévu : ${C.formatDuration(focusTask.durationMin)}`;
      if (isStarter && !isZero) sublabel = 'Amorçage 5 min';
      if (isStarter && isZero) sublabel = '5 min réussies !';
      if (!isStarter && tm && tm.running) sublabel = 'Focus en cours';
      if (!isStarter && tm && !tm.running && !isZero) sublabel = 'Chrono en pause';
      if (!isStarter && isZero) sublabel = 'Temps écoulé !';

      const ringClass = isZero ? 'is-done' : isStarter ? 'is-starter' : '';

      let controlsHtml = '';
      if (!tm) {
        controlsHtml = `
          <div class="focus-actions-grid">
            <button type="button" class="btn btn-primary" data-action="start-full" data-task-id="${focusTask.id}">
              ▶ Lancer (${C.formatDuration(focusTask.durationMin)})
            </button>
            <button type="button" class="btn btn-warm" data-action="start-starter" data-task-id="${focusTask.id}">
              ⚡ Juste 5 min
            </button>
          </div>
        `;
      } else if (isStarter && isZero) {
        controlsHtml = `
          <div class="focus-actions-grid">
            <button type="button" class="btn btn-primary span-2" data-action="continue-starter">
              🚀 Je suis lancé ! Continuer le bloc
            </button>
            <button type="button" class="btn btn-mint span-2" data-action="finish-timer" data-task-id="${focusTask.id}">
              ✓ C'est déjà fini !
            </button>
          </div>
        `;
      } else {
        controlsHtml = `
          <div class="focus-actions-grid">
            <button type="button" class="btn btn-secondary" data-action="toggle-pause">
              ${tm.running ? '⏸ Pause' : '▶ Reprendre'}
            </button>
            <button type="button" class="btn btn-mint" data-action="finish-timer" data-task-id="${focusTask.id}">
              ✓ J'ai fini !
            </button>
            <button type="button" class="btn btn-ghost btn-sm" data-action="add-5min">
              +5 min
            </button>
            <button type="button" class="btn btn-ghost btn-sm" data-action="cancel-timer">
              ✕ Arrêter
            </button>
          </div>
        `;
      }

      const scheduleBadge = focusTask.scheduledDateKey
        ? `<span class="badge badge-accent">🕒 ${C.formatFrenchDate(focusTask.scheduledDateKey, todayKey)} · ${C.formatTime(focusTask.scheduledStartMin)}</span>`
        : `<span class="badge badge-accent">À placer</span>`;

      heroHtml = `
        <section class="card hero-card">
          ${pocketBannerHtml}

          <div class="focus-header-row">
            <div>
              <p class="focus-kicker">${tm ? '🔥 En cours maintenant' : '🎯 Prochaine action recommandée'}</p>
              <h2 class="focus-task-title">${escapeHtml(focusTask.title)}</h2>
            </div>
          </div>

          <div class="focus-meta-row">
            ${scheduleBadge}
            ${focusTask.isVictory ? '<span class="badge badge-gold">⭐ Victoire du jour</span>' : ''}
          </div>

          <div class="timer-stage">
            <div class="timer-ring-wrap">
              <svg class="timer-svg" viewBox="0 0 172 172" aria-hidden="true">
                <circle class="timer-track" cx="86" cy="86" r="74"></circle>
                <circle
                  id="timerProgressRing"
                  class="timer-progress ${ringClass}"
                  cx="86"
                  cy="86"
                  r="74"
                  stroke-dasharray="${RING_CIRCUMFERENCE.toFixed(2)}"
                  stroke-dashoffset="${dashOffset.toFixed(2)}"
                ></circle>
              </svg>
              <div class="timer-center">
                <div class="timer-digits" id="timerDigits">${formatMMSS(remainingSec)}</div>
                <div class="timer-sublabel" id="timerSublabel">${sublabel}</div>
              </div>
            </div>
          </div>

          ${controlsHtml}

          <div class="anti-friction-row">
            <button type="button" class="btn btn-ghost btn-sm" data-action="open-breakdown" data-task-id="${focusTask.id}">
              🪜 Découper en 3 pas
            </button>
            <button type="button" class="btn btn-ghost btn-sm" data-action="open-slot-picker" data-task-id="${focusTask.id}">
              🕒 Déplacer
            </button>
          </div>
        </section>
      `;
    }

    // Build 4-hour Radar
    const horizonLimit = Math.min(state.settings.dayEndMin + 60, nowMin + 240);
    const radarItems = [];

    for (const ev of state.events) {
      if (ev.dateKey !== todayKey || ev.allDay) continue;
      if (ev.endMin <= nowMin - 10 || ev.startMin > horizonLimit) continue;
      radarItems.push({
        type: 'event',
        startMin: ev.startMin,
        endMin: ev.endMin,
        title: ev.title
      });
    }

    for (const t of state.tasks) {
      if (t.completed || t.scheduledDateKey !== todayKey || t.scheduledStartMin == null) continue;
      const endMin = t.scheduledStartMin + t.durationMin;
      if (endMin <= nowMin - 5 || t.scheduledStartMin > horizonLimit) continue;
      radarItems.push({
        type: 'task',
        startMin: t.scheduledStartMin,
        endMin,
        task: t
      });
    }

    for (const slot of futureSlots) {
      if (slot.startMin > horizonLimit) continue;
      radarItems.push({
        type: 'free',
        startMin: slot.startMin,
        endMin: slot.endMin,
        durationMin: slot.durationMin
      });
    }

    radarItems.sort((a, b) => a.startMin - b.startMin);

    const radarHtml = radarItems.length
      ? radarItems
          .map((item) => {
            if (item.type === 'event') {
              return `
                <div class="radar-item is-calendar">
                  <div class="radar-time">${C.formatTime(item.startMin)}</div>
                  <div class="radar-body">
                    <p class="radar-title">📅 ${escapeHtml(item.title)}</p>
                    <p class="radar-meta">Agenda · ${C.formatTime(item.startMin)} – ${C.formatTime(item.endMin)}</p>
                  </div>
                </div>
              `;
            }
            if (item.type === 'free') {
              return `
                <button
                  type="button"
                  class="radar-item is-free"
                  data-action="add-at-slot"
                  data-date="${todayKey}"
                  data-start="${item.startMin}"
                  data-max="${item.durationMin}"
                >
                  <div class="radar-time">${C.formatTime(item.startMin)}</div>
                  <div class="radar-body" style="text-align:left">
                    <p class="radar-title">+ Poche libre (${C.formatDuration(item.durationMin)})</p>
                    <p class="radar-meta">Appuie pour caser un objectif ici</p>
                  </div>
                </button>
              `;
            }
            const t = item.task;
            return `
              <div class="radar-item">
                <div class="radar-time">${C.formatTime(item.startMin)}</div>
                <div class="radar-body">
                  <p class="radar-title">${t.isVictory ? '⭐ ' : ''}${escapeHtml(t.title)}</p>
                  <p class="radar-meta">Objectif · ${C.formatDuration(t.durationMin)}</p>
                </div>
                <button type="button" class="mini-action-btn" data-action="start-full" data-task-id="${t.id}" title="Lancer">▶</button>
              </div>
            `;
          })
          .join('')
      : `<div class="empty-state">Aucun bloc dans les 4 prochaines heures. Utilise <strong>+</strong> pour planifier !</div>`;

    return `
      ${heroHtml}
      <div class="section-header">
        <h2 class="section-title">⚡ Radar des 4 prochaines heures</h2>
        <button type="button" class="btn btn-secondary btn-sm" data-action="open-add-soon">+ Ajouter</button>
      </div>
      <div class="radar-list">${radarHtml}</div>
    `;
  }

  function renderDayTab() {
    const { todayKey, nowMin } = getTodayContext();

    // 3 Victories
    const victories = state.tasks
      .filter((t) => t.isVictory && (!t.completed || (t.completedAt && C.toDateKey(new Date(t.completedAt)) === todayKey)))
      .slice(0, 3);

    const victoryRows = [];
    for (let i = 0; i < 3; i++) {
      const v = victories[i];
      if (v) {
        victoryRows.push(`
          <div class="victory-row ${v.completed ? 'is-completed' : ''}">
            <button
              type="button"
              class="touch-check-btn"
              data-action="toggle-complete"
              data-task-id="${v.id}"
              aria-label="${v.completed ? 'Marquer non terminé' : 'Terminer'}"
            >
              <span class="check-circle ${v.completed ? 'checked' : ''}">${v.completed ? '✓' : ''}</span>
            </button>
            <div class="timeline-main">
              <p class="victory-title">${escapeHtml(v.title)}</p>
              <p class="radar-meta">
                ${C.formatDuration(v.durationMin)}
                ${v.scheduledDateKey ? ` · ${C.formatFrenchDate(v.scheduledDateKey, todayKey)} ${C.formatTime(v.scheduledStartMin)}` : ' · Non placé'}
              </p>
            </div>
            ${
              !v.completed
                ? `<button type="button" class="mini-action-btn" data-action="focus-task" data-task-id="${v.id}" title="Lancer">▶</button>`
                : ''
            }
          </div>
        `);
      } else {
        victoryRows.push(`
          <button type="button" class="victory-row is-empty" data-action="open-add-victory">
            <span class="check-circle" style="border-style:dashed">+</span>
            <span style="font-size:13px;font-weight:700;color:var(--text-muted)">
              Choisir la Victoire #${i + 1} du jour
            </span>
          </button>
        `);
      }
    }

    // Day stats & timeline
    const todayTasks = state.tasks.filter((t) => t.scheduledDateKey === todayKey);
    const doneCount = todayTasks.filter((t) => t.completed).length;
    const totalCount = todayTasks.length;
    const pct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;
    const plannedMin = todayTasks.reduce((acc, t) => acc + t.durationMin, 0);

    // Combine events, scheduled tasks, and upcoming free pockets
    const items = [];
    const allDayEvents = state.events.filter((ev) => ev.dateKey === todayKey && ev.allDay);

    for (const ev of state.events) {
      if (ev.dateKey !== todayKey || ev.allDay) continue;
      items.push({ type: 'event', startMin: ev.startMin, endMin: ev.endMin, ev });
    }

    for (const t of todayTasks) {
      items.push({
        type: 'task',
        startMin: t.scheduledStartMin,
        endMin: t.scheduledStartMin + t.durationMin,
        task: t
      });
    }

    const freeSlots = C.computeFreeSlots(todayKey, state.events, state.tasks, {
      dayStartMin: state.settings.dayStartMin,
      dayEndMin: state.settings.dayEndMin,
      minSlotMin: 15,
      clipBeforeMin: C.roundUpToStep(nowMin, 5)
    });

    for (const slot of freeSlots) {
      items.push({ type: 'free', startMin: slot.startMin, endMin: slot.endMin, slot });
    }

    items.sort((a, b) => a.startMin - b.startMin);

    const allDayHtml = allDayEvents.length
      ? `<div class="badge badge-accent" style="align-self:flex-start">📌 Journée : ${allDayEvents.map((e) => escapeHtml(e.title)).join(' · ')}</div>`
      : '';

    const timelineHtml = items.length
      ? items
          .map((item) => {
            if (item.type === 'event') {
              return `
                <div class="timeline-card is-event">
                  <div class="timeline-time-col">
                    <span>${C.formatTime(item.startMin)}</span>
                    <span style="opacity:0.65">${C.formatTime(item.endMin)}</span>
                  </div>
                  <div class="timeline-main">
                    <p class="timeline-title">📅 ${escapeHtml(item.ev.title)}</p>
                    <p class="timeline-sub">Agenda synchronisé · ${C.formatDuration(item.endMin - item.startMin)}</p>
                  </div>
                </div>
              `;
            }

            if (item.type === 'free') {
              return `
                <button
                  type="button"
                  class="timeline-card is-free-slot"
                  data-action="add-at-slot"
                  data-date="${todayKey}"
                  data-start="${item.startMin}"
                  data-max="${item.slot.durationMin}"
                >
                  <div class="timeline-time-col">
                    <span>${C.formatTime(item.startMin)}</span>
                    <span style="opacity:0.65">${C.formatTime(item.endMin)}</span>
                  </div>
                  <div class="timeline-main" style="text-align:left">
                    <p class="timeline-title" style="color:var(--mint-text)">+ Créneau libre · ${C.formatDuration(item.slot.durationMin)}</p>
                    <p class="timeline-sub">Appuie pour prévoir un objectif ici</p>
                  </div>
                </button>
              `;
            }

            const t = item.task;
            const isOverdue = !t.completed && item.endMin <= nowMin;
            const gcalUrl = C.buildGoogleCalendarUrl(t, todayKey);
            return `
              <div class="timeline-card ${t.completed ? 'is-done' : ''} ${isOverdue ? 'is-overdue' : ''}">
                <button
                  type="button"
                  class="touch-check-btn"
                  data-action="toggle-complete"
                  data-task-id="${t.id}"
                  aria-label="Basculer terminé"
                >
                  <span class="check-circle ${t.completed ? 'checked' : ''}">${t.completed ? '✓' : ''}</span>
                </button>
                <div class="timeline-time-col">
                  <span>${C.formatTime(item.startMin)}</span>
                  <span style="opacity:0.65">${C.formatTime(item.endMin)}</span>
                </div>
                <div class="timeline-main">
                  <p class="timeline-title">${escapeHtml(t.title)}</p>
                  <p class="timeline-sub">
                    <span>${C.formatDuration(t.durationMin)}</span>
                    ${t.isVictory ? '<span class="badge badge-gold">⭐ Victoire</span>' : ''}
                    ${isOverdue ? '<span class="badge badge-warm">À replacer</span>' : ''}
                  </p>
                </div>
                <div class="timeline-actions">
                  ${
                    !t.completed
                      ? `<button type="button" class="mini-action-btn" data-action="focus-task" data-task-id="${t.id}" title="Lancer le focus">▶</button>
                         <a class="mini-action-btn" href="${gcalUrl}" target="_blank" rel="noopener noreferrer" title="Envoyer vers Google Agenda">📅</a>`
                      : ''
                  }
                  <button type="button" class="mini-action-btn" data-action="delete-task" data-task-id="${t.id}" title="Supprimer">🗑️</button>
                </div>
              </div>
            `;
          })
          .join('')
      : `<div class="empty-state">Ta journée est vide. Ajoute un objectif avec <strong>+</strong> !</div>`;

    return `
      <section class="card victories-card">
        <div class="section-header">
          <h2 class="section-title">⭐ Mes 3 Victoires du jour</h2>
          <span class="section-subtitle">${victories.filter((v) => v.completed).length}/3</span>
        </div>
        <div class="victories-slots">${victoryRows.join('')}</div>
      </section>

      <div class="progress-strip">
        <div class="section-header">
          <span class="section-title">Timeline d'aujourd'hui</span>
          <button type="button" class="btn btn-secondary btn-sm" data-action="recalculate">↻ Recalculer</button>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="width:${pct}%"></div>
        </div>
        <span class="section-subtitle">${doneCount}/${totalCount} blocs bouclés · ${C.formatDuration(plannedMin)} prévues</span>
      </div>

      ${allDayHtml}
      <div class="timeline-list">${timelineHtml}</div>
    `;
  }

  function renderWeekTab() {
    const { todayKey, nowMin } = getTodayContext();
    const weekDays = C.getWeekDays(todayKey, todayKey);
    const activeDayKey = state.selectedWeekDateKey || todayKey;

    // Weekly free capacity & planned work from today through Sunday
    let totalFreeRemainingMin = 0;
    let totalPlannedWeekMin = 0;

    for (const d of weekDays) {
      if (d.dateKey < todayKey) continue;
      const clip = d.dateKey === todayKey ? C.roundUpToStep(nowMin, 5) : null;
      const rawSlots = C.computeFreeSlots(d.dateKey, state.events, [], {
        dayStartMin: state.settings.dayStartMin,
        dayEndMin: state.settings.dayEndMin,
        minSlotMin: 10,
        clipBeforeMin: clip
      });
      totalFreeRemainingMin += rawSlots.reduce((sum, s) => sum + s.durationMin, 0);
    }

    const weekIncomplete = state.tasks.filter((t) => !t.completed);
    totalPlannedWeekMin = weekIncomplete.reduce((sum, t) => sum + t.durationMin, 0);

    const loadRatio = totalFreeRemainingMin > 0 ? Math.min(100, Math.round((totalPlannedWeekMin / totalFreeRemainingMin) * 100)) : 100;
    const isOverloaded = totalPlannedWeekMin > totalFreeRemainingMin;
    const marginMin = totalFreeRemainingMin - totalPlannedWeekMin;

    const stripHtml = weekDays
      .map((d) => {
        const dayTasks = state.tasks.filter((t) => !t.completed && t.scheduledDateKey === d.dateKey);
        const dayEvents = state.events.filter((ev) => ev.dateKey === d.dateKey && !ev.allDay);
        const busyMin =
          dayTasks.reduce((s, t) => s + t.durationMin, 0) +
          dayEvents.reduce((s, e) => s + (e.endMin - e.startMin), 0);
        const dotClass = busyMin > 420 ? 'is-full' : busyMin > 210 ? 'is-busy' : '';
        return `
          <button
            type="button"
            class="day-pill ${d.dateKey === activeDayKey ? 'is-selected' : ''} ${d.isToday ? 'is-today' : ''}"
            data-action="select-week-day"
            data-date="${d.dateKey}"
          >
            <span class="day-pill-name">${d.shortLabel}</span>
            <span class="day-pill-num">${d.dayNum}</span>
            <span class="day-load-dot ${dotClass}"></span>
          </button>
        `;
      })
      .join('');

    // Selected Day details
    const selectedDayEvents = state.events
      .filter((e) => e.dateKey === activeDayKey && !e.allDay)
      .sort((a, b) => a.startMin - b.startMin);
    const selectedDayTasks = state.tasks
      .filter((t) => t.scheduledDateKey === activeDayKey)
      .sort((a, b) => (a.scheduledStartMin || 0) - (b.scheduledStartMin || 0));

    const selectedDayRows = [];
    selectedDayEvents.forEach((ev) => {
      selectedDayRows.push(`
        <div class="radar-item is-calendar">
          <div class="radar-time">${C.formatTime(ev.startMin)}</div>
          <div class="radar-body">
            <p class="radar-title">📅 ${escapeHtml(ev.title)}</p>
            <p class="radar-meta">${C.formatTime(ev.startMin)} – ${C.formatTime(ev.endMin)}</p>
          </div>
        </div>
      `);
    });
    selectedDayTasks.forEach((t) => {
      selectedDayRows.push(`
        <div class="radar-item" style="${t.completed ? 'opacity:0.6' : ''}">
          <div class="radar-time">${C.formatTime(t.scheduledStartMin)}</div>
          <div class="radar-body">
            <p class="radar-title">${t.completed ? '✓ ' : ''}${escapeHtml(t.title)}</p>
            <p class="radar-meta">${C.formatDuration(t.durationMin)}</p>
          </div>
          ${!t.completed ? `<button type="button" class="mini-action-btn" data-action="focus-task" data-task-id="${t.id}">▶</button>` : ''}
        </div>
      `);
    });

    // Unscheduled backlog (goals for the week)
    const backlogTasks = state.tasks.filter((t) => !t.completed && !t.scheduledDateKey);
    const backlogHtml = backlogTasks.length
      ? backlogTasks
          .map(
            (t) => `
          <div class="backlog-card">
            <div class="backlog-top">
              <div>
                <p class="timeline-title">${escapeHtml(t.title)}</p>
                <p class="radar-meta">Durée : ${C.formatDuration(t.durationMin)} ${t.postponeCount ? `· Reporté ${t.postponeCount}×` : ''}</p>
              </div>
              <button type="button" class="mini-action-btn" data-action="delete-task" data-task-id="${t.id}" title="Supprimer">🗑️</button>
            </div>
            <div class="backlog-actions">
              <button type="button" class="btn btn-primary btn-sm" data-action="auto-place" data-task-id="${t.id}">
                ✨ Placer auto
              </button>
              <button type="button" class="btn btn-secondary btn-sm" data-action="open-slot-picker" data-task-id="${t.id}">
                📅 Choisir créneau
              </button>
              <button type="button" class="btn btn-ghost btn-sm" data-action="open-breakdown" data-task-id="${t.id}">
                🪜 Découper
              </button>
            </div>
          </div>
        `
          )
          .join('')
      : `<div class="empty-state">Tous tes objectifs de la semaine sont calés dans ton agenda 🎉</div>`;

    return `
      <section class="card">
        <div class="section-header" style="margin-bottom:8px">
          <h2 class="section-title">⚖️ Budget Temps de la semaine</h2>
          <span class="badge ${isOverloaded ? 'badge-warm' : 'badge-mint'}">
            ${isOverloaded ? `Surcharge +${C.formatDuration(Math.abs(marginMin))}` : `Marge +${C.formatDuration(marginMin)}`}
          </span>
        </div>
        <div class="budget-card-numbers">
          <span class="budget-big">${C.formatDuration(totalPlannedWeekMin)}</span>
          <span class="section-subtitle">prévues sur ${C.formatDuration(totalFreeRemainingMin)} libres</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="width:${loadRatio}%;${isOverloaded ? 'background:var(--warm)' : ''}"></div>
        </div>
      </section>

      <div class="week-strip">${stripHtml}</div>

      <section class="card">
        <div class="section-header" style="margin-bottom:10px">
          <h3 class="section-title">${C.formatFrenchDate(activeDayKey, todayKey)}</h3>
          <button type="button" class="btn btn-secondary btn-sm" data-action="add-for-day" data-date="${activeDayKey}">
            + Prévoir ce jour
          </button>
        </div>
        <div class="radar-list">
          ${selectedDayRows.length ? selectedDayRows.join('') : '<div class="empty-state" style="padding:10px">Journée libre — ajoute ou place un objectif !</div>'}
        </div>
      </section>

      <div class="section-header">
        <h2 class="section-title">🗓️ Objectifs semaine à placer (${backlogTasks.length})</h2>
      </div>
      ${backlogHtml}
    `;
  }

  function renderElanTab() {
    const { todayKey } = getTodayContext();
    const completedCount = state.tasks.filter((t) => t.completed).length;
    const shieldActiveToday = state.restShieldUsedDate === todayKey;

    const recentHistory = state.history.slice(0, 5);
    let calibInsight = 'Termine un bloc avec le chrono pour calibrer tes estimations réelles.';
    if (recentHistory.length >= 2) {
      const totalEst = recentHistory.reduce((s, h) => s + h.estimatedMin, 0);
      const totalAct = recentHistory.reduce((s, h) => s + h.actualMin, 0);
      const diffPct = Math.round(((totalAct - totalEst) / Math.max(1, totalEst)) * 100);
      if (diffPct <= -10) {
        calibInsight = `Tu vas en moyenne ${Math.abs(diffPct)}% plus vite que tes estimations !`;
      } else if (diffPct >= 10) {
        calibInsight = `Tu prends ~${diffPct}% de temps en plus que prévu : ajoute une petite marge pour rester serein.`;
      } else {
        calibInsight = 'Tes estimations collent très bien à ton temps réel 🎯';
      }
    }

    const calibRowsHtml = recentHistory.length
      ? recentHistory
          .map((h) => {
            const maxVal = Math.max(h.estimatedMin, h.actualMin, 1);
            const actPct = Math.round((Math.min(h.actualMin, h.estimatedMin) / maxVal) * 100);
            const overPct = h.actualMin > h.estimatedMin ? Math.round(((h.actualMin - h.estimatedMin) / maxVal) * 100) : 0;
            return `
              <div class="calib-row">
                <div class="section-header">
                  <span style="font-size:13px;font-weight:700">${escapeHtml(h.title)}</span>
                  <span style="font-size:12px;font-weight:700;color:${h.savedMin > 0 ? 'var(--mint-text)' : 'var(--text-muted)'}">
                    ${h.actualMin}m / ${h.estimatedMin}m ${h.savedMin > 0 ? `(+${h.savedMin}m)` : ''}
                  </span>
                </div>
                <div class="calib-bars">
                  <div class="calib-bar-track">
                    <div class="calib-bar-actual" style="width:${actPct}%"></div>
                    ${overPct > 0 ? `<div class="calib-bar-over" style="width:${overPct}%"></div>` : ''}
                  </div>
                </div>
              </div>
            `;
          })
          .join('')
      : '<p class="settings-desc">Aucune session chronométrée encore enregistrée.</p>';

    return `
      <section class="card bank-hero">
        <p class="bank-kicker">💎 Banque de temps gagné</p>
        <div class="bank-big-value">+${state.savedMinutes} min</div>
        <p class="bank-sub">
          Chaque minute économisée en finissant un bloc en avance devient du temps de pause 100% mérité et sans culpabilité.
        </p>
        <div class="bank-btn-row">
          <button type="button" class="btn bank-pause-btn btn-sm" data-action="take-break" data-min="10">
            ☕ Pause 10 min
          </button>
          <button type="button" class="btn bank-pause-btn btn-sm" data-action="take-break" data-min="20">
            🎮 Pause 20 min
          </button>
        </div>
      </section>

      <div class="stats-grid">
        <div class="stat-box">
          <div class="stat-label">⚡ Score d'Élan</div>
          <div class="stat-value">${state.elanScore}</div>
          <div class="stat-label">Récompense chaque départ</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">🔥 Régularité</div>
          <div class="stat-value">${state.streakDays} j</div>
          <div class="stat-label">${shieldActiveToday ? '🛡️ Bouclier actif' : 'Série bienveillante'}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">🎯 Focus aujourd'hui</div>
          <div class="stat-value">${C.formatDuration(state.focusMinutesToday)}</div>
          <div class="stat-label">Temps protégé</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">✅ Blocs bouclés</div>
          <div class="stat-value">${completedCount}</div>
          <div class="stat-label">Total accompli</div>
        </div>
      </div>

      <section class="card">
        <div class="section-header" style="margin-bottom:6px">
          <h2 class="section-title">🛡️ Journée chargée ou imprévue ?</h2>
        </div>
        <p class="settings-desc" style="margin-bottom:10px">
          Le Bouclier Repos préserve ta série sans pression si tu as besoin de lever le pied aujourd'hui.
        </p>
        <button
          type="button"
          class="btn ${shieldActiveToday ? 'btn-mint' : 'btn-secondary'} btn-sm btn-block"
          data-action="use-shield"
          ${shieldActiveToday ? 'disabled' : ''}
        >
          ${shieldActiveToday ? '🛡️ Bouclier actif pour aujourd’hui' : 'Activer mon Bouclier Repos aujourd’hui'}
        </button>
      </section>

      <section class="card">
        <h2 class="section-title" style="margin-bottom:6px">📊 Calibrage Temps réel vs estimé</h2>
        <p class="settings-desc" style="margin-bottom:10px">${calibInsight}</p>
        ${calibRowsHtml}
      </section>
    `;
  }

  function render() {
    applyTheme();
    updateHeader();
    renderContextBanner();

    if (state.activeTab === 'now') {
      dom.mainContent.innerHTML = renderNowTab();
    } else if (state.activeTab === 'day') {
      dom.mainContent.innerHTML = renderDayTab();
    } else if (state.activeTab === 'week') {
      dom.mainContent.innerHTML = renderWeekTab();
    } else {
      dom.mainContent.innerHTML = renderElanTab();
    }
  }

  // =========================================================================
  // Bottom Sheets Management
  // =========================================================================

  function closeAllSheets() {
    dom.sheetBackdrop.classList.add('hidden');
    [dom.quickAddSheet, dom.breakdownSheet, dom.slotPickerSheet, dom.agendaSheet].forEach((s) =>
      s.classList.add('hidden')
    );
  }

  function openSheet(sheetEl) {
    closeAllSheets();
    dom.sheetBackdrop.classList.remove('hidden');
    sheetEl.classList.remove('hidden');
  }

  function syncQuickAddChips() {
    document.querySelectorAll('#durationChips .chip').forEach((c) => {
      c.classList.toggle('active', Number(c.dataset.duration) === quickAddDraft.durationMin);
    });
    document.querySelectorAll('#horizonChips .chip').forEach((c) => {
      c.classList.toggle('active', c.dataset.horizon === quickAddDraft.horizon);
    });

    if (quickAddDraft.pinnedSlot) {
      const { todayKey } = getTodayContext();
      const ps = quickAddDraft.pinnedSlot;
      dom.pinnedSlotBanner.classList.remove('hidden');
      dom.pinnedSlotBanner.innerHTML = `
        <span>📌 Créneau : ${C.formatFrenchDate(ps.dateKey, todayKey)} à ${C.formatTime(ps.startMin)}</span>
        <button type="button" class="sheet-close" style="width:26px;height:26px;font-size:12px" data-action="clear-pinned-slot">✕</button>
      `;
      dom.horizonSection.classList.add('hidden');
      dom.quickAddSubmitBtn.textContent = `Placer à ${C.formatTime(ps.startMin)}`;
    } else {
      dom.pinnedSlotBanner.classList.add('hidden');
      dom.horizonSection.classList.remove('hidden');
      dom.quickAddSubmitBtn.textContent =
        quickAddDraft.horizon === 'week'
          ? 'Ajouter aux objectifs semaine'
          : 'Placer dans mon agenda';
    }
  }

  function openQuickAdd(options = {}) {
    quickAddDraft = {
      durationMin: options.durationMin || 25,
      horizon: options.horizon || 'soon',
      pinnedSlot: options.pinnedSlot || null
    };
    dom.quickTaskInput.value = '';
    dom.victoryCheckbox.checked = Boolean(options.isVictory);
    dom.nlpHint.innerHTML = 'Astuce : écris une durée (ex. <code>25m</code>, <code>1h15</code>) ou <code>demain</code>.';
    syncQuickAddChips();
    openSheet(dom.quickAddSheet);
    setTimeout(() => dom.quickTaskInput.focus(), 80);
  }

  function openBreakdown(taskId) {
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) return;
    breakdownTaskId = taskId;
    dom.breakdownTargetName.textContent = `"${task.title}"`;
    const steps = C.suggestMicroSteps(task.title, task.durationMin);

    dom.microStepsList.innerHTML = steps
      .map(
        (step, idx) => `
      <div class="micro-step-row">
        <input
          type="text"
          class="text-input step-title-input"
          value="${escapeHtml(step.title)}"
          aria-label="Étape ${idx + 1}"
          required
        />
        <select class="select-input step-dur-select" aria-label="Durée étape ${idx + 1}">
          ${[5, 10, 15, 20, 30]
            .map((m) => `<option value="${m}" ${m === step.durationMin ? 'selected' : ''}>${m}m</option>`)
            .join('')}
        </select>
      </div>
    `
      )
      .join('');

    openSheet(dom.breakdownSheet);
  }

  function openSlotPicker(taskId) {
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) return;
    slotPickerTaskId = taskId;
    dom.slotPickerTaskLabel.textContent = `${task.title} (${C.formatDuration(task.durationMin)})`;

    const { todayKey, nowMin } = getTodayContext();
    const minToday = C.roundUpToStep(nowMin + 2, 5);
    const options = [];

    for (let offset = 0; offset < 7; offset++) {
      const dk = C.addDays(todayKey, offset);
      const slots = C.computeFreeSlots(dk, state.events, state.tasks, {
        dayStartMin: state.settings.dayStartMin,
        dayEndMin: state.settings.dayEndMin,
        minSlotMin: task.durationMin,
        clipBeforeMin: offset === 0 ? minToday : null,
        excludeTaskId: task.id
      });
      for (const s of slots.slice(0, 3)) {
        options.push(s);
      }
      if (options.length >= 10) break;
    }

    if (!options.length) {
      dom.slotPickerList.innerHTML = `
        <div class="empty-state">
          Aucun créneau libre de ${C.formatDuration(task.durationMin)} trouvé cette semaine.<br />
          Astuce : découpe la tâche en micro-étapes de 10 min !
        </div>
      `;
    } else {
      dom.slotPickerList.innerHTML = options
        .map(
          (s) => `
        <button
          type="button"
          class="slot-option-btn"
          data-action="assign-slot"
          data-date="${s.dateKey}"
          data-start="${s.startMin}"
        >
          <div>
            <strong>${C.formatFrenchDate(s.dateKey, todayKey)} · ${C.formatTime(s.startMin)}</strong>
            <div style="font-size:12px;color:var(--text-muted)">
              Dispo jusqu'à ${C.formatTime(s.endMin)} (${C.formatDuration(s.durationMin)} libres)
            </div>
          </div>
          <span class="badge badge-mint">Choisir</span>
        </button>
      `
        )
        .join('');
    }

    openSheet(dom.slotPickerSheet);
  }

  function populateHoursSelects() {
    const makeOptions = (selectedMin, startH, endH) => {
      const out = [];
      for (let m = startH * 60; m <= endH * 60; m += 30) {
        out.push(`<option value="${m}" ${m === selectedMin ? 'selected' : ''}>${C.formatTime(m)}</option>`);
      }
      return out.join('');
    };
    dom.dayStartSelect.innerHTML = makeOptions(state.settings.dayStartMin, 6, 12);
    dom.dayEndSelect.innerHTML = makeOptions(state.settings.dayEndMin, 17, 23);
  }

  // =========================================================================
  // Event Listeners
  // =========================================================================

  dom.toggleFrameBtn.addEventListener('click', () => {
    const isFull = dom.desktopStage.classList.toggle('fullscreen-mode');
    dom.toggleFrameBtn.textContent = isFull ? 'Aperçu téléphone' : 'Plein écran';
  });

  dom.toggleThemeBtn.addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    saveState();
    applyTheme();
  });

  dom.headerBankBtn.addEventListener('click', () => {
    state.activeTab = 'elan';
    saveState();
    render();
  });

  dom.openAgendaBtn.addEventListener('click', () => {
    populateHoursSelects();
    openSheet(dom.agendaSheet);
  });

  dom.navItems.forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeTab = btn.dataset.tab;
      saveState();
      render();
      dom.mainContent.scrollTop = 0;
    });
  });

  dom.openQuickAddBtn.addEventListener('click', () => {
    const defaultHorizon = state.activeTab === 'week' ? 'week' : state.activeTab === 'day' ? 'today' : 'soon';
    openQuickAdd({ horizon: defaultHorizon });
  });

  dom.sheetBackdrop.addEventListener('click', closeAllSheets);
  document.querySelectorAll('[data-close-sheet]').forEach((btn) => {
    btn.addEventListener('click', closeAllSheets);
  });

  // Quick Add NLP live detection
  dom.quickTaskInput.addEventListener('input', () => {
    const parsed = C.parseQuickInput(dom.quickTaskInput.value);
    const hints = [];
    if (parsed.durationMin) {
      quickAddDraft.durationMin = parsed.durationMin;
      hints.push(`⏱️ ${C.formatDuration(parsed.durationMin)}`);
    }
    if (parsed.horizon && !quickAddDraft.pinnedSlot) {
      quickAddDraft.horizon = parsed.horizon;
      const hMap = { soon: 'Prochaines heures', today: "Aujourd'hui", tomorrow: 'Demain', week: 'Cette semaine' };
      hints.push(`📅 ${hMap[parsed.horizon]}`);
    }
    if (hints.length) {
      dom.nlpHint.textContent = `Détecté : ${hints.join(' · ')}`;
      syncQuickAddChips();
    } else {
      dom.nlpHint.innerHTML = 'Astuce : écris une durée (ex. <code>25m</code>, <code>1h15</code>) ou <code>demain</code>.';
    }
  });

  document.getElementById('durationChips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-duration]');
    if (!chip) return;
    quickAddDraft.durationMin = Number(chip.dataset.duration);
    syncQuickAddChips();
  });

  document.getElementById('horizonChips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-horizon]');
    if (!chip) return;
    quickAddDraft.horizon = chip.dataset.horizon;
    syncQuickAddChips();
  });

  document.getElementById('ideaChips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-idea]');
    if (!chip) return;
    dom.quickTaskInput.value = chip.dataset.idea;
    dom.quickTaskInput.dispatchEvent(new Event('input'));
  });

  dom.pinnedSlotBanner.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="clear-pinned-slot"]')) {
      quickAddDraft.pinnedSlot = null;
      syncQuickAddChips();
    }
  });

  dom.quickAddForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = dom.quickTaskInput.value.trim();
    if (!raw) return;

    const parsed = C.parseQuickInput(raw);
    const title = parsed.title || raw;
    const durationMin = quickAddDraft.durationMin || parsed.durationMin || 25;
    const isVictory = dom.victoryCheckbox.checked;
    const { todayKey, nowMin } = getTodayContext();

    let scheduledDateKey = null;
    let scheduledStartMin = null;
    let finalHorizon = quickAddDraft.horizon;

    if (quickAddDraft.pinnedSlot) {
      const ps = quickAddDraft.pinnedSlot;
      const dur = ps.maxDurationMin && durationMin > ps.maxDurationMin ? ps.maxDurationMin : durationMin;
      scheduledDateKey = ps.dateKey;
      scheduledStartMin = ps.startMin;
      finalHorizon = ps.dateKey === todayKey ? 'today' : 'week';

      state.tasks.push({
        id: uid('task'),
        title,
        durationMin: dur,
        horizon: finalHorizon,
        isVictory,
        completed: false,
        scheduledDateKey,
        scheduledStartMin,
        postponeCount: 0,
        createdAt: Date.now()
      });

      saveState();
      closeAllSheets();
      render();
      showToast(`✅ Placé ${C.formatFrenchDate(scheduledDateKey, todayKey)} à ${C.formatTime(scheduledStartMin)}`);
      return;
    }

    if (finalHorizon !== 'week') {
      const slot = C.findBestSlot({
        durationMin,
        horizon: finalHorizon,
        todayKey,
        nowMin,
        calendarEvents: state.events,
        tasks: state.tasks,
        settings: state.settings,
        preferredDateKey: quickAddDraft.preferredDateKey || null
      });
      if (slot) {
        scheduledDateKey = slot.dateKey;
        scheduledStartMin = slot.startMin;
      }
    }

    state.tasks.push({
      id: uid('task'),
      title,
      durationMin,
      horizon: finalHorizon,
      isVictory,
      completed: false,
      scheduledDateKey,
      scheduledStartMin,
      postponeCount: 0,
      createdAt: Date.now()
    });

    saveState();
    closeAllSheets();
    render();

    if (scheduledDateKey) {
      showToast(`📅 Placé ${C.formatFrenchDate(scheduledDateKey, todayKey)} à ${C.formatTime(scheduledStartMin)}`);
    } else if (finalHorizon === 'week') {
      showToast('🗓️ Ajouté aux objectifs de la semaine !');
    } else {
      showToast('⏳ Aucun trou libre assez grand — ajouté en attente cette semaine.');
    }
  });

  // Breakdown form submit
  dom.breakdownForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const original = state.tasks.find((t) => t.id === breakdownTaskId);
    if (!original) {
      closeAllSheets();
      return;
    }

    const titleInputs = Array.from(dom.microStepsList.querySelectorAll('.step-title-input'));
    const durSelects = Array.from(dom.microStepsList.querySelectorAll('.step-dur-select'));
    const { todayKey, nowMin } = getTodayContext();

    const newTasks = [];
    titleInputs.forEach((inp, idx) => {
      const stepTitle = inp.value.trim();
      if (!stepTitle) return;
      const dur = Number(durSelects[idx]?.value || 10);
      const slot = C.findBestSlot({
        durationMin: dur,
        horizon: 'soon',
        todayKey,
        nowMin,
        calendarEvents: state.events,
        tasks: state.tasks.filter((t) => t.id !== original.id).concat(newTasks),
        settings: state.settings
      });

      newTasks.push({
        id: uid('step'),
        title: stepTitle,
        durationMin: dur,
        horizon: slot ? 'today' : 'week',
        isVictory: idx === 0 ? original.isVictory : false,
        completed: false,
        scheduledDateKey: slot ? slot.dateKey : null,
        scheduledStartMin: slot ? slot.startMin : null,
        postponeCount: 0,
        createdAt: Date.now()
      });
    });

    if (!newTasks.length) return;

    if (state.timer && state.timer.taskId === original.id) {
      state.timer = null;
    }
    state.tasks = state.tasks.filter((t) => t.id !== original.id).concat(newTasks);
    state.elanScore += 10;
    state.activeTab = 'now';

    saveState();
    closeAllSheets();
    startTaskTimer(newTasks[0].id, 'starter');
  });

  // Slot picker click
  dom.slotPickerList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="assign-slot"]');
    if (!btn) return;
    const task = state.tasks.find((t) => t.id === slotPickerTaskId);
    if (!task) return;

    const { todayKey } = getTodayContext();
    task.scheduledDateKey = btn.dataset.date;
    task.scheduledStartMin = Number(btn.dataset.start);
    task.horizon = task.scheduledDateKey === todayKey ? 'today' : 'week';

    saveState();
    closeAllSheets();
    render();
    showToast(`📅 Déplacé ${C.formatFrenchDate(task.scheduledDateKey, todayKey)} à ${C.formatTime(task.scheduledStartMin)}`);
  });

  // Delegated actions inside mainContent & contextBanner
  function handleDelegatedClick(e) {
    const el = e.target.closest('[data-action]');
    if (!el) return;

    const action = el.dataset.action;
    const taskId = el.dataset.taskId;

    if (action === 'recalculate') return runRecalculateDay();
    if (action === 'stop-break') return stopBreakTimer();
    if (action === 'start-full') return startTaskTimer(taskId, 'full');
    if (action === 'start-starter') return startTaskTimer(taskId, 'starter');
    if (action === 'toggle-pause') return toggleTimerPause();
    if (action === 'add-5min') return addFiveMinutesToTimer();
    if (action === 'continue-starter') return continueFromStarterToFull();
    if (action === 'cancel-timer') return cancelTimer();
    if (action === 'finish-timer') return completeTask(taskId, true);

    if (action === 'focus-task') {
      state.activeTab = 'now';
      startTaskTimer(taskId, 'full');
      return;
    }

    if (action === 'toggle-complete') {
      const task = state.tasks.find((t) => t.id === taskId);
      if (!task) return;
      return task.completed ? uncompleteTask(taskId) : completeTask(taskId, false);
    }

    if (action === 'delete-task') return deleteTask(taskId);
    if (action === 'auto-place') return autoPlaceTask(taskId);
    if (action === 'open-breakdown') return openBreakdown(taskId);
    if (action === 'open-slot-picker') return openSlotPicker(taskId);

    if (action === 'open-add-soon') {
      return openQuickAdd({ horizon: 'soon' });
    }
    if (action === 'open-agenda-modal') {
      populateHoursSelects();
      openSheet(dom.agendaSheet);
      return;
    }
    if (action === 'open-add-victory') {
      return openQuickAdd({ horizon: 'today', isVictory: true });
    }
    if (action === 'add-at-slot') {
      const dateKey = el.dataset.date;
      const startMin = Number(el.dataset.start);
      const maxDur = Number(el.dataset.max);
      const suggestedDur = maxDur >= 25 ? 25 : maxDur >= 15 ? 15 : 10;
      return openQuickAdd({
        durationMin: suggestedDur,
        pinnedSlot: { dateKey, startMin, maxDurationMin: maxDur }
      });
    }
    if (action === 'select-week-day') {
      state.selectedWeekDateKey = el.dataset.date;
      saveState();
      render();
      return;
    }
    if (action === 'add-for-day') {
      const dk = el.dataset.date;
      const { todayKey, nowMin } = getTodayContext();
      const clip = dk === todayKey ? C.roundUpToStep(nowMin + 2, 5) : null;
      const slots = C.computeFreeSlots(dk, state.events, state.tasks, {
        dayStartMin: state.settings.dayStartMin,
        dayEndMin: state.settings.dayEndMin,
        minSlotMin: 15,
        clipBeforeMin: clip
      });
      if (slots.length) {
        return openQuickAdd({
          durationMin: Math.min(25, slots[0].durationMin),
          pinnedSlot: { dateKey: dk, startMin: slots[0].startMin, maxDurationMin: slots[0].durationMin }
        });
      }
      return openQuickAdd({ horizon: 'week' });
    }
    if (action === 'take-break') {
      return startBreakTimer(Number(el.dataset.min || 10));
    }
    if (action === 'use-shield') {
      const { todayKey } = getTodayContext();
      state.restShieldUsedDate = todayKey;
      if (state.streakDays === 0) state.streakDays = 1;
      saveState();
      render();
      showToast('🛡️ Série protégée pour aujourd’hui — repose-toi sereinement.');
    }
  }

  dom.mainContent.addEventListener('click', handleDelegatedClick);
  dom.contextBanner.addEventListener('click', handleDelegatedClick);

  // =========================================================================
  // Agenda Import (.ics), Export & Settings
  // =========================================================================

  dom.icsFileInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      const parsed = C.parseICS(text, new Date());
      state.events = parsed;
      state.calendarSource = 'ics';
      saveState();
      closeAllSheets();
      render();
      showToast(`📅 ${parsed.length} événement${parsed.length > 1 ? 's' : ''} importé${parsed.length > 1 ? 's' : ''} depuis ${file.name} !`);
      dom.icsFileInput.value = '';
    };
    reader.readAsText(file);
  });

  dom.exportIcsBtn.addEventListener('click', () => {
    const icsContent = C.exportTasksToICS(state.tasks);
    const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `elan-blocs-${C.toDateKey(new Date())}.ics`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('📤 Fichier .ics téléchargé !');
  });

  dom.dayStartSelect.addEventListener('change', () => {
    const val = Number(dom.dayStartSelect.value);
    if (val < state.settings.dayEndMin) {
      state.settings.dayStartMin = val;
      saveState();
      render();
    }
  });

  dom.dayEndSelect.addEventListener('change', () => {
    const val = Number(dom.dayEndSelect.value);
    if (val > state.settings.dayStartMin) {
      state.settings.dayEndMin = val;
      saveState();
      render();
    }
  });

  dom.resetDemoBtn.addEventListener('click', () => {
    const keepTheme = state.theme;
    state = createDefaultState(false);
    state.theme = keepTheme;
    saveState();
    closeAllSheets();
    render();
    showToast('🔄 Démo réinitialisée à l’heure actuelle !');
  });

  dom.clearAllBtn.addEventListener('click', () => {
    const keepTheme = state.theme;
    state = createDefaultState(true);
    state.theme = keepTheme;
    saveState();
    closeAllSheets();
    render();
    showToast('🗑️ Données vidées — prêt pour ton propre agenda !');
  });

  // =========================================================================
  // Init & Background Tick
  // =========================================================================

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      tickTimers();
      updateHeader();
    }
  });

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  render();
  setInterval(tickTimers, 250);
  setInterval(updateHeader, 30000);
})();
