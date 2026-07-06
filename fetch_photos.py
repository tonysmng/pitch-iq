#!/usr/bin/env python3
"""Fetch player headshots from Wikipedia page summaries (CC-licensed thumbs),
validate the article is about a footballer, resize with sips, emit photos.json
{playerId: dataURI}. Missing/failed players simply keep the initials avatar."""
import json, os, re, subprocess, base64, unicodedata, urllib.parse, time

BASE = os.path.dirname(os.path.abspath(__file__))
os.makedirs(f'{BASE}/photos', exist_ok=True)

def slug(name):
    s = unicodedata.normalize('NFKD', name).encode('ascii', 'ignore').decode()
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')

# player display name -> wiki title candidates (first match wins)
players = json.load(open(f'{BASE}/players_list.json'))

UA = 'PitchIQ-personal-app/1.0 (contact: tonysmng@gmail.com)'
FOOT = re.compile(r'footballer|soccer|goalkeeper|football player', re.I)

def summary(title):
    url = 'https://en.wikipedia.org/api/rest_v1/page/summary/' + urllib.parse.quote(title.replace(' ', '_'))
    for attempt in range(3):
        try:
            out = subprocess.run(['curl', '-sS', '-A', UA, '--max-time', '15', url], capture_output=True, text=True, timeout=20)
            j = json.loads(out.stdout)
            if j.get('type') == 'disambiguation':
                return None  # caller should try a more specific title
            return j if j.get('type') != 'https://mediawiki.org/wiki/HyperSwitch/errors/not_found' else None
        except Exception:
            time.sleep(0.6 * (attempt + 1))
    return None

def download(url, dest):
    for attempt in range(3):
        r = subprocess.run(['curl', '-sSL', '-A', UA, '--max-time', '25', '-o', dest, url], capture_output=True)
        if r.returncode == 0 and os.path.exists(dest) and os.path.getsize(dest) >= 500:
            return True
        time.sleep(0.6 * (attempt + 1))
    return False

photos, misses = {}, []
for p in players:
    name, pid = p['name'], p['id']
    explicit = p.get('wiki', [])
    cands = [(t, True) for t in explicit] + [(name, False), (name + ' (footballer)', True), (name + ' (soccer)', True)]
    got = None
    for t, trusted in cands:
        j = summary(t)
        if not j: continue
        desc = (j.get('description') or '') + ' ' + (j.get('extract') or '')[:220]
        # trust curated / disambiguated titles; only gate bare-name lookups on the footballer check
        if not trusted and not FOOT.search(desc): continue
        src = (j.get('thumbnail') or {}).get('source') or (j.get('originalimage') or {}).get('source')
        if not src: continue
        got = src
        break
    if not got:
        misses.append(name); continue
    raw = f'{BASE}/photos/{pid}.raw'
    jpg = f'{BASE}/photos/{pid}.jpg'
    if not download(got, raw):
        misses.append(name); continue
    # square-ish crop weighted to the top (face), then downscale to 260px for a crisp hero band
    s = subprocess.run(['sips', '-Z', '260', '-s', 'format', 'jpeg', '-s', 'formatOptions', '62', raw, '--out', jpg], capture_output=True)
    if s.returncode != 0 or not os.path.exists(jpg):
        misses.append(name); continue
    b64 = base64.b64encode(open(jpg, 'rb').read()).decode()
    photos[pid] = 'data:image/jpeg;base64,' + b64
    time.sleep(0.25)  # be polite to the Wikipedia API

json.dump(photos, open(f'{BASE}/photos.json', 'w'))
total = sum(len(v) for v in photos.values())
print(f'photos: {len(photos)}/{len(players)}, embedded size ~{total//1024} KB')
print('missing:', ', '.join(misses) if misses else 'none')
