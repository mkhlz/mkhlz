import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const username = process.env.LEETCODE_USERNAME || "mkhlz";
const outputPath = resolve(process.env.OUTPUT_PATH || "assets/leetcode-card.svg");
const endpoint = "https://leetcode.com/graphql/";

const query = `
query profileCard($username: String!) {
  allQuestionsCount {
    difficulty
    count
  }
  matchedUser(username: $username) {
    username
    profile {
      realName
      ranking
    }
    submitStatsGlobal {
      acSubmissionNum {
        difficulty
        count
      }
    }
    submissionCalendar
  }
}
`;

const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Referer: `https://leetcode.com/u/${encodeURIComponent(username)}/`,
    "User-Agent": "mkhlz-profile-card/1.0",
  },
  body: JSON.stringify({
    query,
    variables: { username },
  }),
  signal: AbortSignal.timeout(20_000),
});

if (!response.ok) {
  throw new Error(`LeetCode returned HTTP ${response.status} ${response.statusText}`);
}

const payload = await response.json();

if (payload.errors?.length) {
  throw new Error(`LeetCode GraphQL error: ${payload.errors.map((error) => error.message).join("; ")}`);
}

const user = payload.data?.matchedUser;

if (!user) {
  throw new Error(`LeetCode user "${username}" was not found`);
}

const calendar = JSON.parse(user.submissionCalendar || "{}");
const calendarEntries = Object.entries(calendar);

if (calendarEntries.length === 0) {
  throw new Error("LeetCode returned an empty submission calendar; refusing to overwrite the existing card");
}

const solved = countsByDifficulty(user.submitStatsGlobal?.acSubmissionNum || []);
const available = countsByDifficulty(payload.data?.allQuestionsCount || []);

for (const difficulty of ["All", "Easy", "Medium", "Hard"]) {
  if (!Number.isFinite(solved[difficulty]) || !Number.isFinite(available[difficulty])) {
    throw new Error(`Missing ${difficulty} problem statistics`);
  }
}

const card = renderCard({
  username: user.username,
  realName: user.profile?.realName || user.username,
  ranking: Number(user.profile?.ranking || 0),
  solved,
  available,
  calendar,
});

if (card.includes("undefined") || card.includes("NaN")) {
  throw new Error("Generated SVG contains invalid values");
}

const activeHeatmapCells = (card.match(/data-level="[1-4]"/g) || []).length;

if (activeHeatmapCells === 0) {
  throw new Error("Generated heatmap has no active cells; refusing to overwrite the existing card");
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, card, "utf8");

console.log(
  `Generated ${outputPath} for ${user.username}: ${solved.All} solved, ` +
    `${calendarEntries.length} calendar entries, ${activeHeatmapCells} active heatmap cells`,
);

function countsByDifficulty(items) {
  return Object.fromEntries(items.map((item) => [item.difficulty, Number(item.count)]));
}

function renderCard({ username, realName, ranking, solved, available, calendar }) {
  const width = 920;
  const height = 470;
  const today = startOfUtcDay(new Date());
  const currentWeekStart = startOfUtcWeek(today);
  const gridStart = addDays(currentWeekStart, -51 * 7);
  const cells = [];
  const monthLabels = [];
  const weeklyActivity = [];
  const levelColors = ["#24283b", "#6f5100", "#a87500", "#d99500", "#f7ab00"];
  let displayedSubmissions = 0;
  let activeDays = 0;
  let previousMonth = -1;

  for (let week = 0; week < 52; week += 1) {
    let weekTotal = 0;
    const weekDate = addDays(gridStart, week * 7);

    if (weekDate.getUTCMonth() !== previousMonth) {
      monthLabels.push({
        label: weekDate.toLocaleString("en-US", { month: "short", timeZone: "UTC" }),
        x: 150 + week * 13.55,
      });
      previousMonth = weekDate.getUTCMonth();
    }

    for (let day = 0; day < 7; day += 1) {
      const date = addDays(weekDate, day);
      const isFuture = date > today;
      const timestamp = Math.floor(date.getTime() / 1000);
      const count = isFuture ? 0 : Number(calendar[String(timestamp)] || 0);
      const level = isFuture ? 0 : heatLevel(count);
      const x = 150 + week * 13.55;
      const y = 300 + day * 13.55;

      if (!isFuture) {
        displayedSubmissions += count;
        weekTotal += count;
        activeDays += Number(count > 0);
      }

      cells.push(`
        <rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="10.5" height="10.5" rx="2"
          fill="${isFuture ? "#1f2233" : levelColors[level]}" data-level="${level}">
          <title>${formatDate(date)}: ${count} submission${count === 1 ? "" : "s"}</title>
        </rect>`);
    }

    weeklyActivity.push(weekTotal);
  }

  const streaks = calculateStreaks(calendar, today, gridStart);
  const allProgress = ratio(solved.All, available.All);
  const easyProgress = ratio(solved.Easy, available.Easy);
  const mediumProgress = ratio(solved.Medium, available.Medium);
  const hardProgress = ratio(solved.Hard, available.Hard);
  const updated = formatDateTime(new Date());
  const rankLabel = ranking > 0 ? `#${formatNumber(ranking)}` : "Unranked";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
  <title id="title">${escapeXml(realName)} LeetCode progress</title>
  <desc id="description">${formatNumber(solved.All)} solved problems, ${streaks.current} day current streak, and a 52 week submission heatmap.</desc>
  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1a1b27"/>
      <stop offset="100%" stop-color="#171824"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#f7ab00"/>
      <stop offset="100%" stop-color="#ffd166"/>
    </linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="5" stdDeviation="10" flood-color="#000000" flood-opacity="0.24"/>
    </filter>
    <style>
      text { font-family: "Segoe UI", Ubuntu, Arial, sans-serif; }
      .muted { fill: #8b92b2; }
      .label { fill: #a9b1d6; font-size: 12px; font-weight: 600; letter-spacing: 0.4px; }
      .value { fill: #ffffff; font-weight: 700; }
      .panel { fill: #202231; stroke: #2d3044; stroke-width: 1; }
      .track { fill: #303348; }
    </style>
  </defs>

  <rect x="10" y="10" width="900" height="450" rx="18" fill="url(#background)" stroke="#2d3044" filter="url(#shadow)"/>
  <rect x="10" y="10" width="6" height="450" rx="3" fill="url(#accent)"/>

  <g aria-label="Header">
    <g transform="translate(40 36)">
      <circle cx="21" cy="21" r="21" fill="#f7ab00"/>
      <path d="m18 12-9 9 9 9M27 12l9 9-9 9M25 9l-8 24" fill="none" stroke="#171824" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
    </g>
    <text x="96" y="50" class="value" font-size="24">LeetCode Progress</text>
    <text x="96" y="72" class="muted" font-size="13">@${escapeXml(username)} · Updated ${escapeXml(updated)}</text>
    <rect x="760" y="36" width="118" height="38" rx="19" fill="#272a3d" stroke="#3a3e57"/>
    <text x="819" y="52" class="muted" font-size="10" text-anchor="middle">GLOBAL RANK</text>
    <text x="819" y="68" class="value" font-size="14" text-anchor="middle">${rankLabel}</text>
  </g>

  <g aria-label="Solved problem statistics">
    <rect class="panel" x="40" y="98" width="250" height="148" rx="14"/>
    <text x="62" y="123" class="label">PROBLEMS SOLVED</text>
    <text x="62" y="164" class="value" font-size="34">${formatNumber(solved.All)}</text>
    <text x="148" y="163" class="muted" font-size="15">/ ${formatNumber(available.All)}</text>
    ${progressBar(62, 181, 206, 9, allProgress, "#f7ab00")}
    <text x="62" y="214" class="muted" font-size="11">${percent(allProgress)}% complete</text>
    <text x="267" y="214" fill="#f7ab00" font-size="11" font-weight="700" text-anchor="end">${formatNumber(available.All - solved.All)} remaining</text>

    <rect class="panel" x="306" y="98" width="572" height="148" rx="14"/>
    ${difficultyRow("Easy", solved.Easy, available.Easy, easyProgress, 328, 126, "#00b8a3")}
    ${difficultyRow("Medium", solved.Medium, available.Medium, mediumProgress, 328, 165, "#ffc01e")}
    ${difficultyRow("Hard", solved.Hard, available.Hard, hardProgress, 328, 204, "#ef4743")}
  </g>

  <g aria-label="Submission activity">
    <text x="40" y="273" class="label">SUBMISSION ACTIVITY · LAST 52 WEEKS</text>
    <text x="878" y="273" class="muted" font-size="11" text-anchor="end">${formatNumber(displayedSubmissions)} submissions across ${activeDays} active days</text>

    <text x="132" y="309" class="muted" font-size="10" text-anchor="end">Sun</text>
    <text x="132" y="336" class="muted" font-size="10" text-anchor="end">Tue</text>
    <text x="132" y="363" class="muted" font-size="10" text-anchor="end">Thu</text>
    <text x="132" y="390" class="muted" font-size="10" text-anchor="end">Sat</text>

    ${monthLabels.map(({ label, x }) => `<text x="${x.toFixed(2)}" y="292" class="muted" font-size="10">${label}</text>`).join("\n    ")}
    ${cells.join("")}

    <g transform="translate(40 425)">
      ${statPill(0, "CURRENT STREAK", `${streaks.current} day${streaks.current === 1 ? "" : "s"}`, "#f7ab00")}
      ${statPill(190, "BEST STREAK · 52W", `${streaks.best} days`, "#ffd166")}
      ${statPill(395, "MOST ACTIVE WEEK", `${Math.max(...weeklyActivity)} submissions`, "#7aa2f7")}
    </g>

    <g transform="translate(726 429)">
      <text x="0" y="10" class="muted" font-size="10">Less</text>
      ${levelColors.map((color, index) => `<rect x="${30 + index * 15}" y="0" width="11" height="11" rx="2" fill="${color}"/>`).join("")}
      <text x="110" y="10" class="muted" font-size="10">More</text>
    </g>
  </g>
</svg>
`;
}

function difficultyRow(label, completed, total, progress, x, y, color) {
  return `
    <text x="${x}" y="${y}" fill="${color}" font-size="12" font-weight="700">${label}</text>
    <text x="${x + 94}" y="${y}" class="value" font-size="14" text-anchor="end">${formatNumber(completed)}</text>
    <text x="${x + 100}" y="${y}" class="muted" font-size="11">/ ${formatNumber(total)}</text>
    ${progressBar(x + 175, y - 10, 348, 8, progress, color)}
    <text x="${x + 535}" y="${y}" class="muted" font-size="11" text-anchor="end">${percent(progress)}%</text>`;
}

function progressBar(x, y, width, height, progress, color) {
  const completedWidth = Math.max(0, Math.min(width, width * progress));
  return `
    <rect class="track" x="${x}" y="${y}" width="${width}" height="${height}" rx="${height / 2}"/>
    <rect x="${x}" y="${y}" width="${completedWidth.toFixed(2)}" height="${height}" rx="${height / 2}" fill="${color}"/>`;
}

function statPill(x, label, value, color) {
  return `
    <circle cx="${x + 6}" cy="5" r="5" fill="${color}"/>
    <text x="${x + 18}" y="2" class="muted" font-size="9">${label}</text>
    <text x="${x + 18}" y="16" class="value" font-size="12">${value}</text>`;
}

function calculateStreaks(calendar, today, displayedStart) {
  const hasActivity = (date) => {
    const timestamp = Math.floor(date.getTime() / 1000);
    return Number(calendar[String(timestamp)] || 0) > 0;
  };

  let current = 0;
  let cursor = new Date(today);

  if (!hasActivity(cursor)) {
    cursor = addDays(cursor, -1);
  }

  while (hasActivity(cursor)) {
    current += 1;
    cursor = addDays(cursor, -1);
  }

  let best = 0;
  let running = 0;
  cursor = new Date(displayedStart);

  while (cursor <= today) {
    if (hasActivity(cursor)) {
      running += 1;
      best = Math.max(best, running);
    } else {
      running = 0;
    }
    cursor = addDays(cursor, 1);
  }

  return { current, best };
}

function heatLevel(count) {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count <= 3) return 2;
  if (count <= 7) return 3;
  return 4;
}

function ratio(value, total) {
  return total > 0 ? value / total : 0;
}

function percent(value) {
  return (value * 100).toFixed(1);
}

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function startOfUtcWeek(date) {
  return addDays(date, -date.getUTCDay());
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 86_400_000);
}

function formatDate(date) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatDateTime(date) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
