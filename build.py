#!/usr/bin/env python3
"""Assemble pitch-iq.html from parts: fonts css + land path + data.js + app.js + style.css"""
import os
BASE = os.path.dirname(os.path.abspath(__file__))

fonts = open(f'{BASE}/fonts/fonts-embedded.css').read()
land = open(f'{BASE}/geo/landpath.txt').read().strip()
css = open(f'{BASE}/src/style.css').read()
data = open(f'{BASE}/src/data.js').read()
app = open(f'{BASE}/src/app.js').read()

assert 'LANDPATH' in data or 'LANDPATH' in app, 'land placeholder missing'
data = data.replace('"__LANDPATH__"', repr(land).replace("'", '"'))

html = f'''<meta charset="utf-8">
<title>Pitch IQ · World Cup 2026</title>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>
{fonts}
{css}
</style>
<div id="app"></div>
<div id="toast-slot"></div>
<script>
{data}
{app}
</script>
'''
out = f'{BASE}/pitch-iq.html'
open(out, 'w').write(html)
print(f'built {out}: {os.path.getsize(out)/1024:.0f} KB')
