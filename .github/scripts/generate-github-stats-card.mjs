import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const username = process.env.GITHUB_USERNAME || "mkhlz";
const outputPath = resolve(process.env.OUTPUT_PATH || "assets/github-stats-card.svg");
const token = process.env.GITHUB_TOKEN;
const endpoint = "https://api.github.com/graphql";

if (!token) {
  throw new Error("GITHUB_TOKEN is required to query the GitHub GraphQL API");
}

const query = `
query profileStats($login: String!) {
  user(login: $login) {
    login
    name
    followers {
      totalCount
    }
    repositories(first: 100, ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC) {
      totalCount
      nodes {
        stargazerCount
        languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
          edges {
            size
            node {
              name
              color
            }
          }
        }
      }
    }
    contributionsCollection {
      totalCommitContributions
      totalPullRequestContributions
      totalIssueContributions
      totalRepositoryContributions
      contributionCalendar {
        totalContributions
        weeks {
          contributionDays {
            date
            contributionCount
          }
        }
      }
    }
  }
}
`;

const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "mkhlz-profile-card/1.0",
  },
  body: JSON.stringify({
    query,
    variables: { login: username },
  }),
  signal: AbortSignal.timeout(20_000),
});

if (!response.ok) {
  throw new Error(`GitHub API returned HTTP ${response.status} ${response.statusText}`);
}

const payload = await response.json();

if (payload.errors?.length) {
  throw new Error(`GitHub GraphQL error: ${payload.errors.map((error) => error.message).join("; ")}`);
}

const user = payload.data?.user;

if (!user) {
  throw new Error(`GitHub user "${username}" was not found`);
}

const repositories = user.repositories?.nodes || [];
const totalStars = repositories.reduce((sum, repo) => sum + Number(repo.stargazerCount || 0), 0);
const languageTotals = aggregateLanguages(repositories);

const contributions = user.contributionsCollection;

if (!contributions) {
  throw new Error("GitHub response is missing contribution data");
}

const calendar = flattenCalendar(contributions.contributionCalendar?.weeks || []);

if (Object.keys(calendar).length === 0) {
  throw new Error("GitHub returned an empty contribution calendar; refusing to overwrite the existing card");
}

const card = renderCard({
  login: user.login,
  displayName: user.name || user.login,
  followers: Number(user.followers?.totalCount || 0),
  publicRepos: Number(user.repositories?.totalCount || 0),
  totalStars,
  totalContributions: Number(contributions.contributionCalendar?.totalContributions || 0),
  commits: Number(contributions.totalCommitContributions || 0),
  pullRequests: Number(contributions.totalPullRequestContributions || 0),
  issues: Number(contributions.totalIssueContributions || 0),
  languages: languageTotals,
  calendar,
});

if (card.includes("undefined") || card.includes("NaN")) {
  throw new Error("Generated SVG contains invalid values");
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, card, "utf8");

console.log(
  `Generated ${outputPath} for ${user.login}: ${contributions.contributionCalendar?.totalContributions} ` +
    `contributions, ${languageTotals.length} languages, ${totalStars} stars`,
);

function aggregateLanguages(repositories) {
  const totals = new Map();

  for (const repo of repositories) {
    for (const edge of repo.languages?.edges || []) {
      const name = edge.node.name;
      const existing = totals.get(name) || { name, size: 0, color: edge.node.color || "#8b92b2" };
      existing.size += Number(edge.size || 0);
      totals.set(name, existing);
    }
  }

  const sorted = [...totals.values()].sort((a, b) => b.size - a.size);
  const totalSize = sorted.reduce((sum, entry) => sum + entry.size, 0);

  return sorted.slice(0, 5).map((entry) => ({
    ...entry,
    share: totalSize > 0 ? entry.size / totalSize : 0,
  }));
}

function flattenCalendar(weeks) {
  const calendar = {};

  for (const week of weeks) {
    for (const day of week.contributionDays) {
      const timestamp = Math.floor(Date.parse(`${day.date}T00:00:00Z`) / 1000);
      calendar[String(timestamp)] = day.contributionCount;
    }
  }

  return calendar;
}

function renderCard({
  login,
  displayName,
  followers,
  publicRepos,
  totalStars,
  totalContributions,
  commits,
  pullRequests,
  issues,
  languages,
  calendar,
}) {
  const width = 920;
  const height = 470;
  const today = startOfUtcDay(new Date());
  const currentWeekStart = startOfUtcWeek(today);
  const gridStart = addDays(currentWeekStart, -51 * 7);
  const cells = [];
  const monthLabels = [];
  const weeklyActivity = [];
  const levelColors = ["#24283b", "#6f5100", "#a87500", "#d99500", "#f7ab00"];
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
        weekTotal += count;
        activeDays += Number(count > 0);
      }

      cells.push(`
        <rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="10.5" height="10.5" rx="2"
          fill="${isFuture ? "#1f2233" : levelColors[level]}" data-level="${level}">
          <title>${formatDate(date)}: ${count} contribution${count === 1 ? "" : "s"}</title>
        </rect>`);
    }

    weeklyActivity.push(weekTotal);
  }

  const streaks = calculateStreaks(calendar, today, gridStart);
  const updated = formatDateTime(new Date());
  const maxLanguageShare = languages.length > 0 ? languages[0].share : 0;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
  <title id="title">${escapeXml(displayName)} GitHub activity</title>
  <desc id="description">${formatNumber(totalContributions)} contributions in the last year, ${streaks.current} day current streak, and a 52 week contribution heatmap.</desc>
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
      <circle cx="12" cy="28" r="3.4" fill="#171824"/>
      <circle cx="12" cy="14" r="3.4" fill="#171824"/>
      <circle cx="30" cy="21" r="3.4" fill="#171824"/>
      <path d="M12 17.4V24.6M14.8 15.6c4.6 0 6.4 1.8 6.4 5.4" fill="none" stroke="#171824" stroke-width="2.6" stroke-linecap="round"/>
    </g>
    <text x="96" y="50" class="value" font-size="24">GitHub Activity</text>
    <text x="96" y="72" class="muted" font-size="13">@${escapeXml(login)} &#183; Updated ${escapeXml(updated)}</text>
    <rect x="742" y="36" width="136" height="38" rx="19" fill="#272a3d" stroke="#3a3e57"/>
    <text x="810" y="52" class="muted" font-size="10" text-anchor="middle">PUBLIC REPOS</text>
    <text x="810" y="68" class="value" font-size="14" text-anchor="middle">${formatNumber(publicRepos)}</text>
  </g>

  <g aria-label="Contribution statistics">
    <rect class="panel" x="40" y="98" width="250" height="148" rx="14"/>
    <text x="62" y="123" class="label">CONTRIBUTIONS &#183; LAST YEAR</text>
    <text x="62" y="164" class="value" font-size="34">${formatNumber(totalContributions)}</text>
    ${statRow("Commits", commits, 62, 189, "#f7ab00")}
    ${statRow("Pull requests", pullRequests, 62, 203, "#7aa2f7")}
    ${statRow("Issues", issues, 62, 217, "#ef4743")}
    <text x="62" y="238" class="muted" font-size="10">${formatNumber(followers)} followers &#183; ${formatNumber(totalStars)} stars</text>

    <rect class="panel" x="306" y="98" width="572" height="148" rx="14"/>
    <text x="328" y="123" class="label">TOP LANGUAGES</text>
    ${languages
      .map((entry, index) => languageRow(entry, 328, 145 + index * 23, maxLanguageShare))
      .join("\n    ")}
  </g>

  <g aria-label="Contribution activity">
    <text x="40" y="273" class="label">CONTRIBUTION ACTIVITY &#183; LAST 52 WEEKS</text>
    <text x="878" y="273" class="muted" font-size="11" text-anchor="end">${formatNumber(totalContributions)} contributions across ${activeDays} active days</text>

    <text x="132" y="309" class="muted" font-size="10" text-anchor="end">Sun</text>
    <text x="132" y="336" class="muted" font-size="10" text-anchor="end">Tue</text>
    <text x="132" y="363" class="muted" font-size="10" text-anchor="end">Thu</text>
    <text x="132" y="390" class="muted" font-size="10" text-anchor="end">Sat</text>

    ${monthLabels.map(({ label, x }) => `<text x="${x.toFixed(2)}" y="292" class="muted" font-size="10">${label}</text>`).join("\n    ")}
    ${cells.join("")}

    <g transform="translate(40 425)">
      ${statPill(0, "CURRENT STREAK", `${streaks.current} day${streaks.current === 1 ? "" : "s"}`, "#f7ab00")}
      ${statPill(190, "BEST STREAK &#183; 52W", `${streaks.best} days`, "#ffd166")}
      ${statPill(395, "MOST ACTIVE WEEK", `${Math.max(0, ...weeklyActivity)} contributions`, "#7aa2f7")}
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

function statRow(label, value, x, y, color) {
  return `
    <circle cx="${x + 3}" cy="${y - 4}" r="3" fill="${color}"/>
    <text x="${x + 12}" y="${y}" class="muted" font-size="11">${label}</text>
    <text x="267" y="${y}" class="value" font-size="11" text-anchor="end">${formatNumber(value)}</text>`;
}

function languageRow(entry, x, y, maxShare) {
  const barWidth = 320;
  const relativeWidth = maxShare > 0 ? (entry.share / maxShare) * barWidth : 0;
  const completedWidth = Math.max(2, Math.min(barWidth, relativeWidth));

  return `
    <circle cx="${x + 3}" cy="${y - 4}" r="4" fill="${entry.color}"/>
    <text x="${x + 14}" y="${y}" class="value" font-size="12">${escapeXml(entry.name)}</text>
    <text x="${x + 546}" y="${y}" class="muted" font-size="11" text-anchor="end">${percent(entry.share)}%</text>
    <rect class="track" x="${x + 200}" y="${y - 10}" width="${barWidth}" height="8" rx="4"/>
    <rect x="${x + 200}" y="${y - 10}" width="${completedWidth.toFixed(2)}" height="8" rx="4" fill="${entry.color}"/>`;
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
  if (count <= 6) return 3;
  return 4;
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
