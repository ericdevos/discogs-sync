# discogs-sync

Haalt wekelijks de Discogs-collectie en wantlist op en publiceert een compacte
samenvatting als JSON, zodat andere tools die kunnen lezen zonder zelf een
Discogs-token nodig te hebben.

Draait volledig op GitHub Actions. Geen server, geen hosting.

## Eenmalig instellen

1. **Personal access token maken** op https://www.discogs.com/settings/developers
   → "Generate new token". Dit is één sleutel; OAuth is hier niet nodig omdat je
   alleen je eigen gegevens leest.

2. **Repository aanmaken.** Belangrijk: maak hem **publiek**. Een privérepository
   werkt ook voor de sync zelf, maar dan is `raw.githubusercontent.com` alleen met
   authenticatie te benaderen en kunnen externe tools het bestand niet lezen.
   De uitvoer bevat niets wat niet al op je Discogs-profiel staat — prijs en plaats
   van aankoop worden bewust weggelaten.

3. **Token als secret opslaan:**
   Settings → Secrets and variables → Actions → *Secrets* → New repository secret
   - Naam: `DISCOGS_TOKEN`
   - Waarde: je token

   Het token komt dus **niet** in de code terecht.

4. **Gebruikersnaam als variable opslaan:**
   Settings → Secrets and variables → Actions → *Variables* → New repository variable
   - Naam: `DISCOGS_USER`
   - Waarde: je Discogs-gebruikersnaam

5. **Testen:** Actions → "Discogs sync" → Run workflow. Na een halve minuut staat
   `data/discogs.json` in de repo.

## Waar het bestand daarna staat

```
https://raw.githubusercontent.com/<gebruiker>/<repo>/main/data/discogs.json
```

Die URL is direct op te halen door andere tools.

## Wat er in de JSON staat

```jsonc
{
  "generated_at": "2026-09-21T03:30:12.000Z",
  "user": "CanisLupusNL",
  "collection_count": 1043,
  "wantlist_count": 789,
  "folders": [{ "name": "Rock", "count": 268 }],
  "recent_additions": [
    {
      "artist": "Moderat",
      "title": "III",
      "year": 2016,
      "label": "Monkeytown Records",
      "format": "CD Album Deluxe Edition",
      "release_id": 8570013,
      "date_added": "2026-09-03"
    }
  ],
  "recent_wants": []
}
```

Vijftig recente toevoegingen aan collectie en wantlist. Dat is ruim genoeg voor een
weekoverzicht en houdt het bestand klein.

## Schema

Maandag 03:30 UTC. Aanpassen kan in `.github/workflows/discogs-sync.yml`; let op dat
cron daar altijd in UTC staat.

## Kosten

Geen. Private repositories zijn gratis en onbeperkt, en GitHub Actions geeft 2.000
gratis minuten per maand (onbeperkt voor publieke repos). Deze job draait ongeveer
twintig seconden per week.

## Als het misgaat

- **401 of 403** — token ontbreekt of is verlopen. Controleer de secret.
- **404** — gebruikersnaam klopt niet, of de collectie staat op privé.
- **429** — rate limit. Discogs staat 60 verzoeken per minuut toe voor
  geauthenticeerde aanvragen; dit script doet er drie, dus dit hoort niet voor te
  komen.
- **Geen commit** — er was niets veranderd sinds vorige week. Dat is normaal.
