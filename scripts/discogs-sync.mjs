#!/usr/bin/env node
/**
 * Haalt de Discogs-collectie en wantlist van één gebruiker op en schrijft
 * een compacte samenvatting naar data/discogs.json.
 *
 * Vereist twee omgevingsvariabelen:
 *   DISCOGS_TOKEN    personal access token (discogs.com/settings/developers)
 *   DISCOGS_USER     Discogs-gebruikersnaam
 *
 * Bewust NIET opgenomen in de uitvoer: betaalde prijs en plaats van aankoop.
 * De rest staat toch al publiek op je Discogs-profiel.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const TOKEN = process.env.DISCOGS_TOKEN;
const USER = process.env.DISCOGS_USER;
const OUT = 'data/discogs.json';

if (!TOKEN || !USER) {
  console.error('Ontbrekende omgevingsvariabelen: DISCOGS_TOKEN en/of DISCOGS_USER');
  process.exit(1);
}

const HEADERS = {
  Authorization: `Discogs token=${TOKEN}`,
  // Discogs weigert verzoeken zonder herkenbare User-Agent.
  'User-Agent': `discogs-sync/1.0 (+https://github.com/${process.env.GITHUB_REPOSITORY ?? 'local'})`,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path) {
  const url = `https://api.discogs.com${path}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} bij ${path}`);
  }
  return res.json();
}

/** Zet een Discogs-item om naar een platte, leesbare regel. */
function flatten(item) {
  const b = item.basic_information ?? {};
  const format = (b.formats ?? [])
    .map((f) => [f.name, ...(f.descriptions ?? [])].join(' '))
    .join(' / ');
  return {
    artist: (b.artists ?? []).map((a) => a.name.replace(/\s\(\d+\)$/, '')).join(', '),
    title: b.title ?? '',
    year: b.year || null,
    label: (b.labels ?? [])[0]?.name ?? null,
    format: format || null,
    release_id: b.id ?? item.id ?? null,
    date_added: (item.date_added ?? '').slice(0, 10),
  };
}

async function main() {
  console.log(`Ophalen voor gebruiker ${USER}…`);

  // 1. Mappen met hun aantallen. Map 0 is "All".
  const foldersRes = await api(`/users/${USER}/collection/folders`);
  const folders = (foldersRes.folders ?? [])
    .filter((f) => f.id !== 0)
    .map((f) => ({ name: f.name, count: f.count }))
    .sort((a, b) => b.count - a.count);
  const collectionCount = (foldersRes.folders ?? []).find((f) => f.id === 0)?.count ?? null;
  await sleep(1000);

  // 2. Laatste 50 toevoegingen aan de collectie.
  const colRes = await api(
    `/users/${USER}/collection/folders/0/releases?sort=added&sort_order=desc&per_page=50&page=1`
  );
  const recentAdditions = (colRes.releases ?? []).map(flatten);
  await sleep(1000);

  // 3. Laatste 50 toevoegingen aan de wantlist.
  const wantRes = await api(
    `/users/${USER}/wants?sort=added&sort_order=desc&per_page=50&page=1`
  );
  const recentWants = (wantRes.wants ?? []).map(flatten);

  const payload = {
    generated_at: new Date().toISOString(),
    user: USER,
    collection_count: collectionCount,
    wantlist_count: wantRes.pagination?.items ?? null,
    folders,
    recent_additions: recentAdditions,
    recent_wants: recentWants,
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(payload, null, 2) + '\n');

  console.log(
    `Geschreven naar ${OUT}: ${collectionCount} in collectie, ` +
      `${payload.wantlist_count} op wantlist, ` +
      `${recentAdditions.length} recente aanwinsten.`
  );
}

main().catch((err) => {
  console.error('Mislukt:', err.message);
  process.exit(1);
});
