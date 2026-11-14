(function (global) {
  'use strict';

  const DAY_SHORT = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
  const DAY_LONG = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
  const MONTH_SHORT = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function toDateKey(date) {
    const d = date instanceof Date ? date : new Date(date);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function fromDateKey(dateKey) {
    const [y, m, d] = dateKey.split('-').map(Number);
    return new Date(y, m - 1, d, 0, 0, 0, 0);
  }

  function addDays(dateKey, days) {
    const d = fromDateKey(dateKey);
    d.setDate(d.getDate() + days);
    return toDateKey(d);
  }

  function getNowMinutes(date = new Date()) {
    return date.getHours() * 60 + date.getMinutes();
  }

  function roundUpToStep(min, step = 5) {
    return Math.ceil(min / step) * step;
  }

  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  function formatTime(minutes) {
    const safe = clamp(Math.round(minutes), 0, 24 * 60);
    const h = Math.floor(safe / 60);
    const m = safe % 60;
    return `${pad2(h)}h${pad2(m)}`;
  }

  function formatDuration(minutes) {
    const m = Math.max(0, Math.round(minutes));
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem === 0 ? `${h}h` : `${h}h${pad2(rem)}`;
  }

  function formatFrenchDate(dateKey, todayKey) {
    if (todayKey) {
      if (dateKey === todayKey) return "Aujourd'hui";
      if (dateKey === addDays(todayKey, 1)) return 'Demain';
      if (dateKey === addDays(todayKey, -1)) return 'Hier';
    }
    const d = fromDateKey(dateKey);
    return `${DAY_LONG[d.getDay()]} ${d.getDate()} ${MONTH_SHORT[d.getMonth()]}`;
  }

  function formatCompactDate(dateKey) {
    const d = fromDateKey(dateKey);
    return `${DAY_SHORT[d.getDay()]} ${d.getDate()} ${MONTH_SHORT[d.getMonth()]}`;
  }

  function getWeekDays(anchorDateKey, todayKey) {
    const d = fromDateKey(anchorDateKey);
    const day = d.getDay(); // 0=Sun..6=Sat
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const mondayKey = addDays(anchorDateKey, mondayOffset);
    const days = [];
    for (let i = 0; i < 7; i++) {
      const dk = addDays(mondayKey, i);
      const obj = fromDateKey(dk);
      days.push({
        dateKey: dk,
        shortLabel: DAY_SHORT[obj.getDay()],
        longLabel: DAY_LONG[obj.getDay()],
        dayNum: obj.getDate(),
        isToday: dk === todayKey,
        isPast: todayKey ? dk < todayKey : false
      });
    }
    return days;
  }

  /**
   * Parses natural quick input in French, e.g.:
   * "Relire rapport 30m", "Sport 1h15 demain", "Budget semaine 45 min"
   */
  function parseQuickInput(rawText) {
    let text = (rawText || '').trim();
    if (!text) {
      return { title: '', durationMin: null, horizon: null };
    }

    let durationMin = null;
    let horizon = null;

    // Detect "1h30", "1h 30", "2h"
    const hourComboRegex = /\b(\d{1,2})\s*h(?:\s*(\d{1,2}))?(?:\s*min|mn|m)?\b/i;
    const hourMatch = text.match(hourComboRegex);
    if (hourMatch) {
      const h = parseInt(hourMatch[1], 10);
      const m = hourMatch[2] ? parseInt(hourMatch[2], 10) : 0;
      const total = h * 60 + m;
      if (total >= 5 && total <= 360) {
        durationMin = total;
        text = text.replace(hourMatch[0], ' ').trim();
      }
    }

    // Detect "30 min", "45m", "20mn"
    if (durationMin === null) {
      const minRegex = /\b(\d{1,3})\s*(?:minutes?|mins?|mn|m)\b/i;
      const minMatch = text.match(minRegex);
      if (minMatch) {
        const m = parseInt(minMatch[1], 10);
        if (m >= 5 && m <= 360) {
          durationMin = m;
          text = text.replace(minMatch[0], ' ').trim();
        }
      }
    }

    // Detect horizon hints
    const checks = [
      { regex: /\b(?:cette\s+semaine|semaine)\b/i, value: 'week' },
      { regex: /\bdemain\b/i, value: 'tomorrow' },
      { regex: /\b(?:aujourd'hui|ce\s+soir)\b/i, value: 'today' },
      { regex: /\b(?:maintenant|tout\s+de\s+suite|prochaines?\s+heures?)\b/i, value: 'soon' }
    ];

    for (const c of checks) {
      const match = text.match(c.regex);
      if (match) {
        horizon = c.value;
        text = text.replace(match[0], ' ').trim();
        break;
      }
    }

    // Clean orphan prepositions at ends
    text = text
      .replace(/\s+/g, ' ')
      .replace(/\s+(?:pendant|pour|en|de|à)$/i, '')
      .trim();

    return {
      title: text || rawText.trim(),
      durationMin,
      horizon
    };
  }

  function mergeBusyIntervals(intervals) {
    if (!intervals.length) return [];
    const sorted = intervals
      .filter((iv) => iv.endMin > iv.startMin)
      .slice()
      .sort((a, b) => a.startMin - b.startMin);

    if (!sorted.length) return [];
    const merged = [{ startMin: sorted[0].startMin, endMin: sorted[0].endMin }];
    for (let i = 1; i < sorted.length; i++) {
      const curr = sorted[i];
      const last = merged[merged.length - 1];
      if (curr.startMin <= last.endMin) {
        last.endMin = Math.max(last.endMin, curr.endMin);
      } else {
        merged.push({ startMin: curr.startMin, endMin: curr.endMin });
      }
    }
    return merged;
  }

  function computeFreeSlots(dateKey, calendarEvents, tasks, options = {}) {
    const dayStartMin = options.dayStartMin ?? 8 * 60;
    const dayEndMin = options.dayEndMin ?? 21 * 60 + 30;
    const minSlotMin = options.minSlotMin ?? 10;
    const clipBeforeMin = options.clipBeforeMin ?? null;
    const excludeTaskId = options.excludeTaskId ?? null;

    const windowStart = clipBeforeMin !== null
      ? Math.max(dayStartMin, clipBeforeMin)
      : dayStartMin;

    if (windowStart >= dayEndMin) return [];

    const busy = [];

    for (const ev of calendarEvents) {
      if (ev.dateKey !== dateKey || ev.allDay) continue;
      busy.push({
        startMin: clamp(ev.startMin, windowStart, dayEndMin),
        endMin: clamp(ev.endMin, windowStart, dayEndMin)
      });
    }

    for (const t of tasks) {
      if (t.id === excludeTaskId) continue;
      if (t.completed || !t.scheduledDateKey || t.scheduledStartMin == null) continue;
      if (t.scheduledDateKey !== dateKey) continue;
      const endMin = t.scheduledStartMin + t.durationMin;
      busy.push({
        startMin: clamp(t.scheduledStartMin, windowStart, dayEndMin),
        endMin: clamp(endMin, windowStart, dayEndMin)
      });
    }

    const merged = mergeBusyIntervals(busy);
    const freeSlots = [];
    let cursor = windowStart;

    for (const block of merged) {
      if (block.startMin > cursor) {
        const dur = block.startMin - cursor;
        if (dur >= minSlotMin) {
          freeSlots.push({
            dateKey,
            startMin: cursor,
            endMin: block.startMin,
            durationMin: dur
          });
        }
      }
      cursor = Math.max(cursor, block.endMin);
    }

    if (dayEndMin > cursor) {
      const dur = dayEndMin - cursor;
      if (dur >= minSlotMin) {
        freeSlots.push({
          dateKey,
          startMin: cursor,
          endMin: dayEndMin,
          durationMin: dur
        });
      }
    }

    return freeSlots;
  }

  function findBestSlot({
    durationMin,
    horizon = 'today',
    todayKey,
    nowMin,
    calendarEvents,
    tasks,
    settings = {},
    excludeTaskId = null,
    preferredDateKey = null
  }) {
    const dayStartMin = settings.dayStartMin ?? 8 * 60;
    const dayEndMin = settings.dayEndMin ?? 21 * 60 + 30;
    const minStartToday = roundUpToStep(nowMin + 2, 5);

    const searchDates = [];
    if (horizon === 'tomorrow') {
      searchDates.push(addDays(todayKey, 1));
    } else if (horizon === 'soon' || horizon === 'today') {
      searchDates.push(todayKey);
      if (horizon === 'today') {
        // Fallback to tomorrow if today is full
        searchDates.push(addDays(todayKey, 1));
      }
    } else if (horizon === 'date' && preferredDateKey) {
      searchDates.push(preferredDateKey);
    } else {
      // 'week': scan from today across next 7 days (prioritizing current week)
      for (let i = 0; i < 7; i++) {
        searchDates.push(addDays(todayKey, i));
      }
    }

    for (const dk of searchDates) {
      if (dk < todayKey) continue;
      const clipBeforeMin = dk === todayKey ? minStartToday : null;
      const slots = computeFreeSlots(dk, calendarEvents, tasks, {
        dayStartMin,
        dayEndMin,
        minSlotMin: durationMin,
        clipBeforeMin,
        excludeTaskId
      });

      if (!slots.length) continue;

      if (horizon === 'soon') {
        const soonLimit = minStartToday + 240;
        const nearSlot = slots.find((s) => s.startMin <= soonLimit && s.durationMin >= durationMin);
        if (nearSlot) {
          return {
            dateKey: dk,
            startMin: nearSlot.startMin,
            endMin: nearSlot.startMin + durationMin
          };
        }
      }

      // Prefer a snug slot where task fits cleanly without fragmenting huge blocks when avoidable
      const snug = slots.find((s) => s.durationMin >= durationMin && s.durationMin <= durationMin + 25);
      const chosen = snug || slots[0];
      return {
        dateKey: dk,
        startMin: chosen.startMin,
        endMin: chosen.startMin + durationMin
      };
    }

    return null;
  }

  function recalculateSchedule({ tasks, calendarEvents, todayKey, nowMin, settings = {} }) {
    const dayStartMin = settings.dayStartMin ?? 8 * 60;
    const dayEndMin = settings.dayEndMin ?? 21 * 60 + 30;
    const workingTasks = tasks.map((t) => ({ ...t }));

    const overdue = workingTasks.filter((t) => {
      if (t.completed || !t.scheduledDateKey || t.scheduledStartMin == null) return false;
      if (t.scheduledDateKey < todayKey) return true;
      if (t.scheduledDateKey === todayKey && t.scheduledStartMin + t.durationMin <= nowMin) {
        return true;
      }
      return false;
    });

    // Clear overdue schedules first so they don't block each other during placement
    const overdueIds = new Set(overdue.map((t) => t.id));
    for (const t of workingTasks) {
      if (overdueIds.has(t.id)) {
        t.scheduledDateKey = null;
        t.scheduledStartMin = null;
      }
    }

    // Sort by victory priority first, then shorter tasks first to build momentum
    overdue.sort((a, b) => {
      if (Boolean(a.isVictory) !== Boolean(b.isVictory)) return a.isVictory ? -1 : 1;
      return a.durationMin - b.durationMin;
    });

    let movedCount = 0;
    for (const item of overdue) {
      const target = workingTasks.find((t) => t.id === item.id);
      if (!target) continue;

      const slot = findBestSlot({
        durationMin: target.durationMin,
        horizon: 'week',
        todayKey,
        nowMin,
        calendarEvents,
        tasks: workingTasks,
        settings: { dayStartMin, dayEndMin },
        excludeTaskId: target.id
      });

      if (slot) {
        target.scheduledDateKey = slot.dateKey;
        target.scheduledStartMin = slot.startMin;
        target.horizon = slot.dateKey === todayKey ? 'today' : 'week';
        target.postponeCount = (target.postponeCount || 0) + 1;
        movedCount++;
      } else {
        target.horizon = 'week';
      }
    }

    return {
      tasks: workingTasks,
      movedCount
    };
  }

  function suggestMicroSteps(taskTitle, totalDurationMin = 30) {
    const lower = (taskTitle || '').toLowerCase();
    const d1 = Math.max(5, Math.min(10, Math.round(totalDurationMin * 0.25)));
    const d2 = Math.max(10, Math.min(20, Math.round(totalDurationMin * 0.45)));
    const d3 = Math.max(5, Math.min(15, totalDurationMin - d1 - d2)) || 10;

    if (/(présentation|slide|diapo|powerpoint|pitch)/.test(lower)) {
      return [
        { title: `Lister le plan en 5 points (${taskTitle})`, durationMin: d1 },
        { title: `Créer le squelette des diapos clés`, durationMin: d2 },
        { title: `Relire et soigner les visuels`, durationMin: d3 }
      ];
    }
    if (/(rapport|devis|document|rédig|écrire|article|dossier|mémoire)/.test(lower)) {
      return [
        { title: `Ouvrir le doc et noter 3 idées brutes`, durationMin: d1 },
        { title: `Rédiger le brouillon principal sans corriger`, durationMin: d2 },
        { title: `Relire, structurer et finaliser`, durationMin: d3 }
      ];
    }
    if (/(révis|cours|exam|partiel|étud|chapitre|apprendre)/.test(lower)) {
      return [
        { title: `Survoler les titres et objectifs du chapitre`, durationMin: d1 },
        { title: `Fiche mémo ou 2 exercices ciblés`, durationMin: d2 },
        { title: `Auto-test rapide sans regarder ses notes`, durationMin: d3 }
      ];
    }
    if (/(mail|email|message|appel|téléphon|admin|facture|impôt|rdv)/.test(lower)) {
      return [
        { title: `Rassembler les infos/pièces nécessaires`, durationMin: 5 },
        { title: `Rédiger ou passer l'appel en allant à l'essentiel`, durationMin: Math.max(10, d2) },
        { title: `Classer et noter le suivi`, durationMin: 5 }
      ];
    }
    if (/(code|bug|appli|dev|script|feature|projet)/.test(lower)) {
      return [
        { title: `Reproduire ou poser la structure minimale`, durationMin: d1 },
        { title: `Implémenter le cœur qui fonctionne`, durationMin: d2 },
        { title: `Tester et nettoyer`, durationMin: d3 }
      ];
    }

    return [
      { title: `Préparer l'espace & faire le premier 5 min : ${taskTitle}`, durationMin: d1 },
      { title: `Avancer sur le gros du travail (sans perfectionnisme)`, durationMin: d2 },
      { title: `Boucler et valider : ${taskTitle}`, durationMin: d3 }
    ];
  }

  // =========================================================================
  // iCalendar (.ics) Parser & Exporter + Google Calendar quick-link
  // =========================================================================

  function parseICSDateValue(rawVal, propParams = '') {
    if (!rawVal) return null;
    const val = rawVal.trim();
    const isAllDay = /VALUE=DATE\b/i.test(propParams) || /^\d{8}$/.test(val);

    if (isAllDay && /^\d{8}$/.test(val)) {
      const y = parseInt(val.slice(0, 4), 10);
      const m = parseInt(val.slice(4, 6), 10);
      const d = parseInt(val.slice(6, 8), 10);
      return {
        date: new Date(y, m - 1, d, 0, 0, 0, 0),
        allDay: true
      };
    }

    const match = val.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
    if (!match) return null;

    const y = parseInt(match[1], 10);
    const mo = parseInt(match[2], 10);
    const d = parseInt(match[3], 10);
    const h = parseInt(match[4], 10);
    const mi = parseInt(match[5], 10);
    const s = parseInt(match[6], 10);
    const isUTC = Boolean(match[7]);

    const dt = isUTC
      ? new Date(Date.UTC(y, mo - 1, d, h, mi, s))
      : new Date(y, mo - 1, d, h, mi, s);

    return { date: dt, allDay: false };
  }

  function unescapeICSText(str) {
    return (str || '')
      .replace(/\\n/gi, ' ')
      .replace(/\\,/g, ',')
      .replace(/\\;/g, ';')
      .replace(/\\\\/g, '\\')
      .trim();
  }

  function parseICS(icsText, anchorDate = new Date()) {
    const unfolded = (icsText || '').replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
    const lines = unfolded.split(/\r?\n/);

    const anchorKey = toDateKey(anchorDate);
    const windowStart = fromDateKey(addDays(anchorKey, -3));
    const windowEnd = fromDateKey(addDays(anchorKey, 14));
    windowEnd.setHours(23, 59, 59, 999);

    const parsedEvents = [];
    let current = null;

    for (const line of lines) {
      if (line === 'BEGIN:VEVENT') {
        current = {};
        continue;
      }
      if (line === 'END:VEVENT') {
        if (current && current.dtStart) {
          const startObj = current.dtStart;
          const endObj = current.dtEnd || {
            date: new Date(startObj.date.getTime() + 60 * 60 * 1000),
            allDay: startObj.allDay
          };
          const durMs = Math.max(15 * 60 * 1000, endObj.date.getTime() - startObj.date.getTime());

          const pushOccurrence = (occStartDate, idx = 0) => {
            if (occStartDate > windowEnd) return;
            const occEndDate = new Date(occStartDate.getTime() + durMs);
            if (occEndDate < windowStart) return;

            const dk = toDateKey(occStartDate);
            const startMin = startObj.allDay ? 0 : getNowMinutes(occStartDate);
            let endMin = startObj.allDay ? 24 * 60 : getNowMinutes(occEndDate);
            if (!startObj.allDay && toDateKey(occEndDate) !== dk) {
              endMin = 24 * 60;
            }
            if (!startObj.allDay && endMin <= startMin) {
              endMin = Math.min(24 * 60, startMin + 30);
            }

            parsedEvents.push({
              id: `ics-${current.uid || parsedEvents.length}-${idx}-${dk}`,
              title: current.summary || 'Événement agenda',
              dateKey: dk,
              startMin,
              endMin,
              allDay: startObj.allDay,
              source: 'ics',
              location: current.location || ''
            });
          };

          if (current.rrule && /FREQ=WEEKLY/i.test(current.rrule)) {
            let untilDate = windowEnd;
            const untilMatch = current.rrule.match(/UNTIL=(\d{8}(?:T\d{6}Z?)?)/i);
            if (untilMatch) {
              const u = parseICSDateValue(untilMatch[1]);
              if (u && u.date < untilDate) untilDate = u.date;
            }
            let maxCount = 60;
            const countMatch = current.rrule.match(/COUNT=(\d+)/i);
            if (countMatch) {
              maxCount = Math.min(60, parseInt(countMatch[1], 10));
            }
            const intervalMatch = current.rrule.match(/INTERVAL=(\d+)/i);
            const weekStep = intervalMatch ? Math.max(1, parseInt(intervalMatch[1], 10)) : 1;

            let cursor = new Date(startObj.date.getTime());
            let count = 0;
            while (cursor <= untilDate && cursor <= windowEnd && count < maxCount) {
              if (cursor >= windowStart) {
                pushOccurrence(cursor, count);
              }
              cursor = new Date(cursor.getTime());
              cursor.setDate(cursor.getDate() + 7 * weekStep);
              count++;
            }
          } else {
            pushOccurrence(startObj.date, 0);
          }
        }
        current = null;
        continue;
      }

      if (!current) continue;
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;

      const rawKey = line.slice(0, colonIdx);
      const rawVal = line.slice(colonIdx + 1);
      const semiIdx = rawKey.indexOf(';');
      const propName = (semiIdx === -1 ? rawKey : rawKey.slice(0, semiIdx)).toUpperCase();
      const propParams = semiIdx === -1 ? '' : rawKey.slice(semiIdx + 1);

      if (propName === 'SUMMARY') current.summary = unescapeICSText(rawVal);
      else if (propName === 'LOCATION') current.location = unescapeICSText(rawVal);
      else if (propName === 'UID') current.uid = rawVal.trim();
      else if (propName === 'RRULE') current.rrule = rawVal.trim();
      else if (propName === 'DTSTART') current.dtStart = parseICSDateValue(rawVal, propParams);
      else if (propName === 'DTEND') current.dtEnd = parseICSDateValue(rawVal, propParams);
    }

    return parsedEvents.sort((a, b) => {
      if (a.dateKey !== b.dateKey) return a.dateKey.localeCompare(b.dateKey);
      return a.startMin - b.startMin;
    });
  }

  function toICSLocalTimestamp(dateKey, minutes) {
    const d = fromDateKey(dateKey);
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}T${pad2(h)}${pad2(m)}00`;
  }

  function exportTasksToICS(tasks) {
    const scheduled = tasks.filter((t) => !t.completed && t.scheduledDateKey && t.scheduledStartMin != null);
    const nowStamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Elan App//Agenda Anti-Procrastination//FR',
      'CALSCALE:GREGORIAN'
    ];

    for (const t of scheduled) {
      const startStr = toICSLocalTimestamp(t.scheduledDateKey, t.scheduledStartMin);
      const endStr = toICSLocalTimestamp(t.scheduledDateKey, t.scheduledStartMin + t.durationMin);
      lines.push(
        'BEGIN:VEVENT',
        `UID:elan-${t.id}@elan.local`,
        `DTSTAMP:${nowStamp}`,
        `DTSTART:${startStr}`,
        `DTEND:${endStr}`,
        `SUMMARY:⚡ ${t.title.replace(/[\r\n]/g, ' ')}`,
        `DESCRIPTION:Bloc Focus planifié dans Élan (${formatDuration(t.durationMin)})`,
        'END:VEVENT'
      );
    }

    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
  }

  function buildGoogleCalendarUrl(task, fallbackDateKey) {
    const dk = task.scheduledDateKey || fallbackDateKey;
    const startMin = task.scheduledStartMin != null ? task.scheduledStartMin : 9 * 60;
    const endMin = Math.min(23 * 60 + 55, startMin + task.durationMin);
    const startStr = toICSLocalTimestamp(dk, startMin);
    const endStr = toICSLocalTimestamp(dk, endMin);
    const params = new URLSearchParams({
      action: 'TEMPLATE',
      text: `⚡ ${task.title}`,
      dates: `${startStr}/${endStr}`,
      details: `Bloc d'action anti-procrastination créé avec Élan (${formatDuration(task.durationMin)}).`
    });
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
  }

  // =========================================================================
  // Realistic Dynamic Demo Generator (anchored to user's current local time)
  // =========================================================================

  function createDemoData(now = new Date(), settings = {}) {
    const todayKey = toDateKey(now);
    const tomorrowKey = addDays(todayKey, 1);
    const dayAfterKey = addDays(todayKey, 2);
    const day3Key = addDays(todayKey, 3);
    const nowMin = getNowMinutes(now);

    const events = [];
    const tasks = [];

    // Ensure there's an immediate free window right after now, plus an upcoming calendar event
    const pastStart = clamp(nowMin - 180, 8 * 60 + 30, 18 * 60);
    if (pastStart + 60 < nowMin) {
      events.push({
        id: 'demo-ev-1',
        title: 'Réunion / Point d’avancement',
        dateKey: todayKey,
        startMin: pastStart,
        endMin: pastStart + 60,
        allDay: false,
        source: 'demo'
      });
    }

    // Place a meeting roughly 90 minutes from now if it's still daytime/evening before 20:30
    const nextEventStart = roundUpToStep(nowMin + 90, 15);
    if (nextEventStart <= 20 * 60 + 30) {
      events.push({
        id: 'demo-ev-2',
        title: 'Visio / Créneau bloqué',
        dateKey: todayKey,
        startMin: nextEventStart,
        endMin: Math.min(22 * 60, nextEventStart + 45),
        allDay: false,
        source: 'demo'
      });
    }

    // Tomorrow & upcoming week events
    events.push(
      {
        id: 'demo-ev-3',
        title: 'Atelier / Cours du matin',
        dateKey: tomorrowKey,
        startMin: 9 * 60 + 30,
        endMin: 11 * 60 + 30,
        allDay: false,
        source: 'demo'
      },
      {
        id: 'demo-ev-4',
        title: 'Déjeuner d’équipe',
        dateKey: tomorrowKey,
        startMin: 12 * 60 + 30,
        endMin: 13 * 60 + 45,
        allDay: false,
        source: 'demo'
      },
      {
        id: 'demo-ev-5',
        title: 'Point hebdo & suivi',
        dateKey: dayAfterKey,
        startMin: 10 * 60,
        endMin: 11 * 60 + 30,
        allDay: false,
        source: 'demo'
      },
      {
        id: 'demo-ev-6',
        title: 'Rendez-vous extérieur',
        dateKey: dayAfterKey,
        startMin: 15 * 60,
        endMin: 16 * 60 + 30,
        allDay: false,
        source: 'demo'
      },
      {
        id: 'demo-ev-7',
        title: 'Session revue projet',
        dateKey: day3Key,
        startMin: 14 * 60,
        endMin: 15 * 60 + 30,
        allDay: false,
        source: 'demo'
      }
    );

    const dayEndMin = settings.dayEndMin ?? 21 * 60 + 30;
    const immediateStart = roundUpToStep(nowMin + 5, 5);
    const hasRoomNow = immediateStart + 35 <= Math.min(dayEndMin, nextEventStart > nowMin ? nextEventStart : dayEndMin);

    // 1. Immediate Victory task in next free pocket (or tomorrow morning if late at night)
    tasks.push({
      id: 'demo-t-1',
      title: 'Boucler la présentation clé',
      durationMin: 25,
      horizon: hasRoomNow ? 'soon' : 'tomorrow',
      isVictory: true,
      completed: false,
      scheduledDateKey: hasRoomNow ? todayKey : tomorrowKey,
      scheduledStartMin: hasRoomNow ? immediateStart : 8 * 60 + 30,
      postponeCount: 0,
      createdAt: Date.now()
    });

    // 2. Second Victory task later today or tomorrow
    const laterStart = nextEventStart <= 20 * 60 ? nextEventStart + 50 : null;
    const hasRoomLater = laterStart !== null && laterStart + 20 <= dayEndMin;
    tasks.push({
      id: 'demo-t-2',
      title: 'Trier et répondre aux 5 messages en attente',
      durationMin: 20,
      horizon: hasRoomLater ? 'today' : 'tomorrow',
      isVictory: true,
      completed: false,
      scheduledDateKey: hasRoomLater ? todayKey : tomorrowKey,
      scheduledStartMin: hasRoomLater ? laterStart : 14 * 60 + 15,
      postponeCount: 0,
      createdAt: Date.now()
    });

    // 3. One completed Victory task earlier today so user sees immediate progress
    const completedStart = clamp(nowMin - 110, 8 * 60, 19 * 60);
    if (completedStart + 25 <= nowMin) {
      tasks.push({
        id: 'demo-t-done',
        title: 'Définir le plan de la journée',
        durationMin: 20,
        actualMinutes: 14,
        horizon: 'today',
        isVictory: true,
        completed: true,
        completedAt: Date.now() - 45 * 60 * 1000,
        scheduledDateKey: todayKey,
        scheduledStartMin: completedStart,
        postponeCount: 0,
        createdAt: Date.now() - 3 * 3600 * 1000
      });
    }

    // 4. One overdue task earlier today so user can test "Recalculer ma journée"
    const overdueStart = clamp(nowMin - 75, 8 * 60, 20 * 60);
    if (overdueStart + 15 <= nowMin) {
      tasks.push({
        id: 'demo-t-overdue',
        title: 'Mettre à jour mes notes de suivi',
        durationMin: 15,
        horizon: 'today',
        isVictory: false,
        completed: false,
        scheduledDateKey: todayKey,
        scheduledStartMin: overdueStart,
        postponeCount: 1,
        createdAt: Date.now() - 2 * 3600 * 1000
      });
    }

    // 5. Weekly unscheduled goals ready for 1-tap "Placer auto"
    tasks.push(
      {
        id: 'demo-t-w1',
        title: 'Session de sport ou marche rapide',
        durationMin: 45,
        horizon: 'week',
        isVictory: false,
        completed: false,
        scheduledDateKey: null,
        scheduledStartMin: null,
        postponeCount: 0,
        createdAt: Date.now()
      },
      {
        id: 'demo-t-w2',
        title: 'Faire le point budget & factures',
        durationMin: 30,
        horizon: 'week',
        isVictory: false,
        completed: false,
        scheduledDateKey: null,
        scheduledStartMin: null,
        postponeCount: 2,
        createdAt: Date.now()
      }
    );

    const history = [
      { title: 'Plan du jour', estimatedMin: 20, actualMin: 14, savedMin: 6, dateKey: todayKey },
      { title: 'Synthèse PDF', estimatedMin: 30, actualMin: 22, savedMin: 8, dateKey: addDays(todayKey, -1) },
      { title: 'Relances clients', estimatedMin: 25, actualMin: 21, savedMin: 4, dateKey: addDays(todayKey, -1) }
    ];

    return {
      events,
      tasks,
      history,
      savedMinutes: 18,
      elanScore: 55,
      streakDays: 3,
      focusMinutesToday: 14
    };
  }

  global.ElanCalendar = {
    pad2,
    toDateKey,
    fromDateKey,
    addDays,
    getNowMinutes,
    roundUpToStep,
    clamp,
    formatTime,
    formatDuration,
    formatFrenchDate,
    formatCompactDate,
    getWeekDays,
    parseQuickInput,
    computeFreeSlots,
    findBestSlot,
    recalculateSchedule,
    suggestMicroSteps,
    parseICS,
    exportTasksToICS,
    buildGoogleCalendarUrl,
    createDemoData
  };
})(window);
