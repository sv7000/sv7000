// Builds dist/stats.svg from public GitHub data for one user.
// Repos owned by anyone in EXCLUDE_OWNERS are left out of every number.
// Private contributions are never counted.
import { mkdirSync, writeFileSync } from "node:fs";

const USER = process.env.STATS_USER ?? "sv7000";
const NAME = process.env.STATS_NAME ?? "Sumit Vishwakarma";
const EXCLUDE = new Set(
  (process.env.EXCLUDE_OWNERS ?? "mu7ammedkhan")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) throw new Error("GITHUB_TOKEN is required");

async function gql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(JSON.stringify(json.errors ?? json));
  return json.data;
}

const allowed = (owner) => !EXCLUDE.has(owner.toLowerCase());

// Walks a paginated connection on the user and returns every node.
async function nodesOf(field, nodeFields, extraArgs = "") {
  const nodes = [];
  let after = null;
  do {
    const data = await gql(
      `query($login: String!, $after: String) {
        user(login: $login) {
          ${field}(first: 100, after: $after ${extraArgs}) {
            pageInfo { hasNextPage endCursor }
            nodes { ${nodeFields} }
          }
        }
      }`,
      { login: USER, after }
    );
    const conn = data.user[field];
    nodes.push(...conn.nodes);
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after);
  return nodes;
}

const { user } = await gql(`query($login: String!) { user(login: $login) { createdAt } }`, {
  login: USER,
});

// Commits, year by year (the API allows at most one year per query).
let commits = 0;
const contributedTo = new Set();
const now = new Date();
for (let from = new Date(user.createdAt); from < now; ) {
  const to = new Date(Math.min(now.getTime(), new Date(from).setFullYear(from.getFullYear() + 1)));
  const data = await gql(
    `query($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          commitContributionsByRepository(maxRepositories: 100) {
            repository { name owner { login } isPrivate }
            contributions { totalCount }
          }
        }
      }
    }`,
    { login: USER, from: from.toISOString(), to: to.toISOString() }
  );
  for (const { repository: r, contributions } of data.user.contributionsCollection
    .commitContributionsByRepository) {
    if (r.isPrivate || !allowed(r.owner.login)) continue;
    commits += contributions.totalCount;
    if (r.owner.login.toLowerCase() !== USER.toLowerCase()) contributedTo.add(`${r.owner.login}/${r.name}`);
  }
  from = to;
}

const repoFields = "repository { name owner { login } isPrivate }";
const keep = (n) => !n.repository.isPrivate && allowed(n.repository.owner.login);

const prs = (await nodesOf("pullRequests", repoFields)).filter(keep);
for (const { repository: r } of prs) {
  if (r.owner.login.toLowerCase() !== USER.toLowerCase()) contributedTo.add(`${r.owner.login}/${r.name}`);
}
const issues = (await nodesOf("issues", repoFields)).filter(keep);
const repos = await nodesOf(
  "repositories",
  "stargazerCount",
  ", ownerAffiliations: OWNER, privacy: PUBLIC, isFork: false"
);
const stars = repos.reduce((sum, r) => sum + r.stargazerCount, 0);

const stats = [
  { label: "Commits", value: commits },
  { label: "Pull requests", value: prs.length },
  { label: "Open-source projects", value: contributedTo.size },
  { label: "Public repos", value: repos.length },
  { label: "Stars earned", value: stars },
  { label: "Issues", value: issues.length },
];
console.log(stats.map((s) => `${s.label}: ${s.value}`).join("\n"));

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/'/g, "&#39;");
const updated = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

const cells = stats
  .map((s, i) => {
    const x = 25 + (i % 3) * 157;
    const y = 100 + Math.floor(i / 3) * 58;
    return `<g class="stat" style="animation-delay:${150 + i * 120}ms" transform="translate(${x} ${y})">
    <text class="value">${s.value.toLocaleString("en-US")}</text>
    <text class="label" y="22">${esc(s.label)}</text>
  </g>`;
  })
  .join("\n  ");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="495" height="195" viewBox="0 0 495 195" role="img" aria-labelledby="title">
  <title id="title">${esc(NAME)}'s GitHub stats</title>
  <style>
    .title { font: 600 18px 'Segoe UI', Ubuntu, 'Helvetica Neue', sans-serif; fill: #6366F1; }
    .meta { font: 400 11px 'Segoe UI', Ubuntu, 'Helvetica Neue', sans-serif; fill: #8b949e; }
    .value { font: 700 26px 'Segoe UI', Ubuntu, 'Helvetica Neue', sans-serif; fill: #6366F1; }
    .label { font: 600 12px 'Segoe UI', Ubuntu, 'Helvetica Neue', sans-serif; fill: #8b949e; }
    .stat { opacity: 0; animation: fadeIn 0.5s ease-out forwards; }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) { .stat { animation: none; opacity: 1; } }
  </style>
  <text class="title" x="25" y="34">${esc(NAME)}'s GitHub stats</text>
  <text class="meta" x="25" y="54">Public repos only · updated ${esc(updated)}</text>
  ${cells}
</svg>
`;

mkdirSync("dist", { recursive: true });
writeFileSync("dist/stats.svg", svg);
