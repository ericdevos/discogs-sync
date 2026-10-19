#!/usr/bin/env node
/**
 * Haalt de Discogs-collectie en wantlist van één gebruiker op.
 *
 * Schrijft drie bestanden:
 *   data/discogs.json     compacte samenvatting (aantallen, mappen, laatste 50
 *                         aanwinsten en wantlist-toevoegingen). Vorm ongewijzigd,
 *                         zodat bestaande lezers blijven werken.
 *   data/collection.json  de VOLLEDIGE collectie, één release per regel, met de
 *                         Discogs-map waarin hij staat ("folder") en het jaar van
 *                         de oorspronkelijke uitgave ("original_year", via de master).
 *   data/masters.json     cache: master_id -> jaar, zodat alleen nieuwe albums
 *                         opgevraagd worden.
 *   data/wantlist.json    de VOLLEDIGE wantlist, één release per regel.
 *
 * collection.json en wantlist.json bevatten bewust geen tijdstempel, zodat ze
 * alleen in git veranderen als de collectie of wantlist echt verandert.
 *
 * Vereist twee omgevingsvariabelen:
 *   DISCOGS_TOKEN    personal access token (discogs.com/settings/developers)
 *   DISCOGS_USER     Discogs-gebruikersnaam
 *
 * Bewust NIET opgenomen in de uitvoer: betaalde prijs, plaats van aankoop en
 * andere notities. De rest staat toch al publiek op je Discogs-profiel.
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const TOKEN = process.env.DISCOGS_TOKEN;
const USER = process.env.DISCOGS_USER;
const OUT_SUMMARY = 'data/discogs.json';
const OUT_COLLECTION = 'data/collection.json';
const OUT_WANTLIST = 'data/wantlist.json';
const OUT_MASTERS = 'data/masters.json'; // master_id -> jaar van de oorspronkelijke uitgave (cache)
const PER_PAGE = 100; // maximum dat Discogs toestaat
const PAUSE_MS = 1100; // ruim binnen de limiet van 60 verzoeken per minuut

if (!TOKEN || !USER) {
  console.error('Ontbrekende omgevingsvariabelen: DISCOGS_TOKEN en/of DISCOGS_USER');
  process.exit(1);
}

const HEADERS = {
  Authorization: `Discogs token=${TOKEN}`,
  // Discogs weigert verzoeken zonder herkenbare User-Agent.
  'User-Agent': `discogs-sync/2.0 (+https://github.com/${process.env.GITHUB_REPOSITORY ?? 'local'})`,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET met één herkansing bij rate limiting (429) of een tijdelijke serverfout. */
async function api(path, attempt = 1) {
  const res = await fetch(`https://api.discogs.com${path}`, { headers: HEADERS });
  if ((res.status === 429 || res.status >= 500) && attempt <= 3) {
    const wait = 5000 * attempt;
    console.warn(`${res.status} bij ${path}, opnieuw over ${wait / 1000}s…`);
    await sleep(wait);
    return api(path, attempt + 1);
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} bij ${path}`);
  return res.json();
}

/** Haalt alle pagina's van een gepagineerd endpoint op. */
async function allPages(basePath, key) {
  const items = [];
  let page = 1;
  let pages = 1;
  do {
    const sep = basePath.includes('?') ? '&' : '?';
    const res = await api(`${basePath}${sep}per_page=${PER_PAGE}&page=${page}`);
    items.push(...(res[key] ?? []));
    pages = res.pagination?.pages ?? 1;
    console.log(`  ${key}: pagina ${page}/${pages}`);
    page += 1;
    if (page <= pages) await sleep(PAUSE_MS);
  } while (page <= pages);
  return items;
}

const cleanName = (s) => s.replace(/\s\(\d+\)$/, '');

/** instance_id -> map-id, gevuld door alle mappen één voor één op te halen. */
let folderOfInstance = null;

/** Zet een Discogs-item om naar een platte, leesbare regel. */
function flatten(item, folderNames) {
  const b = item.basic_information ?? {};
  const format = (b.formats ?? [])
    .map((f) => [f.name, ...(f.descriptions ?? [])].join(' '))
    .join(' / ');
  const row = {
    artist: (b.artists ?? []).map((a) => cleanName(a.name)).join(', '),
    title: b.title ?? '',
    year: b.year || null,
    label: (b.labels ?? [])[0]?.name ?? null,
    catno: (b.labels ?? [])[0]?.catno ?? null,
    format: format || null,
    genres: b.genres ?? [],
    styles: b.styles ?? [],
    release_id: b.id ?? item.id ?? null,
    // master_id groepeert alle persingen van hetzelfde album. Handig om de
    // wantlist te ontdubbelen: varianten delen hetzelfde master_id.
    master_id: b.master_id || null,
    date_added: (item.date_added ?? '').slice(0, 10),
  };
  if (folderNames) {
    // Map 0 ("All") zegt niets over de echte map; daarom eerst de per-map-telling
    const fromScan = folderOfInstance && folderOfInstance.get(item.instance_id);
    const id = fromScan ?? (item.folder_id > 0 ? item.folder_id : null);
    if (id) row.folder = folderNames.get(id) ?? String(id);
  }
  return row;
}

/** Eén release per regel: leesbare git-diffs, ook bij duizend items. */
function toLines(rows) {
  return '[\n' + rows.map((r) => JSON.stringify(r)).join(',\n') + '\n]\n';
}

const byNewest = (a, b) =>
  b.date_added.localeCompare(a.date_added) || (a.release_id ?? 0) - (b.release_id ?? 0);

async function write(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function main() {
  console.log(`Ophalen voor gebruiker ${USER}…`);

  // 1. Mappen. Map 0 is "All" en bevat het totaal.
  const foldersRes = await api(`/users/${USER}/collection/folders`);
  const allFolders = foldersRes.folders ?? [];
  // Map 0 ("All") is geen echte map; items staan altijd in map 1 of hoger.
  const folderNames = new Map(allFolders.filter((f) => f.id !== 0).map((f) => [f.id, f.name]));
  const collectionCount = allFolders.find((f) => f.id === 0)?.count ?? null;
  if (folderNames.size === 0) {
    console.warn('Let op: Discogs geeft alleen map "All" terug. Het token wordt niet als eigenaar herkend;');
    console.warn('gebruik een persoonlijk token (Settings > Developers > Generate token), geen Consumer Key.');
  }
  await sleep(PAUSE_MS);

  // 1b. Per map ophalen welke exemplaren erin staan. In map 0 ("All") geeft
  //     Discogs niet altijd de echte map mee, per map is het eenduidig.
  folderOfInstance = new Map();
  for (const f of allFolders) {
    if (f.id === 0 || !f.count) continue;
    const items = await allPages(`/users/${USER}/collection/folders/${f.id}/releases`, 'releases');
    for (const it of items) folderOfInstance.set(it.instance_id, f.id);
    await sleep(PAUSE_MS);
  }

  // 2. Volledige collectie.
  const collectionRaw = await allPages(
    `/users/${USER}/collection/folders/0/releases?sort=added&sort_order=desc`,
    'releases'
  );
  const collection = collectionRaw.map((i) => flatten(i, folderNames)).sort(byNewest);
  await sleep(PAUSE_MS);

  // 2b. Jaar van de oorspronkelijke uitgave, via de master release.
  //     Eén verzoek per album; eerder opgehaalde jaren staan in masters.json.
  let masters = {};
  try { masters = JSON.parse(await readFile(OUT_MASTERS, 'utf8')); } catch { masters = {}; }
  const todo = [...new Set(collection.map((r) => r.master_id).filter((id) => id && !(id in masters)))];
  console.log(`Masters: ${Object.keys(masters).length} bekend, ${todo.length} nieuw op te halen`);
  for (const [n, id] of todo.entries()) {
    try {
      const m = await api(`/masters/${id}`);
      masters[id] = m.year || null;
    } catch (err) {
      console.warn(`  master ${id}: ${err.message}`);
    }
    if ((n + 1) % 100 === 0) {
      console.log(`  masters: ${n + 1}/${todo.length}`);
      await write(OUT_MASTERS, JSON.stringify(masters, null, 0) + '\n'); // tussentijds bewaren
    }
    await sleep(PAUSE_MS);
  }
  for (const r of collection) {
    const y = r.master_id ? masters[r.master_id] : null;
    r.original_year = y || r.year || null;
  }

  // 3. Volledige wantlist.
  const wantRaw = await allPages(`/users/${USER}/wants?sort=added&sort_order=desc`, 'wants');
  const wantlist = wantRaw.map((i) => flatten(i)).sort(byNewest);

  // Mappen tellen vanuit de collectie zelf. Dat werkt ook als het
  // mappen-endpoint alleen "All" teruggeeft.
  const folderCounts = new Map();
  for (const r of collection) {
    if (r.folder) folderCounts.set(r.folder, (folderCounts.get(r.folder) ?? 0) + 1);
  }
  const idOfName = new Map([...folderNames].map(([id, name]) => [name, id]));
  const folders = [...folderCounts]
    .map(([name, count]) => ({ id: idOfName.get(name) ?? null, name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const uniqueWanted = new Set(wantlist.map((w) => w.master_id ?? `r${w.release_id}`)).size;

  // Samenvatting: zelfde sleutels als voorheen, plus twee nieuwe tellers.
  const summary = {
    generated_at: new Date().toISOString(),
    user: USER,
    collection_count: collectionCount ?? collection.length,
    wantlist_count: wantlist.length,
    wantlist_unique_masters: uniqueWanted,
    folders,
    recent_additions: collection.slice(0, 50).map(({ folder, genres, styles, catno, master_id, original_year, ...rest }) => rest),
    recent_wants: wantlist.slice(0, 50).map(({ genres, styles, catno, master_id, ...rest }) => rest),
    files: { collection: OUT_COLLECTION, wantlist: OUT_WANTLIST },
  };

  await write(OUT_MASTERS, JSON.stringify(masters, null, 0) + '\n');
  await write(OUT_COLLECTION, toLines(collection));
  await write(OUT_WANTLIST, toLines(wantlist));
  await write(OUT_SUMMARY, JSON.stringify(summary, null, 2) + '\n');

  console.log(
    `Klaar: ${collection.length} in collectie, ${wantlist.length} op wantlist ` +
      `(${uniqueWanted} unieke albums), ${folders.length} mappen.`
  );
}

main().catch((err) => {
  console.error('Mislukt:', err.message);
  process.exit(1);
});
