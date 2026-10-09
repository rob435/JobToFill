/*
 * JobToFill — field rules, interview availability: interview slots, read from the way forms write them, against the
 * days and hours you can do. One of the parts lib/fields.js puts together (loaded before it, in the order
 * background.js lists them).
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});
  const U = JTF.util;
  const P = (JTF.fieldParts = JTF.fieldParts || {});
  const { LONG_TEXT, MONTH_RE, val } = P;

  const WEEKDAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  // "Mon", "Tues", "Wednesday", "Thurs", "Saturdays".
  const WEEKDAY = '(sun|mon|tue|wed|thu|fri|sat)(?:s|r|rs)?(?:day|nesday|sday|urday)?s?';
  const SLOT_NONE =
    /\bnone\b|\bnot available\b|\bunavailable\b|\b(cannot|can ?t|can not|unable to) (make|attend|do)\b|\bdo(es)? ?n[o']?t (work|suit)\b|\bother (dates?|times?)\b|\balternative (dates?|times?|slots?)\b/;
  const SLOT_ANY =
    /\bany ?time\b|\bany (day|date|slot)s?\b|\bflexible\b|\ball (of the above|dates|times|slots)\b|\bwhenever\b|\bno preference\b|\bavailable (at )?all times\b/;
  const PARTS_OF_DAY = [
    [/\bmornings?\b/, [9 * 60, 12 * 60]],
    [/\blunch ?(time)?\b/, [12 * 60, 14 * 60]],
    [/\bafternoons?\b/, [12 * 60, 17 * 60]],
    [/\bevenings?\b/, [17 * 60, 20 * 60]],
    [/\b(all|full|whole) day\b/, [9 * 60, 17 * 60]],
  ];

  const dayNumber = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 864e5);
  const weekdayOf = (n) => (((n + 4) % 7) + 7) % 7; // 1 January 1970 was a Thursday
  const todayNumber = (today) => {
    const now = today || new Date();
    return dayNumber(now.getFullYear(), now.getMonth() + 1, now.getDate());
  };

  /** "08:00", "8am", "20:00" -> minutes after midnight; `fallback` when blank. */
  function clockMinutes(text, fallback) {
    const m = String(text || '')
      .toLowerCase()
      .match(/(\d{1,2})(?:[:.h](\d{2}))?\s*(am|pm)?/);
    if (!m) return fallback;
    const h = +m[1] % 24;
    return (m[3] ? (h % 12) + (m[3] === 'pm' ? 12 : 0) : h) * 60 + (+m[2] || 0);
  }

  /** "Mon, Tue, Wed", "Mon–Fri", "Weekdays", "Every day" -> [1, 2, 3] (0 is Sunday). */
  function dayList(text) {
    const t = String(text || '')
      .toLowerCase()
      .replace(/[–—]/g, '-');
    if (/\b(every ?day|any ?day|all (days|week)|daily|7 days)\b/.test(t)) return [0, 1, 2, 3, 4, 5, 6];
    const days = new Set();
    if (/\bweekdays?\b/.test(t)) [1, 2, 3, 4, 5].forEach((d) => days.add(d));
    if (/\bweekends?\b/.test(t)) [0, 6].forEach((d) => days.add(d));
    const rest = t.replace(new RegExp(`\\b${WEEKDAY} ?(?:-|to|until|through|thru) ?${WEEKDAY}\\b`, 'g'), (s, a, b) => {
      for (let d = WEEKDAY_NAMES.indexOf(a); ; d = (d + 1) % 7) {
        days.add(d);
        if (d === WEEKDAY_NAMES.indexOf(b)) break;
      }
      return ' ';
    });
    for (const m of rest.matchAll(new RegExp(`\\b${WEEKDAY}\\b`, 'g'))) days.add(WEEKDAY_NAMES.indexOf(m[1]));
    return [...days].sort();
  }

  /**
   * The year of a date given without one: the next time it comes round (from today); when the option names its
   * weekday ("Monday 13th October"), the nearest year in which it falls on that day.
   */
  function slotYear(m, d, weekday, today) {
    const now = new Date(today * 864e5).getUTCFullYear();
    if (weekday != null) {
      const fits = [now - 1, now, now + 1].filter((y) => weekdayOf(dayNumber(y, m, d)) === weekday);
      if (fits.length)
        return fits.sort((a, b) => Math.abs(dayNumber(a, m, d) - today) - Math.abs(dayNumber(b, m, d) - today))[0];
    }
    return dayNumber(now, m, d) >= today ? now : now + 1;
  }

  const to24 = (h, mer) => (mer ? (h % 12) + (mer[0] === 'p' ? 12 : 0) : h);

  /**
   * One interview slot as forms write them: "Monday 13th October – 10:00-11:00", "Tue 14/10 AM", "Wednesday 15
   * October 2026 (2pm - 4pm)", "w/c 20th October", "Morning (9am-12pm)", "Any time", "None of these dates work for
   * me". Returns { ranges: [[firstDay, lastDay]…] (day numbers), weekdays, time: [from, to] (minutes), any, none,
   * agrees (a named weekday matches the date) }; `order` reads "03/11" as 'dmy' or 'mdy'.
   */
  function parseSlot(raw, today, order) {
    let t =
      ' ' +
      String(raw || '')
        .toLowerCase()
        .replace(/[–—−]/g, '-')
        .replace(/(\d)(st|nd|rd|th)\b/g, '$1')
        .replace(/\b(noon|midday)\b/g, '12pm')
        .replace(/\bmidnight\b/g, '12am')
        .replace(/\s+/g, ' ') +
      ' ';
    if (SLOT_NONE.test(t)) return { none: true };
    const slot = { ranges: [], weekdays: null, time: null };
    const week = /\b(w ?\/ ?[cb]|wc|week (commencing|beginning|starting|of))\b/.test(t);
    // Weekdays: "Mon-Fri", "Tuesday", "weekdays".
    const named = [];
    t = t.replace(new RegExp(`\\b${WEEKDAY} ?(?:-|to|until|through|thru) ?${WEEKDAY}\\b(?! ?\\d)`, 'g'), (s, a, b) => {
      for (let d = WEEKDAY_NAMES.indexOf(a); ; d = (d + 1) % 7) {
        named.push(d);
        if (d === WEEKDAY_NAMES.indexOf(b)) break;
      }
      return ' ';
    });
    t = t
      .replace(new RegExp(`\\b${WEEKDAY}\\b`, 'g'), (s, d) => (named.push(WEEKDAY_NAMES.indexOf(d)), ' '))
      .replace(/\s+/g, ' ');
    if (/\bweekdays\b/.test(t)) named.push(1, 2, 3, 4, 5);
    if (/\bweekends?\b/.test(t)) named.push(0, 6);
    // Dates: "2026-10-14", "14/10(/2026)", "14.10.2026", "13 October (2026)", "13-17 Oct", "October 13(, 2026)".
    const dates = [];
    const add = (y, m, d) => {
      if (m >= 1 && m <= 12 && d >= 1 && d <= 31) dates.push({ y: y ? (+y < 100 ? 2000 + +y : +y) : null, m, d });
      return ' @ ';
    };
    const M = MONTH_RE;
    const month = (s) => U.MONTHS.findIndex((name) => name.startsWith(s.slice(0, 3))) + 1;
    t = t.replace(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g, (s, y, m, d) => add(y, +m, +d));
    t = t.replace(/\b(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})\b/g, (s, d, m, y) => add(y, +m, +d));
    t = t.replace(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b/g, (s, a, b, y) => {
      let [d, m] = order === 'mdy' ? [+b, +a] : [+a, +b];
      if (m > 12) [d, m] = [m, d];
      return add(y, m, d);
    });
    const END = '(?![:.]\\d|\\d| ?[ap]\\.?m\\b)';
    t = t.replace(
      new RegExp(`\\b(\\d{1,2})(?: ?- ?(\\d{1,2})${END})? (?:of )?(${M})\\b\\.?(?:,? (20\\d{2}))?`, 'g'),
      (s, d1, d2, mon, y) =>
        d2 ? (add(y, month(mon), +d1), add(y, month(mon), +d2), ' @-@ ') : add(y, month(mon), +d1),
    );
    t = t.replace(
      new RegExp(`\\b(${M})\\b\\.? (\\d{1,2})(?: ?- ?(\\d{1,2}))?${END}(?:,? (20\\d{2}))?`, 'g'),
      (s, mon, d1, d2, y) =>
        d2 ? (add(y, month(mon), +d1), add(y, month(mon), +d2), ' @-@ ') : add(y, month(mon), +d1),
    );
    // A whole month ("May 2027"), for the dates you can't do.
    let wholeMonth = null;
    if (!dates.length)
      t = t.replace(new RegExp(`\\b(${M})\\b\\.? (20\\d{2})\\b`), (s, mon, y) => {
        wholeMonth = { y: +y, m: month(mon) };
        return ' ';
      });
    const days = dates.map((x, k) => {
      const next = x.y || slotYear(x.m, x.d, null, today);
      if (k === 0 && named.length) slot.agrees = weekdayOf(dayNumber(next, x.m, x.d)) === named[0];
      const y = x.y || slotYear(x.m, x.d, k === 0 && named.length === 1 ? named[0] : null, today);
      return dayNumber(y, x.m, x.d);
    });
    if (wholeMonth) {
      const first = dayNumber(wholeMonth.y, wholeMonth.m, 1);
      slot.ranges.push([first, dayNumber(wholeMonth.y, wholeMonth.m + 1, 1) - 1]);
    } else if (days.length === 2 && /@ ?(-|to|until|till|through|thru) ?@/.test(t)) {
      slot.ranges.push([Math.min(...days), Math.max(...days)]);
    } else for (const n of days) slot.ranges.push(week ? [n, n + 6] : [n, n]);
    if (!slot.ranges.length && named.length) slot.weekdays = [...new Set(named)];
    // Times: "10:00-11:00", "2pm - 4pm", "11-1pm", "14:30"; else "morning", "AM".
    const MER = '(am|pm|a\\.m\\.?|p\\.m\\.?)?';
    const range = t.match(
      new RegExp(
        `\\b(\\d{1,2})(?:[:.h](\\d{2}))? ?${MER} ?(?:-|to|until|till) ?(\\d{1,2})(?:[:.h](\\d{2}))? ?${MER}(?![\\w])`,
      ),
    );
    if (range && (range[2] || range[3] || range[5] || range[6]) && +range[1] <= 24 && +range[4] <= 24) {
      const [, h1, m1, a1, h2, m2, a2] = range;
      let from = to24(+h1, a1 || a2) * 60 + (+m1 || 0);
      let to = to24(+h2, a2 || a1) * 60 + (+m2 || 0);
      if (!a1 && a2 && from > to) from = to24(+h1, a2[0] === 'p' ? 'am' : 'pm') * 60 + (+m1 || 0);
      if (to <= from && to < 12 * 60) to += 12 * 60;
      slot.time = [from, to];
    } else {
      const one = t.match(
        new RegExp(`\\b(\\d{1,2})(?:[:.h](\\d{2}) ?${MER}|( ?)(am|pm|a\\.m\\.?|p\\.m\\.?))(?![\\w])`),
      );
      if (one && +one[1] <= 24) {
        const from = to24(+one[1], one[3] || one[5]) * 60 + (+one[2] || 0);
        slot.time = [from, from + 60];
      } else {
        const part = PARTS_OF_DAY.find(([re]) => re.test(t));
        if (part) slot.time = part[1];
        else if (slot.ranges.length || slot.weekdays) {
          if (/(?<!\bi )\b(am|a\.m\.)(?!\w)/.test(t)) slot.time = [9 * 60, 12 * 60];
          else if (/\b(pm|p\.m\.)(?!\w)/.test(t)) slot.time = [12 * 60, 17 * 60];
        }
      }
    }
    if (SLOT_ANY.test(t) && !slot.ranges.length && !slot.weekdays) slot.any = true;
    return slot;
  }

  /** Does a slot (parseSlot) suit you? undefined for "Any time", "None…" and options that name no day or time. */
  function slotFits(slot, a) {
    if (!slot || slot.none || slot.any) return undefined;
    if (!slot.ranges.length && !slot.weekdays && !slot.time) return undefined;
    if (slot.time && (slot.time[0] < a.from || slot.time[1] > a.to)) return false;
    if (slot.weekdays) return slot.weekdays.some((d) => a.days.includes(d));
    if (!slot.ranges.length) return a.days.length > 0;
    const free = (n) =>
      n >= a.today && a.days.includes(weekdayOf(n)) && !a.blocked.some(([from, to]) => n >= from && n <= to);
    return slot.ranges.some(([from, to]) => {
      for (let n = from; n <= Math.min(to, from + 62); n++) if (free(n)) return true;
      return false;
    });
  }

  /**
   * Every option of a slot list, parsed: "03/11" is read day first unless the list says otherwise (a "10/14", a
   * weekday that only fits month first, or a US page).
   */
  function parseSlots(texts, v) {
    const pairs = texts.flatMap((t) => [...String(t || '').matchAll(/\b(\d{1,2})\/(\d{1,2})\b/g)]);
    let order = pairs.some((m) => +m[1] > 12) ? 'dmy' : pairs.some((m) => +m[2] > 12) ? 'mdy' : null;
    if (!order && pairs.length) {
      const agree = (o) => texts.filter((t) => parseSlot(t, v.avail.today, o).agrees).length;
      const dmy = agree('dmy');
      const mdy = agree('mdy');
      order = mdy > dmy ? 'mdy' : dmy > mdy ? 'dmy' : v.dateOrder === 'mdy' ? 'mdy' : 'dmy';
    }
    return texts.map((t) => parseSlot(t, v.avail.today, order || 'dmy'));
  }

  /** Your interview availability from the profile, or null when no day is ticked (then it's left for you). */
  function availability(p, today) {
    const a = p.availability || {};
    const days = dayList(a.days);
    if (!days.length) return null;
    const now = todayNumber(today);
    const blocked = String(a.unavailable || '')
      .split(/\n|;/)
      .map((line) => parseSlot(line.replace(/\b(not available|unavailable|none)\b/gi, ' '), now, 'dmy'))
      .flatMap((s) => s.ranges || []);
    return { days, from: clockMinutes(a.from, 0), to: clockMinutes(a.to, 24 * 60) || 24 * 60, blocked, today: now };
  }

  const clockText = (n) => {
    const h = Math.floor(n / 60) % 24;
    const m = n % 60;
    if (n >= 24 * 60) return 'midnight';
    return `${h % 12 || 12}${m ? ':' + U.pad2(m) : ''}${h < 12 ? 'am' : 'pm'}`;
  };

  /** "Weekdays, 8am–8pm, except 12–23 January 2027", for a box that asks for your availability in words. */
  function availabilityText(a, p) {
    const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const order = a.days.map((d) => (d + 6) % 7).sort(); // Monday first
    const key = a.days.join(',');
    let days;
    if (a.days.length === 7) days = 'Any day';
    else if (key === '1,2,3,4,5') days = 'Weekdays';
    else if (key === '0,6') days = 'Weekends';
    else if (order.length >= 3 && order[order.length - 1] - order[0] === order.length - 1)
      days = `${labels[(order[0] + 1) % 7]}–${labels[(order[order.length - 1] + 1) % 7]}`;
    else {
      const names = order.map((i) => labels[(i + 1) % 7]);
      days = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
    }
    const hours = a.from <= 0 && a.to >= 24 * 60 ? 'any time' : `${clockText(a.from)}–${clockText(a.to)}`;
    const except = String((p.availability || {}).unavailable || '')
      .split(/\n|;/)
      .map((s) => s.replace(/\([^)]*\)/g, '').trim())
      .filter(Boolean);
    return `${days}, ${hours}` + (except.length ? `, except ${except.join(', ')}` : '');
  }

  // What each type of field is filled with.
  Object.assign((P.DEFS = P.DEFS || {}), {
    // "Please select ALL dates/times for which you are available", "Which of these slots work for you?": every slot
    // your days, hours and free dates allow (one choice: the earliest); a text box gets "Weekdays, 8am–8pm".
    'job.availability': {
      label: 'Interview availability',
      get(p, ctx) {
        const a = availability(p, ctx.today);
        if (!a) return null;
        const text = availabilityText(a, p);
        if (LONG_TEXT.includes(ctx.kind)) return val(text, { canonical: null });
        return val(text, { kind: 'availability', avail: a, many: true, dateOrder: ctx.dateOrder, canonical: null });
      },
    },
  });

  Object.assign(P, { parseSlots, slotFits });
})(typeof globalThis !== 'undefined' ? globalThis : this);
